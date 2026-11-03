import path from "path";
import fs from "fs";
import type { DatabaseInstance } from "../database.js";
import type { ExtractionResult } from "./parsers/extractor.js";
import { graphMemory } from "./graph_memory.js";

/**
 * Store one file's extraction, replacing whatever an earlier index of the same file produced:
 * the old raw source, nodes that no longer exist in the file, and the edges the extractor wrote for it.
 * Edges added by hand (source_file IS NULL) are never touched.
 *
 * Uses a SAVEPOINT so it can run standalone or inside a batched outer transaction.
 * If `deferCache` is provided, memory cache updates are queued into `deferCache` instead of
 * applied immediately, so an outer transaction can apply them only after its own COMMIT.
 */
export function persistExtraction(
  db: DatabaseInstance,
  projectId: string,
  filePath: string,
  result: ExtractionResult,
  deferCache?: Array<() => void>
): void {
  // Ids come from file path + symbol, so two projects can produce the same id (src/utils.ts in an app and in a
  // library). A node another project owns must never be overwritten: this project gets its own "@project" copy.
  const rename = new Map<string, string>();
  for (const n of result.nodes) {
    const existingOwner = graphMemory.getNode(n.id)?.project_id;
    if (existingOwner && existingOwner !== projectId) {
      rename.set(n.id, `${n.id}@${projectId}`);
    }
  }
  if (rename.size) {
    const re = (id: string) => rename.get(id) ?? id;
    result = {
      ...result,
      nodes: result.nodes.map((n) => ({ ...n, id: re(n.id) })),
      edges: result.edges.map((e) => ({ ...e, source_id: re(e.source_id), target_id: re(e.target_id) })),
    };
  }
  const oldSourceIds = (db
    .prepare(`SELECT id FROM raw_sources WHERE project_id = ? AND file_path = ?`)
    .all(projectId, filePath) as { id: number }[]).map((r) => r.id);
  const inOld = oldSourceIds.map(() => "?").join(",");
  const oldNodeIds = oldSourceIds.length
    ? (db.prepare(`SELECT DISTINCT node_id FROM node_sources WHERE source_id IN (${inOld})`).all(...oldSourceIds) as { node_id: string }[]).map((r) => r.node_id)
    : [];
  const staleEdges = db
    .prepare(`SELECT source_id, target_id, relation_type FROM graph_edges WHERE source_file = ?`)
    .all(filePath) as { source_id: string; target_id: string; relation_type: string }[];

  db.exec("SAVEPOINT sp_persist_file");
  try {
    db.prepare(`DELETE FROM graph_edges WHERE source_file = ?`).run(filePath);

    const raw = db
      .prepare(`INSERT INTO raw_sources (project_id, title, source_type, file_path, file_hash, content) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(projectId, path.basename(filePath), path.extname(filePath).slice(1), filePath, result.fileHash, result.rawContent);
    const sourceId = Number(raw.lastInsertRowid);

    const upsertNode = db.prepare(`
      INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, properties, is_hub)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, node_type = excluded.node_type, summary = excluded.summary,
        domain = excluded.domain, properties = excluded.properties, is_hub = excluded.is_hub, updated_at = CURRENT_TIMESTAMP`);
    const placeholderNode = db.prepare(`
      INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, properties, is_hub)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
    const link = db.prepare(`INSERT OR IGNORE INTO node_sources (node_id, source_id, page_number, section_title) VALUES (?, ?, ?, ?)`);

    const newNodeIds = new Set<string>();
    for (const n of result.nodes) {
      newNodeIds.add(n.id);
      const stmt = n.properties?.placeholder ? placeholderNode : upsertNode;
      stmt.run(n.id, n.project_id, n.label, n.node_type, n.summary, n.domain, JSON.stringify(n.properties || {}), n.is_hub ? 1 : 0);
      if (n.provenance) link.run(n.id, sourceId, n.provenance.page ?? null, n.provenance.section ?? null);
    }

    const upsertEdge = db.prepare(`
      INSERT INTO graph_edges (project_id, source_id, target_id, relation_type, description, weight, source_file)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET description = excluded.description,
        weight = excluded.weight, source_file = excluded.source_file`);
    for (const e of result.edges) {
      upsertEdge.run(e.project_id, e.source_id, e.target_id, e.relation_type, e.description ?? null, e.weight || 1.0, filePath);
    }

    // Resolve cross-file symbol CALLS edges (both outbound to imported files and inbound from importer files)
    const extraEdges: Array<{ project_id: string; source_id: string; target_id: string; relation_type: any; description: string; weight: number }> = [];
    const nodeExists = (id: string) => newNodeIds.has(id) || Boolean(graphMemory.getNode(id));

    const importedFiles = new Set<string>(
      result.nodes
        .filter((n) => n.properties?.placeholder && typeof n.properties?.file_path === "string")
        .map((n) => n.properties.file_path as string)
    );
    if (importedFiles.size > 0) {
      const importedSymbolByName = new Map<string, string>();
      for (const impFile of importedFiles) {
        for (const sym of graphMemory.getNodesByFile(impFile, projectId)) {
          if (sym.node_type !== "module" && !sym.properties?.placeholder) {
            importedSymbolByName.set(sym.label, sym.id);
          }
        }
      }
      if (importedSymbolByName.size > 0) {
        for (const n of result.nodes) {
          const calls = n.properties?.calls as string[] | undefined;
          if (!Array.isArray(calls) || n.node_type === "module") continue;
          for (const callee of calls) {
            const targetId = importedSymbolByName.get(callee);
            if (targetId && targetId !== n.id && nodeExists(targetId)) {
              upsertEdge.run(projectId, n.id, targetId, "CALLS", `Calls ${callee}`, 1.0, filePath);
              extraEdges.push({ project_id: projectId, source_id: n.id, target_id: targetId, relation_type: "CALLS", description: `Calls ${callee}`, weight: 1.0 });
            }
          }
        }
      }
    }

    const fileModuleNode = result.nodes.find((n) => n.node_type === "module" && !n.properties?.placeholder && !n.properties?.is_external);
    if (fileModuleNode) {
      const newSymbolByName = new Map<string, string>();
      for (const n of result.nodes) {
        if (n.node_type !== "module" && !n.properties?.placeholder && !n.properties?.is_external) {
          newSymbolByName.set(n.label, n.id);
        }
      }
      if (newSymbolByName.size > 0) {
        const importerFiles = graphMemory.getImporterFiles(fileModuleNode.id);
        if (importerFiles && importerFiles.size > 0) {
          for (const callerFile of importerFiles) {
            if (callerFile === filePath) continue;
            for (const callerSym of graphMemory.getNodesByFile(callerFile, projectId)) {
              const calls = callerSym.properties?.calls as string[] | undefined;
              if (!Array.isArray(calls) || callerSym.node_type === "module") continue;
              if (!nodeExists(callerSym.id)) continue;
              for (const callee of calls) {
                const targetId = newSymbolByName.get(callee);
                if (targetId && targetId !== callerSym.id) {
                  upsertEdge.run(projectId, callerSym.id, targetId, "CALLS", `Calls ${callee}`, 1.0, callerFile);
                  extraEdges.push({ project_id: projectId, source_id: callerSym.id, target_id: targetId, relation_type: "CALLS", description: `Calls ${callee}`, weight: 1.0 });
                }
              }
            }
          }
        }
      }
    }

    // Drop the old source first (cascades its node_sources) so "still sourced" only counts other files
    if (oldSourceIds.length) db.prepare(`DELETE FROM raw_sources WHERE id IN (${inOld})`).run(...oldSourceIds);

    const keep = new Set(result.nodes.map((n) => n.id));
    const orphans = oldNodeIds.filter((id) => !keep.has(id));
    const stillSourced = db.prepare(`SELECT 1 FROM node_sources WHERE node_id = ?`);
    const removed: string[] = [];
    for (const id of orphans) {
      if (stillSourced.get(id)) continue; // another file still defines it
      db.prepare(`DELETE FROM graph_nodes WHERE id = ?`).run(id);
      removed.push(id);
    }
    db.exec("RELEASE SAVEPOINT sp_persist_file");

    const applyCache = () => {
      for (const e of staleEdges) graphMemory.removeEdge(e);
      for (const id of removed) graphMemory.removeNode(id);
      for (const n of result.nodes) {
        if (n.properties?.placeholder && graphMemory.getNode(n.id)) continue;
        graphMemory.addNodeMemory(n);
      }
      for (const e of result.edges) graphMemory.addEdgeMemory(e);
      for (const e of extraEdges) graphMemory.addEdgeMemory(e);
    };

    if (deferCache) {
      deferCache.push(applyCache);
    } else {
      // Cache follows the DB only after the commit succeeded
      applyCache();
    }
  } catch (err) {
    db.exec("ROLLBACK TO SAVEPOINT sp_persist_file");
    db.exec("RELEASE SAVEPOINT sp_persist_file");
    throw err;
  }
}

/** Forget a file that no longer exists: its raw source, nodes nothing else defines, and the edges it wrote. */
export function removeFile(db: DatabaseInstance, projectId: string, filePath: string): number {
  const ids = (db.prepare(`SELECT id FROM raw_sources WHERE project_id = ? AND file_path = ?`).all(projectId, filePath) as { id: number }[]).map((r) => r.id);
  if (!ids.length) return 0;
  const inIds = ids.map(() => "?").join(",");
  const nodeIds = (db.prepare(`SELECT DISTINCT node_id FROM node_sources WHERE source_id IN (${inIds})`).all(...ids) as { node_id: string }[]).map((r) => r.node_id);
  const staleEdges = db.prepare(`SELECT source_id, target_id, relation_type FROM graph_edges WHERE source_file = ?`).all(filePath) as { source_id: string; target_id: string; relation_type: string }[];
  const removed: string[] = [];
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM graph_edges WHERE source_file = ?`).run(filePath);
    db.prepare(`DELETE FROM raw_sources WHERE id IN (${inIds})`).run(...ids);
    const stillSourced = db.prepare(`SELECT 1 FROM node_sources WHERE node_id = ?`);
    for (const id of nodeIds) {
      if (stillSourced.get(id)) continue;
      db.prepare(`DELETE FROM graph_nodes WHERE id = ?`).run(id);
      removed.push(id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  for (const e of staleEdges) graphMemory.removeEdge(e);
  for (const id of removed) graphMemory.removeNode(id);
  return removed.length;
}

/** Completely remove a project/library and all its associated nodes, edges, raw sources, and memory cache. */
export function removeProject(
  db: DatabaseInstance,
  projectId: string
): { nodes: number; edges: number; sources: number } {
  const nodes = db.prepare(`SELECT id FROM graph_nodes WHERE project_id = ?`).all(projectId) as { id: string }[];
  const edges = db
    .prepare(`SELECT source_id, target_id, relation_type FROM graph_edges WHERE project_id = ?`)
    .all(projectId) as { source_id: string; target_id: string; relation_type: string }[];
  const sources = db.prepare(`SELECT count(*) as count FROM raw_sources WHERE project_id = ?`).get(projectId) as {
    count: number;
  };

  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM graph_edges WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM raw_sources WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM graph_nodes WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM project_links WHERE project_id = ? OR linked_id = ?`).run(projectId, projectId);
    db.prepare(`DELETE FROM knowledge_gaps WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM ingest_jobs WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  for (const e of edges) graphMemory.removeEdge(e);
  for (const n of nodes) graphMemory.removeNode(n.id);

  return { nodes: nodes.length, edges: edges.length, sources: sources?.count || 0 };
}

export interface PruneResult {
  prunedLibraries: Array<{ id: string; name: string; reason: string; nodes: number; edges: number }>;
  reclaimedNodes: number;
  reclaimedEdges: number;
  vacuumExecuted: boolean;
}

/**
 * Scan for orphaned or stale library projects (domain='library' or id like 'lib-%')
 * and prune them to keep storage compact.
 */
export function pruneLibraries(
  db: DatabaseInstance,
  options: { dryRun?: boolean; vacuum?: boolean } = {}
): PruneResult {
  const { dryRun = false, vacuum = true } = options;

  // 1. Find all candidate libraries
  const libProjects = db
    .prepare(
      `SELECT id, name, description, domain, updated_at FROM projects WHERE domain = 'library' OR id LIKE 'lib-%'`
    )
    .all() as { id: string; name: string; description: string; domain: string; updated_at: string }[];

  // 2. Find currently active links
  const activeLinkedIds = new Set(
    (db.prepare(`SELECT DISTINCT linked_id FROM project_links`).all() as { linked_id: string }[]).map(
      (r) => r.linked_id
    )
  );

  const candidates: Array<{ id: string; name: string; reason: string }> = [];

  for (const lib of libProjects) {
    // Check if orphaned (no other project links to it)
    if (!activeLinkedIds.has(lib.id)) {
      candidates.push({ id: lib.id, name: lib.name, reason: "Orphaned library (no active project references it)" });
      continue;
    }

    // Check if source files still exist on disk
    const sample = db
      .prepare(`SELECT file_path FROM raw_sources WHERE project_id = ? LIMIT 1`)
      .get(lib.id) as { file_path: string } | undefined;
    if (sample?.file_path) {
      const sourceDir = path.dirname(sample.file_path);
      if (!fs.existsSync(sourceDir)) {
        candidates.push({
          id: lib.id,
          name: lib.name,
          reason: `Source directory no longer exists on disk: ${sourceDir}`,
        });
      }
    }
  }

  const result: PruneResult = {
    prunedLibraries: [],
    reclaimedNodes: 0,
    reclaimedEdges: 0,
    vacuumExecuted: false,
  };

  for (const c of candidates) {
    const nodeCount =
      (db.prepare(`SELECT count(*) as cnt FROM graph_nodes WHERE project_id = ?`).get(c.id) as any)?.cnt || 0;
    const edgeCount =
      (db.prepare(`SELECT count(*) as cnt FROM graph_edges WHERE project_id = ?`).get(c.id) as any)?.cnt || 0;

    if (!dryRun) {
      const removed = removeProject(db, c.id);
      result.reclaimedNodes += removed.nodes;
      result.reclaimedEdges += removed.edges;
    } else {
      result.reclaimedNodes += nodeCount;
      result.reclaimedEdges += edgeCount;
    }

    result.prunedLibraries.push({
      id: c.id,
      name: c.name,
      reason: c.reason,
      nodes: nodeCount,
      edges: edgeCount,
    });
  }

  if (!dryRun && vacuum && candidates.length > 0) {
    try {
      db.exec("VACUUM;");
      result.vacuumExecuted = true;
    } catch {
      result.vacuumExecuted = false;
    }
  }

  return result;
}
