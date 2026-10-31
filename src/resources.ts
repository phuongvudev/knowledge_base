import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DatabaseInstance } from "./database.js";
import { graphMemory } from "./engine/graph_memory.js";
import { telemetry } from "./engine/telemetry.js";

export function registerResources(server: Server, db: DatabaseInstance): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: "kb://topology",
          name: "Global Knowledge Graph Topology",
          mimeType: "application/json",
          description: "All active graph nodes, hub assignments, and neural relationships.",
        },
        {
          uri: "kb://stats",
          name: "Knowledge Base Statistics",
          mimeType: "application/json",
          description: "Summary counts of nodes, edges, domains, and entity types.",
        },
        {
          uri: "kb://metrics",
          name: "Performance & Token Telemetry",
          mimeType: "application/json",
          description: "Real-time latency SLAs, token reduction percentage, and memory usage.",
        },
        {
          uri: "kb://gaps",
          name: "Open Knowledge Gaps",
          mimeType: "application/json",
          description: "List of missing specifications and dangling references flagged by agents.",
        },
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === "kb://topology") {
      const nodes = graphMemory.getAllNodes();
      const edges = graphMemory.getAllEdges();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ nodes, edges }, null, 2),
          },
        ],
      };
    }

    if (uri === "kb://stats") {
      const nodes = graphMemory.getAllNodes();
      const edges = graphMemory.getAllEdges();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                totalNodes: nodes.length,
                totalEdges: edges.length,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (uri === "kb://metrics") {
      const stats = telemetry.getStats(
        graphMemory.getAllNodes().length,
        graphMemory.getAllEdges().length
      );
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    if (uri === "kb://gaps") {
      const gaps = db.prepare(`SELECT * FROM knowledge_gaps WHERE status = 'open'`).all();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(gaps, null, 2),
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });
}
