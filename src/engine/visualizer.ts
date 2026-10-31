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

  /**
   * Export graph topology as an Obsidian Canvas (.canvas) compatible JSON format
   */
  public renderObsidianCanvas(nodes: GraphNode[], edges: GraphEdge[]): string {
    const canvasNodes: any[] = [];
    const canvasEdges: any[] = [];

    // Arrange in a simple grid
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const nodeWidth = 260;
    const nodeHeight = 140;
    const gapX = 60;
    const gapY = 60;

    nodes.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = col * (nodeWidth + gapX);
      const y = row * (nodeHeight + gapY);

      canvasNodes.push({
        id: n.id,
        type: "text",
        text: `### [${n.node_type.toUpperCase()}] ${n.label}\n\n${n.summary}`,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight,
        color: n.is_hub ? "4" : "1",
      });
    });

    edges.forEach((e, idx) => {
      canvasEdges.push({
        id: `edge-${idx}`,
        fromNode: e.source_id,
        toNode: e.target_id,
        label: e.relation_type,
        toEnd: "arrow",
      });
    });

    return JSON.stringify({ nodes: canvasNodes, edges: canvasEdges }, null, 2);
  }

  /**
   * Export comprehensive project architecture report in Markdown
   */
  public renderMarkdownReport(
    projectId: string,
    projectName: string,
    nodes: GraphNode[],
    edges: GraphEdge[],
    auditSummary?: { healthScore: number; cycleCount: number; orphanCount: number; status: string }
  ): string {
    const counts = new Map<string, number>();
    for (const n of nodes) counts.set(n.node_type, (counts.get(n.node_type) ?? 0) + 1);

    const hubs = nodes.filter((n) => n.is_hub);
    const mermaid = this.renderMermaid(nodes, edges, LevelOfDetail.LOD0_MACRO);

    const lines = [
      `# 🏛️ Architecture Documentation: ${projectName} (\`${projectId}\`)`,
      `*Generated by Neural Knowledge Base Platform on ${new Date().toLocaleDateString("vi-VN")}*`,
      "",
      "## 1. Executive Summary",
      `- **Total Components / Nodes:** ${nodes.length}`,
      `- **Total Relationships / Edges:** ${edges.length}`,
      `- **Component Breakdown:** ${[...counts].map(([t, c]) => `\`${t}\`: ${c}`).join(", ")}`,
      auditSummary
        ? `- **Architecture Health Score:** **${auditSummary.healthScore}/100** (${auditSummary.status.toUpperCase()})`
        : "",
      auditSummary
        ? `- **Architectural Smells:** ${auditSummary.cycleCount} circular dependencies, ${auditSummary.orphanCount} potential orphan components.`
        : "",
      "",
      "## 2. Macro Topology Overview",
      mermaid,
      "",
      "## 3. Core Architectural Hubs",
      "| Type | Hub Identifier | Summary |",
      "|---|---|---|",
      ...hubs.map(
        (h) => `| \`${h.node_type}\` | **${h.label}** (\`${h.id}\`) | ${h.summary.replace(/\|/g, "\\|")} |`
      ),
      "",
      "## 4. Key Relationships",
      "| Source | Relation | Target |",
      "|---|---|---|",
      ...edges.slice(0, 30).map((e) => `| \`${e.source_id}\` | \`${e.relation_type}\` | \`${e.target_id}\` |`),
      edges.length > 30 ? `*...and ${edges.length - 30} more relationships.*` : "",
      "",
      "---",
      "*(Use Neural Knowledge Base MCP or Studio Web UI for interactive exploration)*",
    ];

    return lines.filter(Boolean).join("\n");
  }
}

export const visualizer = new GraphVisualizer();
