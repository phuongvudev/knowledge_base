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
    this.centralityCache.delete("__all__");
    if (projectId) {
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

    const clean = projectId.replace(/\/+$/, "").split("/").pop() || projectId;
    if (this.projectNodes.has(clean)) return clean;

    const norm = (s: string) => s.toLowerCase().replace(/[-_\s]+/g, "-");
    const targetNorm = norm(clean);
    for (const existing of this.projectNodes.keys()) {
      if (norm(existing) === targetNorm) return existing;
    }
    return projectId;
  }

  public resolveNode(idOrQuery: string, projectId?: string): GraphNode | undefined {
    const exact = this.nodes.get(idOrQuery);
    if (exact) return exact;

    const resolvedProj = this.resolveProjectId(projectId);
    const pool = resolvedProj ? this.getProjectNodes(resolvedProj) : this.getAllNodes();
    const q = idOrQuery.trim();
    const qLower = q.toLowerCase();
    const qSlug = qLower.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

    // 1. Exact label match (case-insensitive, prefer non-module symbols then modules)
    const labelHit = pool.find((n) => n.label.toLowerCase() === qLower && !n.properties?.placeholder);
    if (labelHit) return labelHit;

    // 2. File path or suffix match -> return the file's module node
    const normPath = q.replace(/^\/+/, "");
    const fileHit = pool.find((n) => {
      if (n.node_type !== "module" || n.properties?.placeholder) return false;
      const fp = n.properties?.file_path as string | undefined;
      return fp && (fp === q || fp.endsWith("/" + normPath));
    });
    if (fileHit) return fileHit;

    // 3. Node ID suffix match (e.g. ":telemetryengine" or "module:engine_telemetry_ts")
    const suffixHit = pool.find(
      (n) =>
        !n.properties?.placeholder &&
        (n.id.toLowerCase().endsWith(":" + qLower) ||
          n.id.toLowerCase().endsWith(":" + qSlug) ||
          n.id.toLowerCase() === "module:" + qSlug)
    );
    return suffixHit;
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
    const queue: Array<{ id: string; depth: number }> = [{ id: targetNodeId, depth: 0 }];

    const isPureBarrel = (node?: GraphNode) => {
      if (!node || node.node_type !== "module") return false;
      if (/no recognised definitions/i.test(node.summary)) return true;
      const outDeps = this.outEdges.get(node.id)?.size ?? 0;
      const inDeps = this.inEdges.get(node.id)?.size ?? 0;
      return outDeps >= 20 && inDeps >= 15;
    };

    while (queue.length > 0) {
      const { id: current, depth } = queue.shift()!;
      if (depth >= maxDepth) continue;

      const inbound = this.inEdges.get(current);
      if (inbound) {
        // Prioritize direct CALLS edges before generic module DEPENDS_ON edges
        const sortedInbound = [...inbound].sort((a, b) =>
          (a.relation_type === "CALLS" ? 0 : 1) - (b.relation_type === "CALLS" ? 0 : 1)
        );
        for (const edge of sortedInbound) {
          if (edge.source_id === targetNodeId) continue;
          // Never traverse backward across containment edges (module CONTAINS component, or method CONTAINS chunk)
          if (edge.relation_type === "CONTAINS" || edge.description?.toLowerCase().includes("contains")) {
            continue;
          }
          const srcNode = this.nodes.get(edge.source_id);
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
