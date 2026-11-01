import { GraphEdge, GraphNode } from "../types.js";
import { computeCentrality, NodeCentrality } from "./pagerank.js";

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

  const isBarrelOrDi = (n?: GraphNode) => {
    if (!n) return false;
    if (n.node_type === "module" && n.summary.includes("no recognised definitions")) return true;
    const fp = (n.properties?.file_path as string | undefined) || "";
    return /(^|\/)(di\/injection|injection_container)\.[a-z0-9]+$/i.test(fp);
  };

  for (const e of edges) {
    const rel = e.relation_type?.toUpperCase() || "DEPENDS_ON";
    if (structuralTypes.has(rel) || !e.relation_type) {
      const srcNode = nodeMap.get(e.source_id);
      const tgtNode = nodeMap.get(e.target_id);
      if (isBarrelOrDi(srcNode) || isBarrelOrDi(tgtNode)) continue;
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

    // Ignore 2-node cycles between sibling files in the exact same directory (co-located module pair)
    if (elements.length === 2) {
      const fA = nodeMap.get(elements[0])?.properties?.file_path as string | undefined;
      const fB = nodeMap.get(elements[1])?.properties?.file_path as string | undefined;
      if (fA && fB) {
        const dirA = fA.slice(0, fA.lastIndexOf("/"));
        const dirB = fB.slice(0, fB.lastIndexOf("/"));
        if (dirA && dirA === dirB) continue;
      }
    }

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

const ENTRYPOINT_FILE = /(^|\/)(index|main|app|server|runner|watcher|cli|setup|installer|benchmark|ab_bench|selftest[^/]*|page|layout|route|next\.config|postcss\.config|tailwind\.config|eslint\.config)\.[a-z0-9]+$|(\.test\.|\.spec\.|_test\.)|\.(json|ya?ml|sql|dockerfile)$|(^|\/)(tool|tools|scripts|production|example|examples|ephemeral|android|ios)\//i;

/**
 * Detects orphan / dead nodes (no incoming references)
 */
export function detectOrphanNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  existingCentrality?: Map<string, NodeCentrality>
): OrphanNode[] {
  const centrality = existingCentrality || computeCentrality(nodes, edges);
  const orphans: OrphanNode[] = [];

  for (const n of nodes) {
    // Ignore top-level project root, external packages, placeholders, docs/rules, services, persons, or env configs
    if (
      n.properties?.is_project_root ||
      n.properties?.is_external ||
      n.properties?.placeholder ||
      n.node_type === "service" ||
      n.node_type === "person" ||
      n.node_type === "env_config" ||
      n.node_type === "policy" ||
      n.node_type === "rule" ||
      n.node_type === "general" ||
      n.node_type === "template" ||
      n.node_type === "api_endpoint" ||
      n.id.startsWith("project:") ||
      n.id.startsWith("doc:")
    ) {
      continue;
    }

    const filePath = (n.properties?.file_path as string | undefined) || "";
    if (n.node_type === "module" && filePath && ENTRYPOINT_FILE.test(filePath)) {
      continue;
    }

    const cent = centrality.get(n.id);
    if (cent && cent.inDegree === 0) {
      orphans.push({
        id: n.id,
        label: n.label,
        node_type: n.node_type,
        summary: n.summary,
        file_path: filePath || undefined,
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
  edges: GraphEdge[],
  existingCentrality?: Map<string, NodeCentrality>
): ArchitectureAuditReport {
  const cycles = detectCircularDependencies(nodes, edges);
  const orphanNodes = detectOrphanNodes(nodes, edges, existingCentrality);

  // Compute Health Score (100 is perfect), scaled by project size
  const cycleWeight = nodes.length > 500 ? 3 : nodes.length > 100 ? 6 : 10;
  const cyclePenalty = Math.min(60, cycles.length * cycleWeight);
  const orphanPenalty = Math.min(25, Math.floor(orphanNodes.length / 5));
  const penalty = cyclePenalty + orphanPenalty;
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));

  let status: "healthy" | "warning" | "critical" = "healthy";
  if (healthScore < 60) {
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
