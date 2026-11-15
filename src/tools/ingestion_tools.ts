import fs from "fs";
import path from "path";
import { DatabaseInstance } from "../database.js";
import { graphMemory } from "../engine/graph_memory.js";
import { knowledgeExtractor } from "../engine/parsers/extractor.js";
import { documentParser } from "../engine/parsers/doc_parser.js";
import { classifyDocument } from "../engine/parsers/classifier.js";
import { telemetry } from "../engine/telemetry.js";
import { jobs } from "../engine/jobs.js";
import { persistExtraction, pruneLibraries, removeFile } from "../engine/persist.js";
import { depHint, findDep, listDeps, refreshLinks } from "../engine/deps.js";
import { loadIgnore } from "../engine/ignore.js";
import {
  AddNodeSchema,
  AddRelationSchema,
  AuditGapsSchema,
  BatchIngestSchema,
  FlagGapSchema,
  GraphNode,
  GraphEdge,
  IngestFileSchema,
  PruneLibrariesSchema,
  ResolveLibrarySchema,
  SyncSchema,
} from "../types.js";

function syncProjectLexicon(db: DatabaseInstance, projectId: string, dirPath: string) {
  const candidates = [
    path.join(dirPath, ".kb", "lexicon.json"),
    path.join(dirPath, ".kblexicon.json"),
    path.join(dirPath, "lexicon.json"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (typeof raw === "object" && raw !== null) {
          const stmt = db.prepare(`
            INSERT INTO project_lexicon (project_id, term, synonyms)
            VALUES (?, ?, ?)
            ON CONFLICT(project_id, term) DO UPDATE SET synonyms = excluded.synonyms
          `);
          for (const [term, syn] of Object.entries(raw)) {
            if (term && typeof syn === "string") {
              stmt.run(projectId, term.toLowerCase().trim(), syn.toLowerCase().trim());
            }
          }
        }
      } catch {
        // ignore malformed custom json
      }
      break;
    }
  }
}

export async function handleIngestionTool(
  name: string,
  args: any,
  db: DatabaseInstance
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const startTime = process.hrtime.bigint();

  const insertNodeStmt = db.prepare(`
    INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, properties, is_hub)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label = excluded.label,
      summary = excluded.summary,
      domain = excluded.domain,
      properties = excluded.properties,
      is_hub = excluded.is_hub,
      updated_at = CURRENT_TIMESTAMP
  `);

  const insertEdgeStmt = db.prepare(`
    INSERT INTO graph_edges (project_id, source_id, target_id, relation_type, description, weight)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET
      description = excluded.description,
      weight = excluded.weight
  `);

  const insertGapStmt = db.prepare(`
    INSERT INTO knowledge_gaps (project_id, missing_item, reason, suggested_action, status)
    VALUES (?, ?, ?, ?, 'open')
  `);

  const checkFileHashStmt = db.prepare(`
    SELECT id, file_hash FROM raw_sources WHERE project_id = ? AND file_path = ? ORDER BY id DESC LIMIT 1
  `);

  if (name === "kb_classify_document") {
    const { file_path, text, file_name } = args as { file_path?: string; text?: string; file_name?: string };
    let body = text;
    let fname = file_name || "untitled.md";
    if (file_path) {
      if (!fs.existsSync(file_path)) {
        return { content: [{ type: "text", text: `File not found: ${file_path}` }], isError: true };
      }
      body = (await documentParser.parseFile(file_path).catch(() => null))?.rawText ?? fs.readFileSync(file_path, "utf-8");
      fname = path.basename(file_path);
    }
    if (!body) {
      return { content: [{ type: "text", text: "Provide file_path or text." }], isError: true };
    }
    const c = classifyDocument(body, fname, path.extname(fname));
    return {
      content: [{
        type: "text",
        text: `### Classification: \`${fname}\`\n- **Domain:** ${c.domain}\n- **Type:** ${c.docType}\n- **Confidence:** ${c.confidence}\n- **Signals:** ${c.matched.join(", ") || "none"}`,
      }],
    };
  }

  if (name === "kb_ingest_file") {
    const { project_id, file_path, domain } = IngestFileSchema.parse(args);

    if (!fs.existsSync(file_path)) {
      return {
        content: [{ type: "text", text: `File not found: ${file_path}` }],
        isError: true,
      };
    }

    const jobId = jobs.start(db, project_id, path.basename(file_path), 1);
    const tExtractStart = process.hrtime.bigint();
    let result;
    try {
      const preloaded = knowledgeExtractor.readAndHashFile(file_path);
      const existing = checkFileHashStmt.get(project_id, file_path) as any;
      if (preloaded && existing && existing.file_hash === preloaded.fileHash) {
        jobs.progress(db, jobId, { processed: 0, skipped: 1, failed: 0 });
        jobs.finish(db, jobId);
        return {
          content: [
            {
              type: "text",
              text: `Skipped ${path.basename(file_path)}: content unchanged (SHA-256 match).`,
            },
          ],
        };
      }
      result = await knowledgeExtractor.extractFromFile(project_id, file_path, domain, preloaded);
      if (!preloaded && existing && existing.file_hash === result.fileHash) {
        jobs.progress(db, jobId, { processed: 0, skipped: 1, failed: 0 });
        jobs.finish(db, jobId);
        return {
          content: [
            {
              type: "text",
              text: `Skipped ${path.basename(file_path)}: content unchanged (SHA-256 match).`,
            },
          ],
        };
      }
    } catch (err: any) {
      jobs.finish(db, jobId, err?.message || String(err));
      throw err;
    }
    const extractDuration = Number(process.hrtime.bigint() - tExtractStart) / 1_000_000;

    persistExtraction(db, project_id, file_path, result);

    jobs.progress(db, jobId, { processed: 1, skipped: 0, failed: 0 });
    jobs.finish(db, jobId);
    const summary = `Ingested \`${path.basename(file_path)}\`: Created **${result.nodes.length} nodes** and **${result.edges.length} edges** in domain \`${result.nodes[0]?.domain ?? domain}\`.`;
    const { footer } = telemetry.record(
      name,
      startTime,
      null,
      extractDuration,
      summary,
      summary // see batch ingest: writes are never "savings"
    );

    return {
      content: [{ type: "text", text: summary + footer }],
    };
  }

  if (name === "kb_sync") {
    const parsedSync = SyncSchema.parse(args);
    const { dir_path, ignore, force } = parsedSync;
    const project_id = graphMemory.resolveProjectId(parsedSync.project_id) || parsedSync.project_id;
    const files = (db.prepare(`SELECT file_path, file_hash FROM raw_sources WHERE project_id = ? AND file_path IS NOT NULL`).all(project_id) as { file_path: string; file_hash: string }[]);
    let updated = 0, removed = 0, unchanged = 0, failed = 0;
    const ignoredNow = dir_path ? loadIgnore(dir_path, ignore) : () => false;
    let inSyncTx = false;
    let syncTxCount = 0;
    const openSyncTx = () => {
      if (!inSyncTx) {
        db.exec("BEGIN");
        inSyncTx = true;
        syncTxCount = 0;
      }
    };
    const commitSyncTx = () => {
      if (inSyncTx) {
        db.exec("COMMIT");
        inSyncTx = false;
        syncTxCount = 0;
      }
    };
    try {
      for (const f of files) {
        try {
          if (!fs.existsSync(f.file_path) || (dir_path && f.file_path.startsWith(dir_path + path.sep) && ignoredNow(f.file_path))) {
            commitSyncTx();
            removeFile(db, project_id, f.file_path);
            removed++;
            continue;
          }
          const preloaded = !force ? knowledgeExtractor.readAndHashFile(f.file_path) : null;
          if (!force && preloaded && preloaded.fileHash === f.file_hash) {
            unchanged++;
            continue;
          }
          const result = await knowledgeExtractor.extractFromFile(project_id, f.file_path, "auto", preloaded);
          if (!force && !preloaded && result.fileHash === f.file_hash) {
            unchanged++;
            continue;
          }
          openSyncTx();
          persistExtraction(db, project_id, f.file_path, result);
          updated++;
          syncTxCount++;
          if (syncTxCount >= 50) commitSyncTx();
        } catch {
          failed++;
        }
      }
      commitSyncTx();
    } catch (err) {
      if (inSyncTx) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        graphMemory.hydrate(db);
      }
      throw err;
    }
    refreshLinks(db);
    const lines = [`Sync ${project_id}: ${updated} updated, ${removed} removed, ${unchanged} unchanged${failed ? `, ${failed} failed` : ""}`];
    if (dir_path) {
      syncProjectLexicon(db, project_id, dir_path);
      const r = await handleIngestionTool("kb_batch_ingest_directory", { project_id, dir_path, ignore, force }, db);
      lines.push(r?.content[0].text.split("\n").filter((l) => /Ingested|Failed/.test(l)).join(" ") ?? "");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "kb_batch_ingest_directory") {
    const { project_id, dir_path, extensions, force, ignore } = BatchIngestSchema.parse(args);

    if (!fs.existsSync(dir_path)) {
      return {
        content: [{ type: "text", text: `Directory not found: ${dir_path}` }],
        isError: true,
      };
    }

    syncProjectLexicon(db, project_id, dir_path);

    const validExts = new Set(
      (extensions || [".pdf", ".docx", ".md", ".txt", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".dart", ".kt", ".kts", ".swift", ".json", ".sql", ".yaml", ".yml"]).map((e) =>
        e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`
      )
    );
    // Generated code, build output and whatever the user lists in .kbignore (or passes as `ignore`) is noise to an agent
    const ignored = loadIgnore(dir_path, ignore);
    const MAX_BYTES = 1_000_000;

    const filesToIngest: string[] = [];
    const scanDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignored(fullPath + "/x")) scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (validExts.has(ext) && !ignored(fullPath) && fs.statSync(fullPath).size <= MAX_BYTES) {
            filesToIngest.push(fullPath);
          }
        }
      }
    };

    scanDir(dir_path);

    const jobId = jobs.start(db, project_id, path.basename(dir_path), filesToIngest.length);
    let processed = 0;
    let skipped = 0;
    let failed = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    const existingMap = new Map<string, string>();
    if (!force) {
      const rows = db
        .prepare(`SELECT file_path, file_hash FROM raw_sources WHERE project_id = ? AND file_path IS NOT NULL`)
        .all(project_id) as Array<{ file_path: string; file_hash: string }>;
      for (const r of rows) {
        existingMap.set(r.file_path, r.file_hash);
      }
    }

    const BATCH_TX_SIZE = 50;
    let inTx = false;
    let txWriteCount = 0;

    const openTxIfNeeded = () => {
      if (!inTx) {
        db.exec("BEGIN");
        inTx = true;
        txWriteCount = 0;
      }
    };
    const commitTxIfNeeded = () => {
      if (inTx) {
        db.exec("COMMIT");
        inTx = false;
        txWriteCount = 0;
      }
    };

    try {
      for (let i = 0; i < filesToIngest.length; i++) {
        const filePath = filesToIngest[i];
        if (!inTx) {
          if (jobs.isCancelled(db, jobId)) break;
        }
        try {
          const existingHash = !force ? existingMap.get(filePath) : undefined;
          const preloaded = existingHash ? knowledgeExtractor.readAndHashFile(filePath) : null;
          if (!force && existingHash && preloaded && existingHash === preloaded.fileHash) {
            skipped++;
            continue;
          }

          const result = await knowledgeExtractor.extractFromFile(project_id, filePath, "auto", preloaded);
          if (!force && existingHash && !preloaded && existingHash === result.fileHash) {
            skipped++;
            continue;
          }

          openTxIfNeeded();
          persistExtraction(db, project_id, filePath, result);

          processed++;
          txWriteCount++;
          totalNodes += result.nodes.length;
          totalEdges += result.edges.length;

          // Flush the very first file immediately so external job pollers observe running progress right away,
          // then group subsequent writes into batches of BATCH_TX_SIZE.
          if (processed === 1 || txWriteCount >= BATCH_TX_SIZE) {
            commitTxIfNeeded();
            jobs.progress(db, jobId, { processed, skipped, failed, current: path.basename(filePath) });
            await new Promise<void>((r) => setTimeout(r, processed === 1 ? 8 : 1));
            if (jobs.isCancelled(db, jobId)) break;
          }
        } catch {
          failed++;
        }
      }
      commitTxIfNeeded();
    } catch (err) {
      if (inTx) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // ignore rollback error
        }
        graphMemory.hydrate(db);
      }
      throw err;
    }
    jobs.progress(db, jobId, { processed, skipped, failed });
    jobs.finish(db, jobId);

    if (processed) refreshLinks(db);
    const summary = `Batch Ingestion completed for \`${dir_path}\`:\n- Scanned: ${filesToIngest.length} files\n- Ingested: ${processed} files\n- Skipped (unchanged): ${skipped} files\n- Failed: ${failed} files\n- Total Nodes created: ${totalNodes}\n- Total Edges created: ${totalEdges}${processed ? depHint(db, project_id) : ""}`;
    const { footer } = telemetry.record(
      name,
      startTime,
      null,
      null,
      summary,
      summary // ingesting is a write, not a read an agent avoids: it must not count as saved tokens
    );

    return {
      content: [{ type: "text", text: summary + footer }],
    };
  }

  if (name === "kb_add_node") {
    const { project_id, id, label, node_type, summary, domain, links_to } =
      AddNodeSchema.parse(args);

    const node: GraphNode = {
      id,
      project_id,
      label,
      node_type: node_type as any,
      summary,
      domain,
      properties: {},
      is_hub: false,
    };

    insertNodeStmt.run(
      node.id,
      node.project_id,
      node.label,
      node.node_type,
      node.summary,
      node.domain,
      JSON.stringify(node.properties),
      0
    );
    graphMemory.addNodeMemory(node);

    if (links_to) {
      for (const link of links_to) {
        const edge: GraphEdge = {
          project_id,
          source_id: id,
          target_id: link.target_id,
          relation_type: link.relation as any,
          description: link.description || undefined,
          weight: 1.0,
        };
        insertEdgeStmt.run(
          edge.project_id,
          edge.source_id,
          edge.target_id,
          edge.relation_type,
          edge.description || null,
          1.0
        );
        graphMemory.addEdgeMemory(edge);
      }
    }

    const outText = `Successfully added node \`${id}\` (${label}) to project \`${project_id}\`.`;
    const { footer } = telemetry.record(name, startTime, null, null, outText, outText);
    return {
      content: [{ type: "text", text: outText + footer }],
    };
  }

  if (name === "kb_add_relation") {
    const { project_id, source_id, target_id, relation_type, description } =
      AddRelationSchema.parse(args);

    insertEdgeStmt.run(
      project_id,
      source_id,
      target_id,
      relation_type,
      description || null,
      1.0
    );

    const edge: GraphEdge = {
      project_id,
      source_id,
      target_id,
      relation_type: relation_type as any,
      description,
      weight: 1.0,
    };
    graphMemory.addEdgeMemory(edge);

    const outText = `Added relationship: \`${source_id}\` --[${relation_type}]--> \`${target_id}\``;
    const { footer } = telemetry.record(name, startTime, null, null, outText, outText);
    return {
      content: [{ type: "text", text: outText + footer }],
    };
  }

  if (name === "kb_flag_gap") {
    const { project_id, missing_item, reason, suggested_action } = FlagGapSchema.parse(args);

    insertGapStmt.run(project_id, missing_item, reason, suggested_action || null);

    const outText = `Flagged knowledge gap: \`${missing_item}\` in project \`${project_id}\`.\nReason: ${reason}`;
    const { footer } = telemetry.record(name, startTime, null, null, outText, outText);
    return {
      content: [{ type: "text", text: outText + footer }],
    };
  }

  if (name === "kb_audit_gaps") {
    const { project_id } = AuditGapsSchema.parse(args);

    const openGaps = db
      .prepare(`SELECT * FROM knowledge_gaps WHERE project_id = ? AND status = 'open'`)
      .all(project_id) as any[];

    const projectEdges = graphMemory.getProjectEdges(project_id);
    const danglingEdges: GraphEdge[] = [];
    for (const edge of projectEdges) {
      if (!graphMemory.getNode(edge.target_id) || !graphMemory.getNode(edge.source_id)) {
        danglingEdges.push(edge);
      }
    }

    const lines: string[] = [
      `### Knowledge Gaps & Integrity Audit for [${project_id}]`,
      `Found **${openGaps.length} recorded gaps** and **${danglingEdges.length} dangling references**.`,
      "",
    ];

    if (openGaps.length > 0) {
      lines.push("**Flagged Knowledge Gaps (Pending):**");
      for (const gap of openGaps) {
        lines.push(`- ⚠️ \`${gap.missing_item}\`: ${gap.reason}`);
        if (gap.suggested_action) {
          lines.push(`  *Action required:* ${gap.suggested_action}`);
        }
      }
      lines.push("");
    }

    if (danglingEdges.length > 0) {
      lines.push("**Dangling References (Target entity not yet ingested):**");
      for (const de of danglingEdges.slice(0, 10)) {
        lines.push(`- \`${de.source_id}\` references \`${de.target_id}\` (${de.relation_type}) but \`${de.target_id}\` is missing.`);
      }
    }

    if (openGaps.length === 0 && danglingEdges.length === 0) {
      lines.push("✅ No knowledge gaps detected! The project topology is fully integrated and consistent.");
    }

    const rendered = lines.join("\n");
    const { footer } = telemetry.record(name, startTime, null, null, rendered, rendered);
    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_resolve_library") {
    const { project_id, library_name, auto_ingest } = ResolveLibrarySchema.parse(args);

    const dep = findDep(db, project_id, library_name);
    if (!dep || !dep.source) {
      const all = listDeps(db, project_id).map((d) => d.name).slice(0, 10);
      return {
        content: [{
          type: "text",
          text: `### ❌ Could Not Locate Library: \`${library_name}\`\n` +
            `- The package is not found in the local cache (\`.pub-cache\` or \`node_modules\`).\n` +
            `- **Known project imports:** ${all.join(", ") || "none"}\n\n` +
            `**Suggested Action:**\n` +
            `Ensure dependencies are installed by running \`flutter pub get\` or \`npm install\` in the workspace, then re-try.`,
        }],
        isError: true,
      };
    }

    const versionSlug = dep.version ? `-${dep.version.replace(/[^a-zA-Z0-9_.-]/g, "_")}` : "";
    const targetProjectId = dep.indexedAs || `lib-${dep.name.replace(/[^a-zA-Z0-9_-]/g, "_")}${versionSlug}`;
    const isAlreadyIndexed = !!dep.indexedAs;

    // Redirection info when auto_ingest = false
    if (!auto_ingest) {
      const lines = [
        `### 📦 3rd-Party Library Located: \`${dep.name}\``,
        `- **Source Path:** \`${dep.source}\``,
        `- **Version:** \`${dep.version || "detected in cache"}\``,
        `- **Indexed Status:** ${isAlreadyIndexed ? `✅ Indexed as \`${targetProjectId}\`` : "⚠️ Not indexed in Knowledge Base"}`,
        "",
        "**Redirection & Next Actions:**",
        `1. **Auto-Index (Recommended for semantic graph & token savings):**`,
        `   Call \`kb_resolve_library(project_id: "${project_id}", library_name: "${dep.name}", auto_ingest: true)\``,
        `2. **Direct Inspection without indexing:**`,
        `   - Use \`kb_file_outline(file_path: "${dep.source}/${dep.name}.dart")\``,
        `   - Or use Flutter MCP: \`read_package_uris(uris: ["package:${dep.name}/${dep.name}.dart"])\``,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // Auto-ingest requested:
    // If already indexed, ensure link exists
    if (isAlreadyIndexed) {
      db.prepare(`INSERT OR IGNORE INTO project_links (project_id, linked_id) VALUES (?, ?)`).run(project_id, targetProjectId);
      refreshLinks(db);
      const nodeCount = graphMemory.getProjectNodes(targetProjectId).length;
      return {
        content: [{
          type: "text",
          text: `### ✅ Library \`${dep.name}\` Already Indexed as \`${targetProjectId}\`\n` +
            `- **Source:** \`${dep.source}\`\n` +
            `- **Version:** \`${dep.version || "n/a"}\`\n` +
            `- **Nodes Available:** ${nodeCount}\n` +
            `- **Link Status:** Linked to \`${project_id}\`! Joint search is active.\n\n` +
            `You can now run \`kb_search("<query>", project_id="${project_id}")\` to query both your app and this library.`,
        }],
      };
    }

    // Not yet indexed: create project & batch ingest
    const insertProject = db.prepare(`
      INSERT INTO projects (id, name, description, domain)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        domain = excluded.domain,
        updated_at = CURRENT_TIMESTAMP
    `);
    const displayName = `${dep.name} ${dep.version || ""} (library)`.trim();
    const desc = `Source code for ${dep.name} package, indexed as a library for ${project_id}`;
    insertProject.run(targetProjectId, displayName, desc, "library");

    // Root anchor node
    const rootNodeId = `project:${targetProjectId}`;
    db.prepare(`
      INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, properties, is_hub)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
    `).run(rootNodeId, targetProjectId, displayName, "service", desc, "library", JSON.stringify({ is_library: true }));

    // Run batch ingestion
    const batchRes = await handleIngestionTool("kb_batch_ingest_directory", {
      project_id: targetProjectId,
      dir_path: dep.source,
      ignore: ["example/**", "test/**", "tests/**", "integration_test/**", "*.md"],
    }, db);

    // Link target to requesting project
    db.prepare(`INSERT OR IGNORE INTO project_links (project_id, linked_id) VALUES (?, ?)`).run(project_id, targetProjectId);
    refreshLinks(db);

    const ingestSummary = batchRes?.content[0]?.text || "";
    const nodeCount = graphMemory.getProjectNodes(targetProjectId).length;

    return {
      content: [{
        type: "text",
        text: `### 🚀 Successfully Ingested & Linked Library: \`${dep.name}\` (\`${targetProjectId}\`)\n` +
          `- **Source Path:** \`${dep.source}\`\n` +
          `- **Version:** \`${dep.version || "detected"}\`\n` +
          `- **Nodes in Graph:** ${nodeCount}\n` +
          `- **Joint Search:** Enabled for project \`${project_id}\`.\n\n` +
          `**Ingestion Details:**\n${ingestSummary}\n\n` +
          `💡 You can now query symbols from \`${dep.name}\` directly via \`kb_search\`.`,
      }],
    };
  }

  if (name === "kb_prune_libraries") {
    const { dry_run, vacuum } = PruneLibrariesSchema.parse(args);
    const result = pruneLibraries(db, { dryRun: dry_run, vacuum });

    const lines = [
      `### 🧹 Knowledge Base Library Pruning Report ${dry_run ? "*(Dry Run — Preview Only)*" : ""}`,
      `- **Candidates Found:** ${result.prunedLibraries.length}`,
      `- **Reclaimed Nodes:** ${result.reclaimedNodes}`,
      `- **Reclaimed Edges:** ${result.reclaimedEdges}`,
      `- **SQLite VACUUM:** ${result.vacuumExecuted ? "Executed (disk space reclaimed)" : "Skipped"}`,
      "",
    ];

    if (result.prunedLibraries.length > 0) {
      lines.push("**Libraries Details:**");
      for (const p of result.prunedLibraries) {
        lines.push(`- \`${p.id}\` (${p.name}): ${p.nodes} nodes, ${p.edges} edges — *${p.reason}*`);
      }
    } else {
      lines.push("✅ No orphaned or stale libraries found. Storage is clean and optimal!");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return null;
}
