import { DatabaseInstance } from "../database.js";
import { GraphEdge, GraphNode } from "../types.js";
import { computeCentrality, NodeCentrality } from "./pagerank.js";

export class GraphMemoryCache {
  private nodes = new Map<string, GraphNode>();
  private outEdges = new Map<string, Set<GraphEdge>>();
  private inEdges = new Map<string, Set<GraphEdge>>();
  private projectNodes = new Map<string, Set<string>>();
  private nodesByFile = new Map<string, Set<string>>();
  private importersOf = new Map<string, Set<string>>();
  private centralityCache = new Map<string, Map<string, NodeCentrality>>();

  private dataVersion = -1;
  private signature = "";

  private invalidateCentrality(projectId?: string): void {
    if (projectId) {
      this.centralityCache.delete("__all__");
      this.centralityCache.delete(projectId);
    } else {
      this.centralityCache.clear();
    }
  }

  private readDataVersion(db: DatabaseInstance): number {
    return (db.prepare("PRAGMA data_version").get() as any).data_version as number;
  }

  private readSignature(db: DatabaseInstance): string {
    const sig = db
      .prepare(`SELECT (SELECT COUNT(*) FROM graph_nodes) || ':' || (SELECT COALESCE(MAX(updated_at), '') FROM graph_nodes)
                || ':' || (SELECT COUNT(*) FROM graph_edges) AS sig`)
      .get() as any;
    return sig.sig as string;
  }

  /**
   * MCP and web run as separate processes with their own cache. data_version only moves when
   * ANOTHER connection commits, so this is a no-op for our own writes; rehydrate only if the graph really changed.
   */
  public syncIfStale(db: DatabaseInstance): void {
    const v = this.readDataVersion(db);
    if (v === this.dataVersion) return;
    this.dataVersion = v;
    const sig = this.readSignature(db);
    if (sig !== this.signature) this.hydrate(db);
  }

  public hydrate(db: DatabaseInstance): void {
    this.dataVersion = this.readDataVersion(db);
    this.signature = this.readSignature(db);
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.projectNodes.clear();
    this.nodesByFile.clear();
    this.importersOf.clear();
    this.centralityCache.clear();

    const nodeRows = db.prepare(`SELECT * FROM graph_nodes`).all() as any[];
    for (const row of nodeRows) {
      const node: GraphNode = {
        id: row.id,
        project_id: row.project_id,
        label: row.label,
        node_type: row.node_type,
        summary: row.summary,
        domain: row.domain || "general",
        properties: row.properties ? JSON.parse(row.properties) : {},
        is_hub: Boolean(row.is_hub),
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
      this.addNodeMemory(node);
    }

    const edgeRows = db.prepare(`SELECT * FROM graph_edges`).all() as any[];
    for (const row of edgeRows) {
      const edge: GraphEdge = {
        id: row.id,
        project_id: row.project_id,
        source_id: row.source_id,
        target_id: row.target_id,
        relation_type: row.relation_type,
        description: row.description,
        weight: row.weight || 1.0,
        created_at: row.created_at,
      };
      this.addEdgeMemory(edge);
    }
  }

  public addNodeMemory(node: GraphNode): void {
    const prev = this.nodes.get(node.id);
    if (prev) {
      const prevFp = prev.properties?.file_path;
      if (typeof prevFp === "string") {
        this.nodesByFile.get(prevFp)?.delete(prev.id);
        if (prev.node_type === "module" && Array.isArray(prev.properties?.internal_imports)) {
          for (const imp of prev.properties.internal_imports as string[]) {
            this.importersOf.get(imp)?.delete(prevFp);
          }
        }
      }
      if (prev.project_id !== node.project_id) {
        this.projectNodes.get(prev.project_id)?.delete(prev.id);
      }
    }

    this.nodes.set(node.id, node);
    this.invalidateCentrality(node.project_id);

    if (!this.projectNodes.has(node.project_id)) {
      this.projectNodes.set(node.project_id, new Set());
    }
    this.projectNodes.get(node.project_id)!.add(node.id);

    const fp = node.properties?.file_path;
    if (typeof fp === "string") {
      let fset = this.nodesByFile.get(fp);
      if (!fset) {
        fset = new Set();
        this.nodesByFile.set(fp, fset);
      }
      fset.add(node.id);

      if (node.node_type === "module" && Array.isArray(node.properties?.internal_imports)) {
        for (const imp of node.properties.internal_imports as string[]) {
          let iset = this.importersOf.get(imp);
          if (!iset) {
            iset = new Set();
            this.importersOf.set(imp, iset);
          }
          iset.add(fp);
        }
      }
    }

    if (!this.outEdges.has(node.id)) {
      this.outEdges.set(node.id, new Set());
    }
    if (!this.inEdges.has(node.id)) {
      this.inEdges.set(node.id, new Set());
    }
  }

  public addEdgeMemory(edge: GraphEdge): void {
    this.invalidateCentrality(edge.project_id);
    if (!this.outEdges.has(edge.source_id)) {
      this.outEdges.set(edge.source_id, new Set());
    }
    this.outEdges.get(edge.source_id)!.add(edge);

    if (!this.inEdges.has(edge.target_id)) {
      this.inEdges.set(edge.target_id, new Set());
    }
    this.inEdges.get(edge.target_id)!.add(edge);
  }

  public removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.invalidateCentrality(node.project_id);
    const fp = node.properties?.file_path;
    if (typeof fp === "string") {
      this.nodesByFile.get(fp)?.delete(id);
      if (node.node_type === "module" && Array.isArray(node.properties?.internal_imports)) {
        for (const imp of node.properties.internal_imports as string[]) {
          this.importersOf.get(imp)?.delete(fp);
        }
      }
    }
    for (const e of [...(this.outEdges.get(id) ?? []), ...(this.inEdges.get(id) ?? [])]) this.removeEdge(e);
    this.nodes.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);
    this.projectNodes.get(node.project_id)?.delete(id);
  }

  public removeEdge(edge: { source_id: string; target_id: string; relation_type: string }): void {
    this.invalidateCentrality(this.nodes.get(edge.source_id)?.project_id);
    for (const [map, key] of [[this.outEdges, edge.source_id], [this.inEdges, edge.target_id]] as const) {
      const set = map.get(key);
      if (!set) continue;
      for (const e of set) {
        if (e.source_id === edge.source_id && e.target_id === edge.target_id && e.relation_type === edge.relation_type) set.delete(e);
      }
    }
  }

  public resolveProjectId(projectId?: string): string | undefined {
    if (!projectId) return undefined;
    if (this.projectNodes.has(projectId)) return projectId;

    // Strip npm @scope/ prefix (e.g. "@rail/core" -> "rail-core") or trailing path segments
    const scoped = projectId.trim().replace(/^@([^/]+)\/(.+)$/, "$1-$2");
    const clean = scoped.replace(/\/+$/, "").split("/").pop() || scoped;
    if (this.projectNodes.has(clean)) return clean;

    const norm = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, "-");
    const targetNorm = norm(clean);
    for (const existing of this.projectNodes.keys()) {
      if (norm(existing) === targetNorm) return existing;
    }

    // Monorepo sub-package / prefix alias resolution (e.g. "rail-core" -> "rail", "reshub" -> "reshub-web", "budgetable-core" -> "budgetable-v2")
    const isTargetLib = targetNorm.startsWith("lib-");
    const candidates = Array.from(this.projectNodes.keys()).filter(
      (k) => isTargetLib || !norm(k).startsWith("lib-")
    );

    // 1. Target is "<existing>-<subpkg>" (e.g. "rail-core" matches "rail") — prefer longest existing prefix
    let bestPrefixMatch: string | undefined;
    for (const existing of candidates) {
      const exNorm = norm(existing);
      if (targetNorm.startsWith(exNorm + "-")) {
        if (!bestPrefixMatch || exNorm.length > norm(bestPrefixMatch).length) {
          bestPrefixMatch = existing;
        }
      }
    }
    if (bestPrefixMatch) return bestPrefixMatch;

    // 2. Existing is "<target>-<suffix>" (e.g. "reshub" matches "reshub-web", "budgetable" matches "budgetable-v2")
    const superMatches = candidates.filter((existing) => norm(existing).startsWith(targetNorm + "-"));
    if (superMatches.length === 1) return superMatches[0];

    // 3. Shared leading root token "<root>-*" when unique among non-library projects (e.g. "budgetable-core" -> "budgetable-v2")
    const rootToken = targetNorm.split("-")[0];
    if (rootToken && rootToken.length >= 3) {
      const rootMatches = candidates.filter((existing) => {
        const exNorm = norm(existing);
        return exNorm === rootToken || exNorm.startsWith(rootToken + "-");
      });
      if (rootMatches.length === 1) return rootMatches[0];
    }

    return projectId;
  }

  public getProjectRoot(projectId?: string): string | undefined {
    const resolved = this.resolveProjectId(projectId);
    if (!resolved) return undefined;
    const nodes = this.getProjectNodes(resolved);
    const paths: string[] = [];
    for (const n of nodes) {
      const fp = n.properties?.file_path;
      if (typeof fp === "string" && fp.startsWith("/")) {
        paths.push(fp);
        if (paths.length >= 40) break;
      }
    }
    if (paths.length === 0) return undefined;
    let root = paths[0].slice(0, paths[0].lastIndexOf("/") + 1);
    for (const p of paths) {
      while (root && !p.startsWith(root)) {
        root = root.slice(0, root.slice(0, -1).lastIndexOf("/") + 1);
      }
    }
    return root ? root.replace(/\/+$/, "") : undefined;
  }

  public resolveNode(idOrQuery: string, projectId?: string): GraphNode | undefined {
    const rawTrimmed = idOrQuery.trim();
    const exact = this.nodes.get(rawTrimmed);
    if (exact) return exact;

    const resolvedProj = this.resolveProjectId(projectId);
    const pool = resolvedProj ? this.getProjectNodes(resolvedProj) : this.getAllNodes();

    // Strip optional :line or #L... suffix (unless the raw query is a node ID with colons like "component:a:b")
    const hasNodePrefix = /^(?:component|module|data_model|service|rule|policy|decision|process|general|doc|config|role|api_endpoint|env_config|template):/i.test(rawTrimmed);
    const q = (hasNodePrefix ? rawTrimmed : rawTrimmed.replace(/(?::\d+(?:-\d+)?|#L\d+(?:-\d+)?)$/i, ""))
      .replace(/::|#/g, ".")
      .trim();
    const qLower = q.toLowerCase();
    const qSlug = qLower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const stripAt = (id: string) => id.replace(/@[^@]+$/, "").toLowerCase();

    // 0. Exact ID match ignoring @project suffix
    const exactNoAt = pool.find((n) => stripAt(n.id) === qLower && !n.properties?.placeholder);
    if (exactNoAt) return exactNoAt;

    // 1. Exact label match (case-insensitive, prefer non-module, non-chunk symbols then modules)
    const labelHit =
      pool.find((n) => n.label.toLowerCase() === qLower && n.node_type !== "module" && !n.properties?.placeholder && !n.properties?.is_chunk) ||
      pool.find((n) => n.label.toLowerCase() === qLower && !n.properties?.placeholder);
    if (labelHit) return labelHit;

    // 2. Unqualified method / member match (e.g. "resolveProjectId" -> "GraphMemoryCache.resolveProjectId")
    const memberHit = pool.find(
      (n) =>
        !n.properties?.placeholder &&
        !n.properties?.is_chunk &&
        n.label.toLowerCase().endsWith("." + qLower)
    );
    if (memberHit) return memberHit;

    // 3. File path or suffix match -> prefer the file's module node, or primary symbol in that file
    const normPath = q.replace(/^\/+/, "");
    const fileModuleHit = pool.find((n) => {
      if (n.node_type !== "module" || n.properties?.placeholder) return false;
      const fp = n.properties?.file_path as string | undefined;
      return fp && (fp === q || fp.endsWith("/" + normPath));
    });
    if (fileModuleHit) return fileModuleHit;

    const fileSymbolHit = pool.find((n) => {
      if (n.properties?.placeholder || n.properties?.is_chunk) return false;
      const fp = n.properties?.file_path as string | undefined;
      return fp && (fp === q || fp.endsWith("/" + normPath));
    });
    if (fileSymbolHit) return fileSymbolHit;

    // 4. Node ID suffix match (ignoring @project suffix, e.g. ":telemetryengine" or "_resolveprojectid" or "module:engine_telemetry_ts")
    const suffixHit = pool.find((n) => {
      if (n.properties?.placeholder || n.properties?.is_chunk) return false;
      const baseId = stripAt(n.id);
      return (
        baseId.endsWith(":" + qLower) ||
        baseId.endsWith(":" + qSlug) ||
        baseId.endsWith("_" + qSlug) ||
        baseId === "module:" + qSlug
      );
    });
    if (suffixHit) return suffixHit;

    // 5. Substring match on non-chunk symbol label when query is specific enough (>= 4 chars)
    if (qLower.length >= 4 && !qLower.includes("/")) {
      const subHits = pool.filter(
        (n) =>
          !n.properties?.placeholder &&
          !n.properties?.is_chunk &&
          n.node_type !== "module" &&
          (n.label.toLowerCase().includes(qLower) || stripAt(n.id).includes(qSlug))
      );
      if (subHits.length > 0) {
        subHits.sort((a, b) => a.label.length - b.label.length);
        return subHits[0];
      }
    }

    return undefined;
  }

  public suggestNodes(idOrQuery: string, projectId?: string, limit: number = 3): GraphNode[] {
    const resolvedProj = this.resolveProjectId(projectId);
    const pool = resolvedProj ? this.getProjectNodes(resolvedProj) : this.getAllNodes();
    const tokens = idOrQuery
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !["component", "module", "src", "lib", "dart", "tsx"].includes(t));
    if (tokens.length === 0) return [];

    const scored: Array<{ node: GraphNode; score: number }> = [];
    for (const n of pool) {
      if (n.properties?.placeholder || n.properties?.is_chunk) continue;
      const hay = `${n.label} ${n.id} ${n.properties?.file_path ?? ""}`.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (n.label.toLowerCase().includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ node: n, score });
    }
    scored.sort((a, b) => b.score - a.score || a.node.label.length - b.node.label.length);
    return scored.slice(0, limit).map((s) => s.node);
  }

  public getCentrality(projectId?: string): Map<string, NodeCentrality> {
    const resolved = this.resolveProjectId(projectId);
    const key = resolved || "__all__";
    const cached = this.centralityCache.get(key);
    if (cached) return cached;

    const nodes = resolved ? this.getProjectNodes(resolved) : this.getAllNodes();
    const edges = resolved ? this.getProjectEdges(resolved) : this.getAllEdges();
    const computed = computeCentrality(nodes, edges);
    this.centralityCache.set(key, computed);
    return computed;
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  public getNodesByFile(filePath: string, projectId?: string): GraphNode[] {
    const ids = this.nodesByFile.get(filePath);
    if (!ids) return [];
    const out: GraphNode[] = [];
    for (const id of ids) {
      const n = this.nodes.get(id);
      if (n && (!projectId || n.project_id === projectId)) out.push(n);
    }
    return out;
  }

  public getImporterFiles(moduleId: string): ReadonlySet<string> | undefined {
    return this.importersOf.get(moduleId);
  }

  public getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  public getAllEdges(): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const edgeSet of this.outEdges.values()) {
      for (const edge of edgeSet) {
        edges.push(edge);
      }
    }
    return edges;
  }

  public getProjectNodes(projectId: string): GraphNode[] {
    const resolved = this.resolveProjectId(projectId) || projectId;
    const ids = this.projectNodes.get(resolved);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => Boolean(n));
  }

  public getProjectEdges(projectId: string): GraphEdge[] {
    const resolved = this.resolveProjectId(projectId) || projectId;
    const projectNodeIds = this.projectNodes.get(resolved);
    if (!projectNodeIds) return [];

    const edges: GraphEdge[] = [];
    for (const nodeId of projectNodeIds) {
      const outList = this.outEdges.get(nodeId);
      if (outList) {
        for (const edge of outList) {
          if (projectNodeIds.has(edge.target_id)) {
            edges.push(edge);
          }
        }
      }
    }
    return edges;
  }

  public getRadialSubgraph(
    centerNodeId: string,
    depth: number = 1,
    maxNodes: number = 20
  ): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const centerNode = this.nodes.get(centerNodeId);
    if (!centerNode) {
      return { nodes: [], edges: [] };
    }

    const visitedNodes = new Set<string>([centerNodeId]);
    const collectedEdges = new Set<GraphEdge>();
    let currentLevel = [centerNodeId];

    for (let d = 0; d < depth; d++) {
      const nextLevel: string[] = [];

      for (const currId of currentLevel) {
        if (visitedNodes.size >= maxNodes) break;

        // Outbound edges: currId -> target
        const outList = this.outEdges.get(currId);
        if (outList) {
          for (const edge of outList) {
            collectedEdges.add(edge);
            if (!visitedNodes.has(edge.target_id) && visitedNodes.size < maxNodes) {
              visitedNodes.add(edge.target_id);
              nextLevel.push(edge.target_id);
            }
          }
        }

        // Inbound edges: source -> currId
        const inList = this.inEdges.get(currId);
        if (inList) {
          for (const edge of inList) {
            collectedEdges.add(edge);
            if (!visitedNodes.has(edge.source_id) && visitedNodes.size < maxNodes) {
              visitedNodes.add(edge.source_id);
              nextLevel.push(edge.source_id);
            }
          }
        }
      }

      currentLevel = nextLevel;
      if (currentLevel.length === 0 || visitedNodes.size >= maxNodes) break;
    }

    const resultNodes = Array.from(visitedNodes)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => Boolean(n));

    return {
      nodes: resultNodes,
      edges: Array.from(collectedEdges),
    };
  }

  public getImpactSubgraph(targetNodeId: string, maxDepth: number = 3): {
    affectedNodes: GraphNode[];
    paths: GraphEdge[];
  } {
    const targetNode = this.nodes.get(targetNodeId);
    if (!targetNode) {
      return { affectedNodes: [], paths: [] };
    }

    const isSymbol = targetNode.node_type !== "module" && targetNode.node_type !== "project";
    const affectedIds = new Set<string>();
    const traversedEdges: GraphEdge[] = [];
    const seedIds = new Set<string>([targetNodeId]);
    const queue: Array<{ id: string; depth: number }> = [{ id: targetNodeId, depth: 0 }];

    // If targetNode is a module or a class container, also seed its contained symbols / methods at depth 0
    const targetFp = targetNode.properties?.file_path as string | undefined;
    if (targetFp) {
      const fileNodes = this.getNodesByFile(targetFp, targetNode.project_id);
      if (targetNode.node_type === "module") {
        for (const fn of fileNodes) {
          if (fn.id !== targetNodeId && !fn.properties?.placeholder && !fn.properties?.is_chunk) {
            seedIds.add(fn.id);
            queue.push({ id: fn.id, depth: 0 });
          }
        }
      } else if (!targetNode.label.includes(".")) {
        const classPrefix = targetNode.label.toLowerCase() + ".";
        for (const fn of fileNodes) {
          if (fn.id !== targetNodeId && !fn.properties?.placeholder && !fn.properties?.is_chunk && fn.label.toLowerCase().startsWith(classPrefix)) {
            seedIds.add(fn.id);
            queue.push({ id: fn.id, depth: 0 });
          }
        }
      }
    }

    const isPureBarrel = (node?: GraphNode) => {
      if (!node || node.node_type !== "module") return false;
      if (/no recognised definitions/i.test(node.summary)) return true;
      const outDeps = this.outEdges.get(node.id)?.size ?? 0;
      const inDeps = this.inEdges.get(node.id)?.size ?? 0;
      return outDeps >= 20 && inDeps >= 15;
    };

    let head = 0;
    while (head < queue.length) {
      const { id: current, depth } = queue[head++];
      if (depth >= maxDepth) continue;

      const inbound = this.inEdges.get(current);
      if (inbound) {
        // Prioritize direct CALLS edges before generic module DEPENDS_ON edges (two passes instead of allocating & sorting)
        for (let pass = 0; pass < 2; pass++) {
          for (const edge of inbound) {
            if ((pass === 0) !== (edge.relation_type === "CALLS")) continue;
            if (seedIds.has(edge.source_id)) continue;
            // Never traverse backward across containment edges (module CONTAINS component, or method CONTAINS chunk)
            if (edge.relation_type === "CONTAINS" || edge.description?.toLowerCase().includes("contains")) {
              continue;
            }
            const srcNode = this.nodes.get(edge.source_id);
            if (srcNode?.properties?.is_chunk || srcNode?.properties?.placeholder) continue;
            // For symbol-level impact, ignore module-level containment and barrel dependencies
            if (isSymbol && srcNode?.node_type === "module" && edge.relation_type !== "CALLS" && edge.relation_type !== "REFERENCES") {
              continue;
            }

            if (!affectedIds.has(edge.source_id)) {
              affectedIds.add(edge.source_id);
              traversedEdges.push(edge);
              // Do not transitively expand through pure barrel/re-export hubs (prevents false-positive explosion)
              if (!isPureBarrel(srcNode)) {
                queue.push({ id: edge.source_id, depth: depth + 1 });
              }
            }
          }
        }
      }
    }

    const affectedNodes = Array.from(affectedIds)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => Boolean(n));

    return {
      affectedNodes,
      paths: traversedEdges,
    };
  }
}

export const graphMemory = new GraphMemoryCache();
