import { GraphEdge, GraphNode } from "../types.js";
import { computeCentrality } from "./pagerank.js";

export interface DependencyCycle {
  id: string;
  cycleLength: number;
  path: string[];
  nodes: { id: string; label: string; file_path?: string; node_type: string }[];
}

export interface OrphanNode {
  id: string;
  label: string;
  node_type: string;
  summary: string;
  file_path?: string;
  line?: number;
}

export interface ArchitectureAuditReport {
  project_id: string;
  timestamp: string;
  healthScore: number; // 0 - 100
  totalNodes: number;
  totalEdges: number;
  cycles: DependencyCycle[];
  orphanNodes: OrphanNode[];
  summary: {
    cycleCount: number;
    orphanCount: number;
    status: "healthy" | "warning" | "critical";
  };
}

/**
 * Detects circular dependencies (cycles in directed graph)
 */
export function detectCircularDependencies(
  nodes: GraphNode[],
  edges: GraphEdge[]
): DependencyCycle[] {
  const nodeMap = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));
  const adj = new Map<string, string[]>();

  for (const n of nodes) {
    adj.set(n.id, []);
  }

  // Only consider structural dependencies (DEPENDS_ON, IMPORTS, EXTENDS, CALLS)
  const structuralTypes = new Set([
    "DEPENDS_ON",
    "IMPORTS",
    "EXTENDS",
    "IMPLEMENTS",
    "CALLS",
    "USES",
  ]);

  for (const e of edges) {
    const rel = e.relation_type?.toUpperCase() || "DEPENDS_ON";
    if (structuralTypes.has(rel) || !e.relation_type) {
      if (adj.has(e.source_id) && adj.has(e.target_id)) {
        adj.get(e.source_id)!.push(e.target_id);
      }
    }
  }

  // DFS Cycle detection
  const visited = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited
  const parentPath: string[] = [];
  const rawCycles: string[][] = [];

  function dfs(curr: string) {
    visited.set(curr, 1);
    parentPath.push(curr);

    const neighbors = adj.get(curr) || [];
    for (const nxt of neighbors) {
      const state = visited.get(nxt) || 0;
      if (state === 1) {
        // Found back-edge -> Cycle detected!
        const cycleStartIndex = parentPath.indexOf(nxt);
        if (cycleStartIndex !== -1) {
          const cycle = parentPath.slice(cycleStartIndex);
          cycle.push(nxt); // close loop
          rawCycles.push(cycle);
        }
      } else if (state === 0) {
        dfs(nxt);
      }
    }

    parentPath.pop();
    visited.set(curr, 2);
  }

  for (const n of nodes) {
    if ((visited.get(n.id) || 0) === 0) {
      dfs(n.id);
    }
  }

  // Deduplicate cycles: normalize cycle representation
  const uniqueCycles = new Map<string, string[]>();

  for (const cycle of rawCycles) {
    const elements = cycle.slice(0, cycle.length - 1);
    if (elements.length < 2) continue;

    // Find min element to rotate cycle to canonical form
    let minIdx = 0;
    for (let i = 1; i < elements.length; i++) {
      if (elements[i] < elements[minIdx]) minIdx = i;
    }

    const rotated = [...elements.slice(minIdx), ...elements.slice(0, minIdx)];
    const key = rotated.join(" -> ");

    if (!uniqueCycles.has(key)) {
      uniqueCycles.set(key, [...rotated, rotated[0]]);
    }
  }

  const results: DependencyCycle[] = [];
  for (const [key, cyclePath] of uniqueCycles.entries()) {
    results.push({
      id: key,
      cycleLength: cyclePath.length - 1,
      path: cyclePath,
      nodes: cyclePath.slice(0, -1).map((id) => {
        const n = nodeMap.get(id);
        return {
          id,
          label: n?.label || id,
          node_type: n?.node_type || "unknown",
          file_path: n?.properties?.file_path as string | undefined,
        };
      }),
    });
  }

  return results;
}

/**
 * Detects orphan / dead nodes (no incoming references)
 */
export function detectOrphanNodes(
  nodes: GraphNode[],
  edges: GraphEdge[]
): OrphanNode[] {
  const centrality = computeCentrality(nodes, edges);
  const orphans: OrphanNode[] = [];

  for (const n of nodes) {
    // Ignore top-level project root, services, persons, or env configs
    if (
      n.properties?.is_project_root ||
      n.node_type === "service" ||
      n.node_type === "person" ||
      n.node_type === "env_config" ||
      n.id.startsWith("project:")
    ) {
      continue;
    }

    const cent = centrality.get(n.id);
    if (cent && cent.inDegree === 0) {
      orphans.push({
        id: n.id,
        label: n.label,
        node_type: n.node_type,
        summary: n.summary,
        file_path: n.properties?.file_path as string | undefined,
        line: n.properties?.line as number | undefined,
      });
    }
  }

  return orphans;
}

/**
 * Generates a comprehensive architectural audit report
 */
export function auditArchitecture(
  projectId: string,
  nodes: GraphNode[],
  edges: GraphEdge[]
): ArchitectureAuditReport {
  const cycles = detectCircularDependencies(nodes, edges);
  const orphanNodes = detectOrphanNodes(nodes, edges);

  // Compute Health Score (100 is perfect)
  // Deduct 10 points per circular dependency (critical architecture smell)
  // Deduct 1 point per 5 orphan nodes (potential dead code)
  let penalty = cycles.length * 10 + Math.floor(orphanNodes.length / 5);
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));

  let status: "healthy" | "warning" | "critical" = "healthy";
  if (cycles.length > 3 || healthScore < 60) {
    status = "critical";
  } else if (cycles.length > 0 || orphanNodes.length > 10 || healthScore < 85) {
    status = "warning";
  }

  return {
    project_id: projectId,
    timestamp: new Date().toISOString(),
    healthScore,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    cycles,
    orphanNodes,
    summary: {
      cycleCount: cycles.length,
      orphanCount: orphanNodes.length,
      status,
    },
  };
}
