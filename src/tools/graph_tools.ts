import { DatabaseInstance } from "../database.js";
import { linkedProjects } from "../engine/deps.js";
import { graphMemory } from "../engine/graph_memory.js";
import { visualizer } from "../engine/visualizer.js";
import { telemetry } from "../engine/telemetry.js";
import { auditArchitecture } from "../engine/diagnostics.js";
import {
  AuditArchitectureSchema,
  CreateProjectSchema,
  GraphExploreSchema,
  GraphImpactSchema,
  GraphOverviewSchema,
  LevelOfDetail,
} from "../types.js";

export async function handleGraphTool(
  name: string,
  args: any,
  db: DatabaseInstance
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const startTime = process.hrtime.bigint();
  graphMemory.syncIfStale(db);

  if (name === "kb_project_create") {
    const { project_id, name: projName, description, domain } = CreateProjectSchema.parse(args);

    const insertProject = db.prepare(`
      INSERT INTO projects (id, name, description, domain)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        domain = excluded.domain,
        updated_at = CURRENT_TIMESTAMP
    `);
    insertProject.run(project_id, projName, description || null, domain || "general");

    // Also register an anchor hub node so the project is immediately graphable
    const rootNodeId = `project:${project_id}`;
    const insertNode = db.prepare(`
      INSERT INTO graph_nodes (id, project_id, label, node_type, summary, domain, properties, is_hub)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        summary = excluded.summary,
        domain = excluded.domain,
        updated_at = CURRENT_TIMESTAMP
    `);

    const summary = description || `Project root workspace for ${projName}`;
    insertNode.run(
      rootNodeId,
      project_id,
      projName,
      "service",
      summary,
      domain || "general",
      JSON.stringify({ is_project_root: true })
    );

    graphMemory.addNodeMemory({
      id: rootNodeId,
      project_id,
      label: projName,
      node_type: "service",
      summary,
      domain: domain || "general",
      properties: { is_project_root: true },
      is_hub: true,
    });

    const output = [
      `### Project Workspace Created: **${projName}** (\`${project_id}\`)`,
      `- **Domain:** ${domain || "general"}`,
      `- **Root Anchor Hub:** \`${rootNodeId}\``,
      description ? `- **Description:** ${description}` : "",
      "",
      `The project space is now active and ready. You can now ingest code repositories using \`kb_batch_ingest_directory\` or documents via \`kb_ingest_file\`.`,
    ].filter(Boolean).join("\n");

    return {
      content: [{ type: "text", text: output }],
    };
  }

  if (name === "kb_project_list") {
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.domain, p.description,
           (SELECT COUNT(*) FROM graph_nodes WHERE project_id = p.id) AS nodes,
           (SELECT COUNT(*) FROM graph_edges WHERE project_id = p.id) AS edges
         FROM projects p ORDER BY p.id`
      )
      .all() as any[];

    const lines = [`### Projects (${rows.length})`, ""];
    if (rows.length === 0) lines.push("No projects yet. Create one with `kb_project_create`.");
    for (const r of rows) {
      lines.push(
        `- \`${r.id}\` — **${r.name}** [${r.domain}] · ${r.nodes} nodes, ${r.edges} edges${
          r.description ? `: ${r.description}` : ""
        }${linkedProjects(db, r.id).length ? ` · also searches: ${linkedProjects(db, r.id).join(", ")}` : ""}`
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (name === "kb_graph_overview") {
    const { project_id, lod, format } = GraphOverviewSchema.parse(args);

    const tDbStart = process.hrtime.bigint();
    const nodes = graphMemory.getProjectNodes(project_id);
    const edges = graphMemory.getProjectEdges(project_id);
    const dbDuration = Number(process.hrtime.bigint() - tDbStart) / 1_000_000;

    const tGraphStart = process.hrtime.bigint();
    const centrality = graphMemory.getCentrality(project_id);
    let rendered = "";
    if (format === "mermaid") {
      rendered = visualizer.renderMermaid(
        nodes,
        edges,
        lod === 0 ? LevelOfDetail.LOD0_MACRO : LevelOfDetail.LOD1_MESO,
        centrality
      );
    } else {
      rendered = visualizer.renderOutline(nodes, edges, `Project [${project_id}] Topology`, 15, centrality);
    }
    const graphDuration = Number(process.hrtime.bigint() - tGraphStart) / 1_000_000;

    // Realistic baseline: scanning top module/hub summaries (up to 60 modules), not reading every single symbol in a 4,000-node monorepo
    const baselineNodes = nodes.filter((n) => n.node_type === "module" || n.is_hub).slice(0, 60);
    const rawEquivalent = (baselineNodes.length > 0 ? baselineNodes : nodes.slice(0, 60))
      .map((n) => `${n.label}: ${n.summary}`)
      .join("\n");
    const { footer } = telemetry.record(
      name,
      startTime,
      dbDuration,
      graphDuration,
      rendered,
      rawEquivalent
    );

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_graph_explore") {
    const { node_id, depth, project_id } = GraphExploreSchema.parse(args);

    const tGraphStart = process.hrtime.bigint();
    let center = graphMemory.resolveNode(node_id, project_id);
    if (!center) {
      const suggestions = graphMemory.suggestNodes(node_id, project_id, 3);
      if (suggestions.length === 1) {
        center = suggestions[0];
      } else {
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.map((s) => `\`${s.id}\` (${s.label})`).join(", ")}?` : "";
        return {
          content: [{ type: "text", text: `Node '${node_id}' not found in knowledge graph.${hint}` }],
          isError: true,
        };
      }
    }

    const { nodes, edges } = graphMemory.getRadialSubgraph(center.id, depth, 15);
    const graphDuration = Number(process.hrtime.bigint() - tGraphStart) / 1_000_000;

    const lines: string[] = [
      `### Subgraph: ${center.label} (\`${center.id}\`)`,
      `**Type:** ${center.node_type} | **Domain:** ${center.domain}`,
      `**Summary:** ${center.summary}`,
      "",
      "**Immediate Neural Neighbors & Relations:**",
    ];

    for (const edge of edges) {
      const isOutbound = edge.source_id === center.id;
      const otherId = isOutbound ? edge.target_id : edge.source_id;
      const otherNode = graphMemory.getNode(otherId);
      const otherLabel = otherNode ? otherNode.label : otherId;

      if (isOutbound) {
        lines.push(
          `- --[${edge.relation_type}]--> \`${otherId}\` (${otherLabel})${
            edge.description ? `: ${edge.description}` : ""
          }`
        );
      } else {
        lines.push(
          `- <--[${edge.relation_type}]-- \`${otherId}\` (${otherLabel})${
            edge.description ? `: ${edge.description}` : ""
          }`
        );
      }
    }

    const rendered = lines.join("\n");
    // Realistic baseline: grepping + inspecting ~300 tokens (1200 chars) per neighbor file (capped at 6 files)
    const rawEquivalent = "x".repeat(Math.min(Math.max(nodes.length, 2), 6) * 1200);
    const { footer } = telemetry.record(
      name,
      startTime,
      null,
      graphDuration,
      rendered,
      rawEquivalent
    );

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_graph_impact") {
    const { target_node_id, project_id } = GraphImpactSchema.parse(args);

    const tGraphStart = process.hrtime.bigint();
    let targetNode = graphMemory.resolveNode(target_node_id, project_id);
    if (!targetNode) {
      const suggestions = graphMemory.suggestNodes(target_node_id, project_id, 3);
      if (suggestions.length === 1) {
        targetNode = suggestions[0];
      } else {
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.map((s) => `\`${s.id}\` (${s.label})`).join(", ")}?` : "";
        return {
          content: [{ type: "text", text: `Node '${target_node_id}' not found in knowledge graph.${hint}` }],
          isError: true,
        };
      }
    }

    const { affectedNodes, paths } = graphMemory.getImpactSubgraph(targetNode.id);
    const graphDuration = Number(process.hrtime.bigint() - tGraphStart) / 1_000_000;

    const MAX_SHOWN_NODES = 20;
    const shownNodes = affectedNodes.slice(0, MAX_SHOWN_NODES);

    const filePaths = shownNodes
      .map((n) => n.properties?.file_path as string | undefined)
      .filter(Boolean) as string[];
    let root = filePaths.length ? filePaths[0].slice(0, filePaths[0].lastIndexOf("/") + 1) : "";
    for (const p of filePaths) {
      while (root && !p.startsWith(root)) {
        root = root.slice(0, root.slice(0, -1).lastIndexOf("/") + 1);
      }
    }

    const lines: string[] = [
      `### Impact Analysis: \`${targetNode.id}\` (${targetNode.label}) — **${affectedNodes.length}** dependents`,
    ];
    if (root) lines.push(`paths relative to ${root}`);

    if (affectedNodes.length === 0) {
      lines.push("No downstream dependencies found. Safe to modify or refactor.");
    } else {
      lines.push("**Affected Downstream Entities:**");
      for (const node of shownNodes) {
        const typeTag = node.id.startsWith(node.node_type + ":") ? "" : ` [${node.node_type}]`;
        const fp = node.properties?.file_path as string | undefined;
        const relFp = fp ? (root && fp.startsWith(root) ? fp.slice(root.length) : fp) : "";
        const loc = relFp ? ` → ${relFp}${node.properties?.line ? `:${node.properties.line}` : ""}` : "";
        let sum = node.summary.replace(/\s+/g, " ").trim();
        if (sum.toLowerCase().startsWith(node.label.toLowerCase())) {
          sum = sum.slice(node.label.length).replace(/^[\s:—-]+/, "");
        }
        if (sum.length > 85) sum = sum.slice(0, 84) + "…";
        lines.push(`- \`${node.id}\`${typeTag}: ${node.label}${sum ? ` — ${sum}` : ""}${loc}`);
      }
      if (affectedNodes.length > MAX_SHOWN_NODES) {
        lines.push(`... +${affectedNodes.length - MAX_SHOWN_NODES} more transitive dependents omitted.`);
      }
      lines.push("");
      lines.push("**Dependency Chains:**");
      for (const path of paths.slice(0, 10)) {
        lines.push(`- \`${path.source_id}\` --[${path.relation_type}]--> \`${path.target_id}\``);
      }
    }

    const rendered = lines.join("\n");
    // Realistic baseline: without impact graph, agent runs multiple grep + read_file passes (~400 tokens / 1600 chars per affected caller, capped at 8 files)
    const rawEquivalent = "x".repeat(Math.min(Math.max(affectedNodes.length, 1), 8) * 1600);
    const { footer } = telemetry.record(
      name,
      startTime,
      null,
      graphDuration,
      rendered,
      rawEquivalent
    );

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_audit_architecture") {
    const { project_id } = AuditArchitectureSchema.parse(args);
    const nodes = graphMemory.getProjectNodes(project_id);
    const edges = graphMemory.getProjectEdges(project_id);
    const centrality = graphMemory.getCentrality(project_id);
    const report = auditArchitecture(project_id, nodes, edges, centrality);

    const lines = [
      `### Architecture Health Audit: **${project_id}**`,
      `- **Health Score:** ${report.healthScore}/100 [${report.summary.status.toUpperCase()}]`,
      `- **Components:** ${report.totalNodes} nodes, ${report.totalEdges} relationships`,
      `- **Circular Dependencies:** ${report.summary.cycleCount}`,
      `- **Orphan Components:** ${report.summary.orphanCount}`,
      "",
    ];

    if (report.cycles.length > 0) {
      lines.push("**Circular Dependencies Detected:**");
      for (const c of report.cycles.slice(0, 5)) {
        lines.push(`- Cycle (length ${c.cycleLength}): \`${c.path.join(" -> ")}\``);
      }
      if (report.cycles.length > 5) lines.push(`+${report.cycles.length - 5} more cycles`);
      lines.push("");
    }

    if (report.orphanNodes.length > 0) {
      lines.push("**Potential Orphan / Dead Components:**");
      for (const o of report.orphanNodes.slice(0, 8)) {
        lines.push(`- \`${o.id}\` [${o.node_type}] ${o.label}${o.file_path ? ` (${o.file_path})` : ""}`);
      }
      if (report.orphanNodes.length > 8) lines.push(`+${report.orphanNodes.length - 8} more orphans`);
    }

    const rendered = lines.join("\n");
    const { footer } = telemetry.record(name, startTime, null, null, rendered, report.project_id);
    return { content: [{ type: "text", text: rendered + footer }] };
  }

  return null;
}
