import { GraphEdge, GraphNode, LevelOfDetail } from "../types.js";
import { filterHubNodes } from "./pagerank.js";

export class GraphVisualizer {
  private sanitizeId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, "_");
  }

  private sanitizeLabel(label: string): string {
    return label.replace(/["\n\r[\]()]/g, " ").trim();
  }

  /**
   * Render Mermaid Flowchart diagram
   */
  public renderMermaid(
    nodes: GraphNode[],
    edges: GraphEdge[],
    lod: LevelOfDetail = LevelOfDetail.LOD0_MACRO
  ): string {
    if (nodes.length === 0) {
      return "```mermaid\ngraph LR\n    Empty[\"No entities found\"]\n```";
    }

    let displayNodes = nodes;
    let displayEdges = edges;
    let omittedCount = 0;

    if (lod === LevelOfDetail.LOD0_MACRO && nodes.length > 12) {
      const filtered = filterHubNodes(nodes, edges, 10);
      displayNodes = filtered.hubNodes;
      displayEdges = filtered.hubEdges;
      omittedCount = filtered.otherCount;
    } else if (lod === LevelOfDetail.LOD1_MESO && nodes.length > 25) {
      const filtered = filterHubNodes(nodes, edges, 20);
      displayNodes = filtered.hubNodes;
      displayEdges = filtered.hubEdges;
      omittedCount = filtered.otherCount;
    }

    const lines: string[] = ["```mermaid", "graph TD"];

    // Nodes definition
    for (const node of displayNodes) {
      const safeId = this.sanitizeId(node.id);
      const safeLabel = this.sanitizeLabel(`${node.label} [${node.node_type}]`);

      switch (node.node_type) {
        case "data_model":
          lines.push(`    ${safeId}[("${safeLabel}")]`);
          break;
        case "api_endpoint":
          lines.push(`    ${safeId}{{"${safeLabel}"}}`);
          break;
        case "decision":
        case "rule":
          lines.push(`    ${safeId}>"${safeLabel}"]`);
          break;
        case "person":
          lines.push(`    ${safeId}(("${safeLabel}"))`);
          break;
        default:
          lines.push(`    ${safeId}["${safeLabel}"]`);
          break;
      }
    }

    // Edges definition
    const renderedEdges = new Set<string>();
    for (const edge of displayEdges) {
      const srcId = this.sanitizeId(edge.source_id);
      const tgtId = this.sanitizeId(edge.target_id);
      const key = `${srcId}->${tgtId}:${edge.relation_type}`;

      if (!renderedEdges.has(key)) {
        renderedEdges.add(key);
        const relLabel = edge.relation_type;
        lines.push(`    ${srcId} -->|${relLabel}| ${tgtId}`);
      }
    }

    if (omittedCount > 0) {
      lines.push(`    MoreSubsystem["+ ${omittedCount} other components (use kb_graph_explore)"]:::dimmed`);
      lines.push("    classDef dimmed fill:#eee,stroke:#999,stroke-dasharray: 5 5");
    }

    lines.push("```");
    return lines.join("\n");
  }

  /**
   * Compact outline for agents: type counts, then only the most central nodes and the links among them.
   * Everything else is one line pointing at kb_search / kb_graph_explore, so size stays flat as the graph grows.
   */
  public renderOutline(
    nodes: GraphNode[],
    edges: GraphEdge[],
    title: string = "Topology Overview",
    topK: number = 15
  ): string {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.node_type, (counts.get(n.node_type) ?? 0) + 1);
    const lines: string[] = [
      `### ${title}`,
      `${nodes.length} nodes, ${edges.length} links: ${[...counts].map(([t, c]) => `${t} ${c}`).join(", ")}`,
      "",
    ];

    const { hubNodes, hubEdges, otherCount } = filterHubNodes(nodes, edges, topK);
    const clip = (t: string) => (t.length > 90 ? t.slice(0, 90).trimEnd() + "…" : t);
    for (const n of hubNodes) lines.push(`- \`${n.id}\` [${n.node_type}] ${n.label} — ${clip(n.summary)}`);
    if (otherCount > 0) lines.push(`+${otherCount} more (kb_search, kb_graph_explore)`);

    if (hubEdges.length > 0) {
      lines.push("", "Links:");
      for (const e of hubEdges.slice(0, 12)) lines.push(`- \`${e.source_id}\` -${e.relation_type}-> \`${e.target_id}\``);
      if (hubEdges.length > 12) lines.push(`+${hubEdges.length - 12} more links`);
    }

    return lines.join("\n");
  }
}

export const visualizer = new GraphVisualizer();
