import { Tool } from "@modelcontextprotocol/sdk/types.js";

export const ALL_TOOLS: Tool[] = [
  // 0. Project Workspace Management
  {
    name: "kb_project_create",
    description:
      "Creates a project workspace with a root hub node.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Unique slug, e.g. 'core-banking'",
        },
        name: {
          type: "string",
          description: "Display name",
        },
        description: {
          type: "string",
          description: "Purpose and architecture",
        },
        domain: {
          type: "string",
          default: "general",
          description: "e.g. 'finance', 'general'",
        },
      },
      required: ["project_id", "name"],
    },
  },

  {
    name: "kb_project_list",
    description:
      "Lists projects (id, name, counts). Call once per session to get the project_id the other tools need.",
    inputSchema: { type: "object", properties: {} },
  },

  // 1. Graph Navigation & Architecture
  {
    name: "kb_graph_overview",
    description:
      "Overview of a project's key hubs (Mermaid or outline). lod 0 = top ~10 hubs, 1 = top ~20. Small by design.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        lod: {
          type: "number",
          enum: [0, 1],
          default: 0,
          description: "0 = macro, 1 = more hubs",
        },
        format: {
          type: "string",
          enum: ["mermaid", "summary"],
          default: "mermaid",
        },
      },
      required: ["project_id"],
    },
  },
  {
    name: "kb_graph_explore",
    description:
      "Nodes within 1-2 hops of a node: what it depends on, what uses it, governing rules.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        depth: {
          type: "number",
          minimum: 1,
          maximum: 2,
          default: 1,
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "kb_graph_impact",
    description:
      "Everything that depends, directly or transitively, on a node: what breaks if it changes.",
    inputSchema: {
      type: "object",
      properties: {
        target_node_id: {
          type: "string",
          description: "Node ID",
        },
      },
      required: ["target_node_id"],
    },
  },

  // 2. Ingestion & Self-Expansion
  {
    name: "kb_classify_document",
    description:
      "Predicts domain and document type for a file or text, without ingesting.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path" },
        text: { type: "string", description: "Text, if no file_path" },
        file_name: { type: "string", description: "File name hint" },
      },
    },
  },
  {
    name: "kb_ingest_file",
    description:
      "Indexes one file (pdf, docx, md, ts, js, py, json, sql) into the graph. Re-indexing replaces the old version.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        file_path: { type: "string" },
        domain: {
          type: "string",
          default: "auto",
          description: "e.g. auth, billing; 'auto' classifies from content",
        },
      },
      required: ["project_id", "file_path"],
    },
  },
  {
    name: "kb_batch_ingest_directory",
    description:
      "Indexes a folder recursively; unchanged files are skipped by hash.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        dir_path: { type: "string" },
        extensions: {
          type: "array",
          items: { type: "string" },
          description: "e.g. ['.pdf', '.ts']",
        },
        force: { type: "boolean", description: "Re-index unchanged files too" },
        ignore: { type: "array", items: { type: "string" }, description: "Extra skip patterns" },
      },
      required: ["project_id", "dir_path"],
    },
  },
  {
    name: "kb_resolve_library",
    description:
      "Locates a 3rd-party library/package imported by a project. If auto_ingest is true (default), automatically creates a library project, batch ingests from package cache (.pub-cache or node_modules), and links it to project_id. If false, returns redirection info and paths.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project requiring the library, e.g. 'budgetable-v2'" },
        library_name: { type: "string", description: "Package name, e.g. 'flutter_bloc', 'go_router', 'objectbox'" },
        auto_ingest: { type: "boolean", default: true, description: "Auto-create project, ingest files, and link for joint search" },
      },
      required: ["project_id", "library_name"],
    },
  },
  {
    name: "kb_prune_libraries",
    description:
      "Garbage collects orphaned or stale 3rd-party library graphs (no project links to them, or source deleted from disk). Optionally executes SQLite VACUUM to reclaim disk space.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: { type: "boolean", default: false, description: "Preview which libraries would be pruned without deleting" },
        vacuum: { type: "boolean", default: true, description: "Reclaim physical disk space using SQLite VACUUM" },
      },
    },
  },
  {
    name: "kb_add_node",
    description:
      "Adds a concept, decision, rule or endpoint learned during the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        id: { type: "string", description: "Slug, e.g. 'rule:jwt_expiry'" },
        label: { type: "string" },
        node_type: {
          type: "string",
          enum: [
            "project",
            "module",
            "service",
            "component",
            "api_endpoint",
            "data_model",
            "env_config",
            "decision",
            "rule",
            "person",
            "policy",
            "process",
            "template",
          ],
        },
        summary: { type: "string", description: "1-2 sentences" },
        domain: { type: "string", default: "general" },
        links_to: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target_id: { type: "string" },
              relation: { type: "string", description: "Relation type, as in kb_add_relation" },
              description: { type: "string" },
            },
            required: ["target_id", "relation"],
          },
          description: "Links to existing nodes",
        },
      },
      required: ["project_id", "id", "label", "node_type", "summary"],
    },
  },
  {
    name: "kb_add_relation",
    description:
      "Links two existing nodes.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        source_id: { type: "string" },
        target_id: { type: "string" },
        relation_type: {
          type: "string",
          enum: [
            "DEPENDS_ON",
            "CALLS",
            "STORES_IN",
            "GOVERNED_BY",
            "CONFIGURED_BY",
            "OWNED_BY",
            "AFFECTS",
            "REQUIRES",
            "APPLIES_TO",
            "APPROVED_BY",
            "SUPERSEDES",
            "REFERENCES",
          ],
        },
        description: { type: "string" },
      },
      required: ["project_id", "source_id", "target_id", "relation_type"],
    },
  },
  {
    name: "kb_flag_gap",
    description:
      "Records missing knowledge (e.g. undocumented API) for the user or other agents.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        missing_item: { type: "string", description: "Identifier of missing component" },
        reason: { type: "string", description: "Why this data is required" },
        suggested_action: { type: "string", description: "Action to resolve the gap" },
      },
      required: ["project_id", "missing_item", "reason"],
    },
  },
  {
    name: "kb_audit_gaps",
    description:
      "Finds dangling references and missing documents in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
      required: ["project_id"],
    },
  },

  // 3. Query & Telemetry
  {
    name: "kb_node_get",
    description:
      "One node's details; include_raw adds the source excerpt.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "ID of the node to retrieve" },
        include_raw: {
          type: "boolean",
          default: false,
          description: "Add source excerpt",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "kb_file_outline",
    description: "Symbols of one file with lines and signatures; use instead of reading a large file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path or suffix, e.g. 'engine/persist.ts'" },
        project_id: { type: "string" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "kb_sync",
    description: "Re-index edited files, drop deleted ones; dir_path also adds new files.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        dir_path: { type: "string", description: "Also index new files here" },
        ignore: { type: "array", items: { type: "string" }, description: "Extra skip patterns" },
      },
      required: ["project_id"],
    },
  },
  {
    name: "kb_search",
    description:
      "Use first to find where something is implemented or how it works, instead of grep. Plain-words query; ranked hits carry id and path:line. code=12 adds source for the top 2, so no follow-up read.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project_id: { type: "string" },
        limit: { type: "number", default: 5 },
        code: { type: "number", description: "Source lines for the top 2 hits (12 is usually enough); saves a follow-up read" },
        max_tokens: { type: "number", description: "Cap response size" },
        auto_ingest_lib: { type: "boolean", default: false, description: "Auto-ingest matching 3rd-party library if query misses" },
      },
      required: ["query"],
    },
  },
  {
    name: "kb_stats",
    description:
      "Counts per type and domain, top hubs.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
      },
    },
  },
  {
    name: "kb_metrics",
    description:
      "Latency, token savings and RAM of this server.",
    inputSchema: {
      type: "object",
      properties: {
        reset: { type: "boolean", default: false },
      },
    },
  },
];

// Read-only tools can be auto-approved by MCP clients
export const READ_ONLY_TOOLS = new Set(["kb_classify_document", "kb_project_list", "kb_graph_overview", "kb_graph_explore", "kb_graph_impact", "kb_audit_gaps", "kb_node_get", "kb_search", "kb_file_outline", "kb_stats"]);
for (const tool of ALL_TOOLS) {
  tool.annotations = { ...tool.annotations, readOnlyHint: READ_ONLY_TOOLS.has(tool.name) };
}

/**
 * Tool definitions are re-sent to the model every session. KB_TOOLSET=read exposes only the
 * read-only tools (about a third of the tokens); indexing and editing then happen via the web UI/CLI.
 */
export function activeTools(): Tool[] {
  return process.env.KB_TOOLSET === "read" ? ALL_TOOLS.filter((t) => READ_ONLY_TOOLS.has(t.name)) : ALL_TOOLS;
}
