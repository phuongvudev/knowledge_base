import { DatabaseInstance } from "../database.js";
import { GraphEdge, GraphNode } from "../types.js";

export class GraphMemoryCache {
  private nodes = new Map<string, GraphNode>();
  private outEdges = new Map<string, Set<GraphEdge>>();
  private inEdges = new Map<string, Set<GraphEdge>>();
  private projectNodes = new Map<string, Set<string>>();

  private dataVersion = -1;
  private signature = "";

  private readVersion(db: DatabaseInstance) {
    const v = (db.prepare("PRAGMA data_version").get() as any).data_version as number;
    const sig = db
      .prepare(`SELECT (SELECT COUNT(*) FROM graph_nodes) || ':' || (SELECT COALESCE(MAX(updated_at), '') FROM graph_nodes)
                || ':' || (SELECT COUNT(*) FROM graph_edges) AS sig`)
      .get() as any;
    return { v, sig: sig.sig as string };
  }

  /**
   * MCP and web run as separate processes with their own cache. data_version only moves when
   * ANOTHER connection commits, so this is a no-op for our own writes; rehydrate only if the graph really changed.
   */
  public syncIfStale(db: DatabaseInstance): void {
    const { v, sig } = this.readVersion(db);
    if (v === this.dataVersion) return;
    this.dataVersion = v;
    if (sig !== this.signature) this.hydrate(db);
  }

  public hydrate(db: DatabaseInstance): void {
    ({ v: this.dataVersion, sig: this.signature } = this.readVersion(db));
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.projectNodes.clear();

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
    this.nodes.set(node.id, node);

    if (!this.projectNodes.has(node.project_id)) {
      this.projectNodes.set(node.project_id, new Set());
    }
    this.projectNodes.get(node.project_id)!.add(node.id);

    if (!this.outEdges.has(node.id)) {
      this.outEdges.set(node.id, new Set());
    }
    if (!this.inEdges.has(node.id)) {
      this.inEdges.set(node.id, new Set());
    }
  }

  public addEdgeMemory(edge: GraphEdge): void {
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
    for (const e of [...(this.outEdges.get(id) ?? []), ...(this.inEdges.get(id) ?? [])]) this.removeEdge(e);
    this.nodes.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);
    this.projectNodes.get(node.project_id)?.delete(id);
  }

  public removeEdge(edge: { source_id: string; target_id: string; relation_type: string }): void {
    for (const [map, key] of [[this.outEdges, edge.source_id], [this.inEdges, edge.target_id]] as const) {
      const set = map.get(key);
      if (!set) continue;
      for (const e of set) {
        if (e.source_id === edge.source_id && e.target_id === edge.target_id && e.relation_type === edge.relation_type) set.delete(e);
      }
    }
  }

  public getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
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
    const ids = this.projectNodes.get(projectId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphNode => Boolean(n));
  }

  public getProjectEdges(projectId: string): GraphEdge[] {
    const projectNodeIds = this.projectNodes.get(projectId);
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

  public getImpactSubgraph(targetNodeId: string): {
    affectedNodes: GraphNode[];
    paths: GraphEdge[];
  } {
    const targetNode = this.nodes.get(targetNodeId);
    if (!targetNode) {
      return { affectedNodes: [], paths: [] };
    }

    const affectedIds = new Set<string>();
    const traversedEdges: GraphEdge[] = [];
    const queue = [targetNodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const inbound = this.inEdges.get(current);
      if (inbound) {
        for (const edge of inbound) {
          if (!affectedIds.has(edge.source_id)) {
            affectedIds.add(edge.source_id);
            traversedEdges.push(edge);
            queue.push(edge.source_id);
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
