import { DatabaseInstance } from "../database.js";
import { graphMemory } from "../engine/graph_memory.js";
import { computeCentrality } from "../engine/pagerank.js";
import { telemetry } from "../engine/telemetry.js";
import { depHint, linkedProjects, listDeps } from "../engine/deps.js";
import { FileOutlineSchema, MetricsSchema, NodeGetSchema, SearchSchema, StatsSchema } from "../types.js";

// Column weights: label and summary are what a person would search; the JSON properties blob is mostly paths
const BM25 = "bm25(nodes_fts, 2.0, 10.0, 0.5, 4.0, 0.2, 0.3)";
const tokTokens = (t: string) => Math.ceil(t.length / 4);

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "when", "where", "how", "what", "which", "who", "why", "from", "that",
  "this", "does", "not", "can", "has", "have", "into", "then", "than", "ra", "và", "của", "là", "các", "cho", "một",
  "những", "trong", "được", "khi", "nào", "sao", "thế",
]);

// Vietnamese phrases -> the English words code is written in (longest phrases first); "" drops filler
const VI_EN: Array<[RegExp, string]> = [
  [/ứng dụng|người dùng/giu, ""],
  [/ghi nhớ|lưu trữ|lưu lại|\blưu\b/giu, "store save persist remember"],
  [/đồng ý|chấp nhận|cho phép/giu, "consent accept allow"],
  [/dữ liệu/giu, "data"],
  [/\bgửi\b/giu, "send upload"],
  [/xác thực|đăng nhập/giu, "auth login authenticate"],
  [/đăng xuất/giu, "logout signout"],
  [/thông báo/giu, "notification notify alert"],
  [/hóa đơn|biên lai/giu, "receipt invoice bill"],
  [/ngân sách/giu, "budget"],
  [/giao dịch/giu, "transaction transfer payment"],
  [/tài khoản/giu, "account"],
  [/số dư/giu, "balance remaining"],
  [/chi tiêu|chi phí|khoản chi|\bchi\b/giu, "expense expenditure cost spend payout"],
  [/thu nhập|khoản thu|\bthu\b/giu, "income revenue earn"],
  [/danh mục|phân loại|\bloại\b/giu, "category classification type group"],
  [/tiền tệ|tiền|tiền mặt/giu, "currency money cash amount"],
  [/ví tiền|\bví\b/giu, "wallet balance purse"],
  [/tiết kiệm|mục tiêu/giu, "saving savings goal target"],
  [/khoản nợ|vay nợ|\bnợ\b/giu, "debt loan credit borrow lend liability"],
  [/định kỳ|lặp lại|chu kỳ/giu, "recurring periodic repeat interval schedule"],
  [/tính tổng|tổng cộng|\btổng\b/giu, "total sum calculate aggregate summary"],
  [/báo cáo|thống kê/giu, "report statistics analytics chart"],
  [/kho dữ liệu|kho lưu trữ|\bkho\b/giu, "repository repo store dao"],
  [/điều hướng|chuyển màn hình/giu, "router route navigation navigate"],
  [/xử lý|thực thi/giu, "handle handler process execute dispatch"],
  [/thực thể|mô hình dữ liệu/giu, "entity model schema dto"],
  [/trạng thái/giu, "status state flag condition"],
  [/thời gian|ngày tháng|hạn chót/giu, "date time timestamp deadline due"],
  [/ngân hàng/giu, "bank banking statement"],
  [/thử lại/giu, "retry"],
  [/mã hóa/giu, "encrypt encryption crypto"],
  [/bảo mật/giu, "security secret token password"],
  [/\blỗi\b|ngoại lệ/giu, "error exception failure fault"],
  [/cấu hình|thiết lập/giu, "config configuration settings setup"],
  [/đồng bộ/giu, "sync synchronize refresh"],
  [/xóa|hủy bỏ/giu, "delete remove discard cancel"],
  [/tìm kiếm|tra cứu/giu, "search query find lookup filter"],
  [/lọc|sắp xếp/giu, "filter sort order query"],
];
// Everyday words -> the terms code usually names them with; only used when the exact words found nothing
const SYNONYMS: Array<[RegExp, string]> = [
  [/\b(allowed|allowlist|whitelist|permitted|blocked|forbidden)\b/i, "policy check validate reject"],
  [/\b(servers?|calling|outbound)\b/i, "endpoint url request client api"],
  [/\b(remember|persist|saved?)\b/i, "store prefs localstorage db"],
  [/\b(credential|password|token)\b/i, "secret key auth jwt"],
  [/\b(wait|longer)\b/i, "backoff delay timeout debounce"],
  [/\b(consent|agreed?)\b/i, "accepted accept terms permission"],
  [/\b(shop|store|vendor|seller)\b/i, "merchant partner payee"],
  [/\b(calc|calculate|calculation|sum)\b/i, "compute total aggregate balance"],
  [/\b(error|fail|failed|failure)\b/i, "exception reject catch fault"],
];

// "path:line" an agent can open directly
function locationOf(node?: { properties?: Record<string, any> }): string | null {
  const p = node?.properties;
  if (!p?.file_path) return null;
  return p.line ? `${p.file_path}:${p.line}` : p.page ? `${p.file_path} (p.${p.page})` : p.file_path;
}

const TEST_PATH = /(^|\/)(tests?|testing|__tests__|integration_test)\/|[._]test\.|\.spec\./;
// "(foo bar)" appended at index time only so FTS can match spelled-out identifiers; the agent doesn't need it
const stripWords = (s: string) => s.replace(/ \([a-z0-9]+(?: [a-z0-9]+)+\)$/, "");

export async function handleQueryTool(
  name: string,
  args: any,
  db: DatabaseInstance
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const startTime = process.hrtime.bigint();

  const getNodeProvenanceStmt = db.prepare(`
    SELECT ns.*, rs.title, rs.file_path, rs.source_type, rs.content
    FROM node_sources ns
    JOIN raw_sources rs ON ns.source_id = rs.id
    WHERE ns.node_id = ?
    LIMIT 1
  `);

  if (name === "kb_node_get") {
    const { node_id, include_raw } = NodeGetSchema.parse(args);

    const node = graphMemory.getNode(node_id);
    if (!node) {
      return {
        content: [{ type: "text", text: `Node '${node_id}' not found.` }],
        isError: true,
      };
    }

    const lines: string[] = [
      `### ${node.label} (\`${node.id}\`)`,
      `- **Type:** ${node.node_type}`,
      `- **Domain:** ${node.domain}`,
      `- **Project:** ${node.project_id}`,
      `- **Summary:** ${node.summary}`,
    ];
    const where = locationOf(node);
    if (where) lines.push(`- **Location:** \`${where}\``);

    if (Object.keys(node.properties || {}).length > 0) {
      lines.push(`- **Properties:** \`${JSON.stringify(node.properties)}\``);
    }

    // 360-degree Call Graph & Dependencies
    const sub = graphMemory.getRadialSubgraph(node_id, 1, 15);
    const outbound = sub.edges.filter((e) => e.source_id === node_id);
    const inbound = sub.edges.filter((e) => e.target_id === node_id);

    if (outbound.length > 0) {
      lines.push("");
      lines.push("#### Outbound Dependencies (Calls/Uses):");
      for (const e of outbound.slice(0, 8)) {
        lines.push(`- -[${e.relation_type}]-> \`${e.target_id}\``);
      }
      if (outbound.length > 8) lines.push(`+${outbound.length - 8} more outbound links`);
    }

    if (inbound.length > 0) {
      lines.push("");
      lines.push("#### Inbound References (Called by):");
      for (const e of inbound.slice(0, 8)) {
        lines.push(`- <-[${e.relation_type}]- \`${e.source_id}\``);
      }
      if (inbound.length > 8) lines.push(`+${inbound.length - 8} more inbound links`);
    }

    let rawTextEquivalent = node.summary;

    if (include_raw) {
      const prov = getNodeProvenanceStmt.get(node_id) as any;
      if (prov) {
        lines.push("");
        lines.push("#### Provenance & Raw Source Excerpt:");
        lines.push(`- **Source File:** \`${prov.file_path || prov.title}\` (${prov.source_type})`);
        if (prov.page_number) lines.push(`- **Page:** ${prov.page_number}`);
        if (prov.section_title) lines.push(`- **Section:** ${prov.section_title}`);
        lines.push("");
        lines.push("```text");
        if (prov.content) {
          if (node.properties?.line) {
            const fileLines = prov.content.split("\n");
            const startLine = Math.max(1, node.properties.line - 3);
            const endLine = Math.min(fileLines.length, startLine + 30);
            lines.push(fileLines.slice(startLine - 1, endLine).join("\n"));
          } else {
            lines.push(prov.content.slice(0, 1000));
          }
        } else {
          lines.push("No raw content stored.");
        }
        lines.push("```");
        rawTextEquivalent = prov.content || "";
      }
    }

    const rendered = lines.join("\n");
    const { footer } = telemetry.record(
      name,
      startTime,
      null,
      null,
      rendered,
      rawTextEquivalent
    );

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_search") {
    const { query, project_id, limit, code, max_tokens } = SearchSchema.parse(args);

    // Keep unicode letters/digits (Vietnamese diacritics); quote each token so FTS operators can't break the query
    const viQuery = VI_EN.reduce((q, [re, en]) => q.replace(re, ` ${en} `), query);
    const all = viQuery.match(/[\p{L}\p{N}_]+/gu) || [];
    // Question words drown the real keywords once AND falls back to OR
    const content = all.filter((t) => t.length > 2 && !STOPWORDS.has(t.toLowerCase()));
    const tokens = content.length ? content : all;
    const extra = SYNONYMS.filter(([re]) => re.test(viQuery)).flatMap(([, add]) => add.split(" "));
    if (tokens.length === 0) {
      return {
        content: [{ type: "text", text: "Search query must contain valid keywords." }],
        isError: true,
      };
    }

    const buildSql = (project: boolean, projects = 1) => project
      ? `SELECT id, label, node_type, summary, ${BM25} AS score FROM nodes_fts
         WHERE nodes_fts MATCH ? AND id IN (SELECT id FROM graph_nodes WHERE project_id IN (${Array(projects).fill("?").join(",")}))
         ORDER BY ${BM25} LIMIT ?`
      : `SELECT id, label, node_type, summary FROM nodes_fts
         WHERE nodes_fts MATCH ?
         ORDER BY ${BM25} LIMIT ?`;

    // Prefix match on every token: try AND first, fall back to OR when nothing matches
    const search = (ids: string[], libs = new Set<string>()) => {
      const run = (joiner: string) => {
        // synonyms only widen the OR pass: they would make AND needlessly strict
        const match = (joiner === " " ? tokens : [...new Set([...tokens, ...extra])]).map((t) => `"${t}"*`).join(joiner);
        const params = ids.length ? [match, ...ids, limit * 4] : [match, limit * 4]; // headroom: placeholders and test files are dropped/demoted below
        return db.prepare(buildSql(ids.length > 0, ids.length)).all(...params) as any[];
      };
      let found = run(" ");
      if (found.length === 0 && tokens.length > 1) found = run(" OR ");
      // bm25 is negative (lower = better): a library hit must beat the project's own by a margin to rank above it
      const adj = (r: any) => r.score * (libs.has(graphMemory.getNode(r.id)?.project_id ?? "") ? 0.8 : 1);
      if (libs.size) found.sort((a, b) => adj(a) - adj(b));
      // "not indexed yet" import stubs and node:fs-style package nodes say nothing useful
      found = found.filter((r) => { const pr = graphMemory.getNode(r.id)?.properties; return !pr?.placeholder && !pr?.is_external; });
      // Fakes and tests mirror the real code and crowd it out; keep them behind unless the query asks for tests
      if (!tokens.some((t) => /^tests?$/i.test(t))) {
        const isTest = (r: any) => TEST_PATH.test(graphMemory.getNode(r.id)?.properties?.file_path ?? "");
        found = [...found.filter((r) => !isTest(r)), ...found.filter(isTest)];
      }
      return found;
    };
    // Libraries the project imports (indexed as their own projects) are searched together with it
    const libs = project_id ? linkedProjects(db, project_id) : [];
    let results = search(project_id ? [project_id, ...libs] : [], new Set(libs));
    const viaLibrary = new Map<string, string>();
    for (const r of results) {
      const owner = graphMemory.getNode(r.id)?.project_id ?? "";
      if (libs.includes(owner)) viaLibrary.set(r.id, owner);
    }
    results = results.slice(0, limit);
    // Paths dominate hit size: print the shared directory once
    const paths = results.map((r) => graphMemory.getNode(r.id)?.properties?.file_path as string | undefined).filter(Boolean) as string[];
    let root = paths.length ? paths[0].slice(0, paths[0].lastIndexOf("/") + 1) : "";
    for (const p of paths) while (root && !p.startsWith(root)) root = root.slice(0, root.slice(0, -1).lastIndexOf("/") + 1);

    const budget = max_tokens ?? Infinity;
    const body: string[] = [];
    let used = 0;
    let shown = 0;
    let withCode = 0; // only the top 2 symbols carry code; module overviews have none worth showing
    for (const res of results) {
      const node = graphMemory.getNode(res.id);
      const where = locationOf(node);
      // the id already starts with the type for most nodes: "[component]" after "component:..." is dead weight
      const typeTag = res.id.startsWith(res.node_type + ":") ? "" : ` [${res.node_type}]`;
      const sameAsId = res.id.toLowerCase().endsWith(res.label.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
      let entry = `- ${res.id}${viaLibrary.has(res.id) ? ` @${viaLibrary.get(res.id)}` : ""}${typeTag}${sameAsId ? "" : ` ${res.label}`} — ${stripWords(res.summary)}${where ? ` → ${root && where.startsWith(root) ? where.slice(root.length) : where}` : ""}`;
      if (code && withCode < 2 && !res.id.startsWith("module:") && node?.properties?.line) {
        const src = (getNodeProvenanceStmt.get(res.id) as any)?.content as string | undefined;
        if (src) {
          const start = node.properties.line;
          withCode++;
          entry += "\n```\n" + src.split("\n").slice(start - 1, start - 1 + code).join("\n") + "\n```";
        }
      }
      if (used + tokTokens(entry) > budget && shown > 0) break; // always return at least the best hit
      used += tokTokens(entry);
      body.push(entry);
      shown++;
    }

    const lines: string[] = [`Search "${query}" (${results.length} matches)`];
    if (results.length === 0) {
      lines.push("No matches found in knowledge graph.");

      // Multi-layer search fallback: search raw source contents directly
      try {
        const rawMatch = tokens.map((t) => `"${t}"*`).join(" ");
        const rawRows = (project_id
          ? db.prepare(`
              SELECT r.id, r.title, r.file_path, r.content
              FROM raw_sources r
              JOIN raw_sources_fts f ON r.id = f.rowid
              WHERE raw_sources_fts MATCH ? AND r.project_id = ?
              LIMIT 4
            `).all(rawMatch, project_id)
          : db.prepare(`
              SELECT r.id, r.title, r.file_path, r.content
              FROM raw_sources r
              JOIN raw_sources_fts f ON r.id = f.rowid
              WHERE raw_sources_fts MATCH ?
              LIMIT 4
            `).all(rawMatch)
        ) as any[];

        if (rawRows.length > 0) {
          lines.push(`\n📄 Exact symbols not found, but matched in raw sources (${rawRows.length} files):`);
          for (const row of rawRows) {
            const fileLines = row.content.split("\n");
            const firstToken = tokens[0].toLowerCase();
            const hitIndex = fileLines.findIndex((l: string) => l.toLowerCase().includes(firstToken));
            const lineNum = hitIndex >= 0 ? hitIndex + 1 : 1;
            const snippet = fileLines.slice(Math.max(0, lineNum - 2), Math.min(fileLines.length, lineNum + 3)).join("\n");
            lines.push(`- \`${row.file_path || row.title}\`:${lineNum}`);
            lines.push("```\n" + snippet + "\n```");
          }
        }
      } catch {
        // ignore raw search match syntax errors
      }

      if (project_id) {
        const unindexed = listDeps(db, project_id).filter((d) => d.source && !d.indexedAs);
        const qTokens = query.toLowerCase().split(/[\s:_/.-]+/).filter((t) => t.length >= 3);
        const matchedDep = unindexed.find((d) => {
          const dn = d.name.toLowerCase();
          return qTokens.some((t) => dn.includes(t) || t.includes(dn));
        });
        if (matchedDep) {
          lines.push(`\n💡 Detected query related to unindexed library: **${matchedDep.name}** (\`${matchedDep.source}\`)`);
          lines.push(`→ Auto-index now: \`kb_resolve_library(project_id: "${project_id}", library_name: "${matchedDep.name}", auto_ingest: true)\``);
          lines.push(`→ Or direct inspect without indexing: \`read_package_uris(uris: ["package:${matchedDep.name}/${matchedDep.name}.dart"])\``);
        } else {
          lines.push(depHint(db, project_id)); // a miss is often a library symbol
        }
      }
    }
    else if (root) lines.push(`paths relative to ${root}`);
    lines.push(...body);
    if (shown < results.length) lines.push(`+${results.length - shown} more (raise max_tokens or limit)`);

    const rendered = lines.join("\n");
    const { footer } = telemetry.record(
      name,
      startTime,
      null,
      null,
      rendered,
      rawSearchText(db, results.map((r) => r.id))
    );

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_file_outline") {
    const { file_path, project_id } = FileOutlineSchema.parse(args);
    const hits = (project_id ? graphMemory.getProjectNodes(project_id) : graphMemory.getAllNodes()).filter((n) => {
      const fp = n.properties?.file_path as string | undefined;
      return fp && (fp === file_path || fp.endsWith("/" + file_path.replace(/^\/+/, ""))) && n.node_type !== "module" && !n.properties?.placeholder;
    });
    if (hits.length === 0) {
      return { content: [{ type: "text", text: `No indexed symbols for '${file_path}'. Use kb_ingest_file if it is not indexed yet.` }], isError: true };
    }
    hits.sort((a, b) => (a.properties?.line ?? 0) - (b.properties?.line ?? 0));
    const lines = [`${hits[0].properties.file_path} (${hits.length} symbols)`];
    const clip = (t: string) => (t.length > 120 ? t.slice(0, 119) + "…" : t); // a large file's outline must stay cheap
    for (const n of hits) lines.push(`${n.properties?.line ?? "-"} ${n.id} — ${clip(stripWords(n.summary))}`);
    const rendered = lines.join("\n");
    const { footer } = telemetry.record(name, startTime, null, null, rendered, rawSearchText(db, hits.map((n) => n.id)));
    return { content: [{ type: "text", text: rendered + footer }] };
  }

  if (name === "kb_stats") {
    const { project_id } = StatsSchema.parse(args);

    const allNodes = project_id
      ? graphMemory.getProjectNodes(project_id)
      : graphMemory.getAllNodes();
    const allEdges = project_id
      ? graphMemory.getProjectEdges(project_id)
      : graphMemory.getAllEdges();

    const typeCounts = new Map<string, number>();
    const domainCounts = new Map<string, number>();

    for (const n of allNodes) {
      typeCounts.set(n.node_type, (typeCounts.get(n.node_type) || 0) + 1);
      domainCounts.set(n.domain, (domainCounts.get(n.domain) || 0) + 1);
    }

    const centrality = computeCentrality(allNodes, allEdges);
    const topHubs = [...allNodes]
      .sort((a, b) => {
        const scA = centrality.get(a.id)?.score || 0;
        const scB = centrality.get(b.id)?.score || 0;
        return scB - scA;
      })
      .slice(0, 5);

    const lines: string[] = [
      `### Knowledge Graph Statistics ${project_id ? `[Project: ${project_id}]` : "[Global]"}`,
      `- **Total Nodes:** ${allNodes.length}`,
      `- **Total Edges:** ${allEdges.length}`,
      `- **Graph Density:** ${(allNodes.length > 0 ? allEdges.length / allNodes.length : 0).toFixed(2)} links/node`,
      "",
      "**Distribution by Entity Type:**",
    ];

    for (const [type, count] of typeCounts.entries()) {
      lines.push(`- ${type}: ${count}`);
    }

    lines.push("");
    lines.push("**Distribution by Domain:**");
    for (const [dom, count] of domainCounts.entries()) {
      lines.push(`- ${dom}: ${count}`);
    }

    lines.push("");
    lines.push("**Top 5 Architectural Hubs (Highest Connectivity):**");
    for (const hub of topHubs) {
      const cent = centrality.get(hub.id);
      lines.push(
        `- \`${hub.id}\`: ${hub.label} (Score: ${(cent?.score || 0).toFixed(4)}, In: ${
          cent?.inDegree
        }, Out: ${cent?.outDegree})`
      );
    }

    const rendered = lines.join("\n");
    const { footer } = telemetry.record(name, startTime, null, null, rendered, rendered);

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_metrics") {
    const { reset } = MetricsSchema.parse(args);

    if (reset) {
      telemetry.reset();
    }

    const totalNodes = graphMemory.getAllNodes().length;
    const totalEdges = graphMemory.getAllEdges().length;
    const stats = telemetry.getStats(totalNodes, totalEdges);

    const rendered = [
      "### 📊 Real-Time Performance & Token Telemetry",
      "",
      "**Latency SLA Metrics:**",
      `- Total Queries Tracked: **${stats.total_queries}**`,
      `- Average Latency: **${stats.avg_latency_ms} ms**`,
      `- P50 Latency (Median): **${stats.p50_latency_ms} ms** (Target: < 2.0 ms)`,
      `- P95 Latency: **${stats.p95_latency_ms} ms** (Target: < 5.0 ms)`,
      `- P99 Latency: **${stats.p99_latency_ms} ms**`,
      "",
      "**Token Efficiency Metrics:**",
      `- Tokens Returned to Agent: **${stats.total_tokens_returned.toLocaleString()} tokens**`,
      `- Equivalent Raw Source Size: **${stats.total_raw_equivalent_tokens.toLocaleString()} tokens**`,
      `- Overall Token Reduction: **${stats.overall_savings_percent}%** (Target: > 85%)`,
      "",
      "**System Resources & Storage:**",
      `- Server RAM Footprint: **${stats.current_ram_mb} MB** (Target: < 80 MB)`,
      `- In-Memory Graph Nodes: **${stats.node_count}**`,
      `- In-Memory Graph Edges: **${stats.edge_count}**`,
    ].join("\n");

    return {
      content: [{ type: "text", text: rendered }],
    };
  }

  return null;
}

// What an agent without the graph would read: the source documents behind the matched nodes
function rawSearchText(db: DatabaseInstance, ids: string[]): string {
  if (ids.length === 0) return "";
  const rows = db
    .prepare(
      `SELECT DISTINCT rs.content FROM node_sources ns JOIN raw_sources rs ON ns.source_id = rs.id
       WHERE ns.node_id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids) as { content: string | null }[];
  return rows.map((r) => r.content ?? "").join("\n");
}
