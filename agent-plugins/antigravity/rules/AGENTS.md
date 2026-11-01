# Neural Knowledge Base Mandatory Operating Protocol

> **CRITICAL RULE**: The Knowledge Base MCP (`ServerName: "knowledge-base_knowledge-base"`) is the PRIMARY sensory system for this workspace. Blind filesystem inspection wastes 90%+ context window. Follow this protocol strictly on EVERY prompt.

## 0. Zero-Turn Direct Invocation Schema (NO `.json` schema read needed!)
You already have the complete schemas below — call `call_mcp_tool` **DIRECTLY on Turn 1** without calling `read_file` on `<appDataDir>/mcp/knowledge-base_knowledge-base/*.json`:
- **`kb_search`**: `{"query": string, "project_id"?: string, "code"?: number (default 12), "limit"?: number (default 5)}`
- **`kb_file_outline`**: `{"file_path": string, "project_id"?: string}` (accepts full path or filename suffix, e.g. `"engine/telemetry.ts"`)
- **`kb_graph_impact`**: `{"target_node_id": string}` (accepts node ID, class/function name like `"TelemetryEngine"`, or file path like `"src/engine/telemetry.ts"`)
- **`kb_node_get`**: `{"node_id": string, "include_raw"?: boolean}` (accepts node ID, symbol name, or file path)
- **`kb_sync`**: `{"project_id": string, "dir_path"?: string}`
- **`kb_add_node`**: `{"project_id": string, "id": string, "label": string, "node_type": "decision"|"rule"|"concept"|"component", "summary": string, "domain"?: string}`
- **`kb_resolve_library`**: `{"project_id": string, "library_name": string, "auto_ingest"?: boolean}`

## 1. Zero-Blind-Search Protocol (MANDATORY)
- **NEVER** run `grep`, `find`, `rg`, `glob`, or bash search commands blindly to locate code, features, classes, or bugs.
- **ALWAYS** call `kb_search(query, project_id, code=12)` FIRST. It returns ranked semantic hits with exact `file_path:line` and 12-line source excerpts in <500 tokens (auto-normalizing `project_id` between `_` and `-`).
- Only fall back to terminal grep if `kb_search` explicitly returns 0 matches after synonym retry.

## 2. Large File Protection Protocol
- **NEVER** call `read_file` on whole files (>100 lines) without knowing the exact lines.
- **ALWAYS** call `kb_file_outline(file_path)` (or `kb_search` with `code=12`) to inspect symbols, signatures, and line numbers first, then only read the specific line range needed.

## 3. Pre-Modification Impact Protocol
- Before modifying or refactoring ANY existing function, class, data model, or file, **ALWAYS** execute `kb_graph_impact(target_node_id)` (you can pass the symbol name, file path, or node ID directly) to identify all downstream callers, UI screens, and tests that could break.

## 4. Third-Party Dependency Protocol
- When inspecting, debugging, or using code from an external package (e.g. `flutter_bloc`, `go_router`, `objectbox`, `equatable`), **DO NOT** search the web or inspect `.pub-cache`/`node_modules` manually.
- **ALWAYS** call `kb_resolve_library(project_id, library_name, auto_ingest=true)`. It auto-indexes and links the package graph for instant query in <300 tokens.

## 5. Continuous Knowledge Synchronization
- After modifying or creating new code files, call `kb_sync(project_id)` to keep the neural graph up to date.
- When establishing new architectural decisions or business rules during conversation, record them immediately via `kb_add_node`.
