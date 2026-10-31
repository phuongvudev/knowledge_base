import { GraphEdge, GraphNode } from "../types.js";

export interface NodeCentrality {
  nodeId: string;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
  score: number;
}

export function computeCentrality(
  nodes: GraphNode[],
  edges: GraphEdge[]
): Map<string, NodeCentrality> {
  const centralityMap = new Map<string, NodeCentrality>();

  for (const node of nodes) {
    centralityMap.set(node.id, {
      nodeId: node.id,
      inDegree: 0,
      outDegree: 0,
      totalDegree: 0,
      score: 0,
    });
  }

  // Pre-build incoming edges map for O(1) lookups in PageRank loop
  const inEdgesMap = new Map<string, string[]>();

  for (const edge of edges) {
    const src = centralityMap.get(edge.source_id);
    const tgt = centralityMap.get(edge.target_id);

    if (src) {
      src.outDegree += 1;
      src.totalDegree += 1;
    }
    if (tgt) {
      tgt.inDegree += 1;
      tgt.totalDegree += 1;
    }

    let inList = inEdgesMap.get(edge.target_id);
    if (!inList) {
      inList = [];
      inEdgesMap.set(edge.target_id, inList);
    }
    inList.push(edge.source_id);
  }

  // Simplified PageRank algorithm (5 iterations)
  const damping = 0.85;
  const initialScore = 1.0 / Math.max(1, nodes.length);
  const scores = new Map<string, number>();

  for (const node of nodes) {
    scores.set(node.id, initialScore);
  }

  for (let iter = 0; iter < 5; iter++) {
    const nextScores = new Map<string, number>();

    for (const node of nodes) {
      let incomingRank = 0;
      const sources = inEdgesMap.get(node.id);
      if (sources) {
        for (const sourceId of sources) {
          const srcCent = centralityMap.get(sourceId);
          const outDeg = srcCent ? Math.max(1, srcCent.outDegree) : 1;
          incomingRank += (scores.get(sourceId) || 0) / outDeg;
        }
      }

      const newScore = (1 - damping) / Math.max(1, nodes.length) + damping * incomingRank;
      nextScores.set(node.id, newScore);
    }

    for (const [id, sc] of nextScores.entries()) {
      scores.set(id, sc);
    }
  }

  for (const [id, cent] of centralityMap.entries()) {
    cent.score = scores.get(id) || 0;
  }

  return centralityMap;
}

/**
 * Filter nodes for LOD 0 / LOD 1 based on centrality hubs & domains
 */
export function filterHubNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  topK: number = 10,
  existingCentrality?: Map<string, NodeCentrality>
): {
  hubNodes: GraphNode[];
  hubEdges: GraphEdge[];
  otherCount: number;
  centrality: Map<string, NodeCentrality>;
} {
  const centrality = existingCentrality || computeCentrality(nodes, edges);

  if (nodes.length <= topK) {
    return { hubNodes: nodes, hubEdges: edges, otherCount: 0, centrality };
  }

  const sorted = [...nodes].sort((a, b) => {
    const scoreA = centrality.get(a.id)?.score || 0;
    const scoreB = centrality.get(b.id)?.score || 0;
    return scoreB - scoreA;
  });

  const hubNodes = sorted.slice(0, topK);
  const hubIds = new Set(hubNodes.map((n) => n.id));

  const hubEdges = edges.filter(
    (e) => hubIds.has(e.source_id) && hubIds.has(e.target_id)
  );

  return {
    hubNodes,
    hubEdges,
    otherCount: nodes.length - hubNodes.length,
    centrality,
  };
}
