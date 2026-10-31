#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { initDatabase } from "./database.js";
import { graphMemory } from "./engine/graph_memory.js";
import { telemetry } from "./engine/telemetry.js";
import { initUsage, recordCall } from "./engine/usage.js";
import { registerResources } from "./resources.js";
import { activeTools } from "./tools/index.js";
import { handleGraphTool } from "./tools/graph_tools.js";
import { handleIngestionTool } from "./tools/ingestion_tools.js";
import { handleQueryTool } from "./tools/query_tools.js";

async function main() {
  const db = initDatabase();

  // Hydrate in-memory graph cache from SQLite for <1ms traversal
  graphMemory.hydrate(db);
  telemetry.attach(db);
  initUsage(db);

  const server = new Server(
    {
      name: "neural-knowledge-base",
      version: "1.0.0",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
      instructions:
        "Knowledge base (MCP `knowledge-base`): use it BEFORE grep/glob/reading files to find code or learn how something works.\n" +
        "1. Locate: kb_search(query, project_id, code=12). Ask in plain words (\"where token savings are computed\"), not regex. Each hit has id + path:line: open that line, don't read whole files.\n" +
        "2. project_id: call kb_project_list once per session. To see a file's contents at a glance use kb_file_outline(file_path) instead of reading it.\n" +
        "3. Before changing or removing a symbol: kb_graph_impact(node_id). Neighbours of a hit: kb_graph_explore(node_id).\n" +
        "4. Unfamiliar project: kb_graph_overview(project_id) first.\n" +
        "5. No hits, or project not indexed: use grep, then kb_ingest_file / kb_batch_ingest_directory so the next search works. If a hit's path:line looks stale, trust the file and run kb_sync(project_id) after editing code.\n" +
        "6. Persist user decisions and conventions with kb_add_node; report missing pieces with kb_flag_gap.\n",
    }
  );

  // 1. Expose tool definitions to AI Clients
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: activeTools() };
  });

  // 2. Centralized Tool Execution Router
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    graphMemory.syncIfStale(db);
    const started = process.hrtime.bigint();

    try {
      if (!activeTools().some((t) => t.name === name)) throw new Error(`Unknown tool: ${name}`);
      const res =
        (await handleGraphTool(name, args, db)) ||
        (await handleIngestionTool(name, args, db)) ||
        (await handleQueryTool(name, args, db));

      if (res) {
        recordCall(db, name, args, started, res);
        return res;
      }
    } catch (err: any) {
      // Return tool errors to the model instead of failing the protocol call
      const msg = err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")
        : err?.message || String(err);
      const failure = { content: [{ type: "text", text: `Error in ${name}: ${msg}` }], isError: true };
      recordCall(db, name, args, started, failure);
      return failure;
    }

    recordCall(db, name, args, started, null);
    throw new Error(`Unknown tool: ${name}`);
  });

  // 3. Register Resources
  registerResources(server, db);

  // 4. Connect Stdio Transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[Neural Knowledge Base] Server running on stdio (Nodes: ${
      graphMemory.getAllNodes().length
    }, Edges: ${graphMemory.getAllEdges().length})`
  );
}

main().catch((err) => {
  console.error("[Fatal Error] in main():", err);
  process.exit(1);
});
