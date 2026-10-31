# Neural Knowledge Base Guidelines

Knowledge base (MCP `knowledge-base`): use it BEFORE grep/glob/reading files to find code or learn how something works.
1. Locate: kb_search(query, project_id, code=12). Ask in plain words ("where token savings are computed"), not regex. Each hit has id + path:line: open that line, don't read whole files.
2. project_id: call kb_project_list once per session. To see a file's contents at a glance use kb_file_outline(file_path) instead of reading it.
3. Before changing or removing a symbol: kb_graph_impact(node_id). Neighbours of a hit: kb_graph_explore(node_id).
4. Unfamiliar project: kb_graph_overview(project_id) first.
5. No hits, or project not indexed: use grep, then kb_ingest_file / kb_batch_ingest_directory so the next search works. If a hit's path:line looks stale, trust the file and run kb_sync(project_id) after editing code.
6. Persist user decisions and conventions with kb_add_node; report missing pieces with kb_flag_gap.
