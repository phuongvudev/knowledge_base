# Claude Instructions for Knowledge Base MCP

## 1. Claude Code CLI (`~/.claude/CLAUDE.md` & `~/.claude/settings.json`)
Với **Claude Code CLI**, lưu nội dung bên dưới vào `~/.claude/CLAUDE.md` (Global User Memory) và thêm `"permissions": { "allow": ["mcp__knowledge-base__*"] }` vào `~/.claude/settings.json` để Claude gọi trực tiếp không cần hỏi quyền từng lần.

## 2. Claude Desktop ("Custom Instructions" / "Project Instructions")
Dán nội dung dưới đây vào **Custom Instructions** hoặc `~/.claude/CLAUDE.md`:

```markdown
# Neural Knowledge Base Mandatory Operating Protocol

> **CRITICAL RULE**: The `knowledge-base` MCP server is the PRIMARY sensory system for all indexed workspaces. Blind filesystem inspection (`Grep`, `Glob`, full-file `Read`) wastes 80–90% of the context window. Follow this protocol strictly on EVERY prompt:

## 0. Direct Tool Reference (Zero-Setup Invocation)
You do NOT need to call `kb_project_list` first if you know the workspace folder name — `project_id` automatically normalizes `_` and `-` (e.g., `"budgetable_v2"` <-> `"budgetable-v2"`).
- **`kb_search`**: `{"query": string, "project_id"?: string, "code"?: number (use 12), "limit"?: number (default 5)}`
- **`kb_file_outline`**: `{"file_path": string, "project_id"?: string}` (accepts full path or suffix like `"engine/telemetry.ts"`)
- **`kb_graph_impact`**: `{"target_node_id": string}` (accepts class/function name like `"TelemetryEngine"`, file path like `"src/engine/telemetry.ts"`, or node ID)
- **`kb_node_get`**: `{"node_id": string, "include_raw"?: boolean}` (accepts symbol name, file path, or node ID)
- **`kb_sync`**: `{"project_id": string, "dir_path"?: string}`
- **`kb_add_node`**: `{"project_id": string, "id": string, "label": string, "node_type": "decision"|"rule"|"concept"|"component", "summary": string, "domain"?: string}`
- **`kb_resolve_library`**: `{"project_id": string, "library_name": string, "auto_ingest"?: boolean}`

## 1. Zero-Blind-Search Protocol (MANDATORY)
- **NEVER** run `Grep`, `Glob`, `find`, or `rg` blindly as your first step to locate code, features, classes, business flows, or bugs.
- **ALWAYS** call `kb_search(query, project_id, code=12)` FIRST. Plain natural-language queries (English or Vietnamese) return ranked semantic hits with exact `file_path:line` and 12-line source excerpts in <500 tokens.
- Only fall back to `Grep`/`Glob` if `kb_search` explicitly returns 0 matches or when doing exhaustive literal string replacement.

## 2. Large File Protection Protocol
- **NEVER** call `Read` on whole files (>100 lines) without knowing the exact line range.
- **ALWAYS** call `kb_file_outline(file_path)` (or `kb_search` with `code=12`) to inspect symbols, signatures, and line numbers first, then read only the specific line range needed.

## 3. Pre-Modification Impact Protocol
- Before modifying or refactoring ANY existing function, class, interface, repository, or data model, **ALWAYS** execute `kb_graph_impact(target_node_id)` (pass the symbol name, file path, or node ID directly) to identify all downstream callers, UI screens, and unit tests that could break.

## 4. Third-Party Dependency Protocol
- When inspecting or debugging code from an external package (e.g. `flutter_bloc`, `go_router`, `objectbox`, `equatable`), **ALWAYS** call `kb_resolve_library(project_id, library_name, auto_ingest=true)` instead of inspecting `.pub-cache`/`node_modules` manually.

## 5. Continuous Knowledge Synchronization
- After modifying or creating code files, call `kb_sync(project_id)` to keep the neural graph up to date.
- Record new architectural decisions or business rules immediately via `kb_add_node`.
```
