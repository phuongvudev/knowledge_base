import fs from "node:fs";
import path from "node:path";
import { DatabaseInstance } from "../database.js";
import { graphMemory } from "../engine/graph_memory.js";
import { computeCentrality } from "../engine/pagerank.js";
import { telemetry } from "../engine/telemetry.js";
import { depHint, linkedProjects, listDeps } from "../engine/deps.js";
import { knowledgeExtractor } from "../engine/parsers/extractor.js";
import { persistExtraction } from "../engine/persist.js";
import { FileOutlineSchema, MetricsSchema, NodeGetSchema, SearchSchema, StatsSchema } from "../types.js";

// Column weights: label and summary are what a person would search; the JSON properties blob is mostly paths
const BM25 = "bm25(nodes_fts, 2.0, 10.0, 0.5, 4.0, 0.2, 0.05)";
const tokTokens = (t: string) => Math.ceil(t.length / 4);

const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "with", "when", "where", "how", "what", "which", "who", "why", "from", "that",
  "this", "does", "not", "can", "has", "have", "into", "then", "than", "ra", "và", "của", "là", "các", "cho", "một",
  "những", "trong", "được", "khi", "nào", "sao", "thế",
]);

// Universal Vietnamese action words -> common software equivalents; "" drops filler words
const VI_EN: Array<[RegExp, string]> = [
  [/(?<![\p{L}\p{N}_])(ứng dụng|người dùng|quản lý|xử lý|chức năng|hệ thống)(?![\p{L}\p{N}_])/giu, ""],
  [/(?<![\p{L}\p{N}_])(ghi nhớ|lưu trữ|lưu lại|lưu)(?![\p{L}\p{N}_])/giu, "store save persist remember"],
  [/(?<![\p{L}\p{N}_])(đồng ý|chấp nhận|cho phép)(?![\p{L}\p{N}_])/giu, "consent accept allow"],
  [/(?<![\p{L}\p{N}_])(dữ liệu)(?![\p{L}\p{N}_])/giu, "data"],
  [/(?<![\p{L}\p{N}_])(gửi)(?![\p{L}\p{N}_])/giu, "send upload"],
  [/(?<![\p{L}\p{N}_])(sinh trắc học|vân tay|khuôn mặt)(?![\p{L}\p{N}_])/giu, "biometric fingerprint localauth"],
  [/(?<![\p{L}\p{N}_])(xác thực|đăng nhập)(?![\p{L}\p{N}_])/giu, "auth login authenticate"],
  [/(?<![\p{L}\p{N}_])(đăng xuất)(?![\p{L}\p{N}_])/giu, "logout signout"],
  [/(?<![\p{L}\p{N}_])(thông báo|cảnh báo|nhắc nhở)(?![\p{L}\p{N}_])/giu, "notification alert reminder"],
  [/(?<![\p{L}\p{N}_])(thử lại)(?![\p{L}\p{N}_])/giu, "retry"],
  [/(?<![\p{L}\p{N}_])(mã hóa)(?![\p{L}\p{N}_])/giu, "encrypt crypto"],
  [/(?<![\p{L}\p{N}_])(bảo mật)(?![\p{L}\p{N}_])/giu, "security secret"],
  [/(?<![\p{L}\p{N}_])(lỗi|ngoại lệ)(?![\p{L}\p{N}_])/giu, "error exception failure"],
  [/(?<![\p{L}\p{N}_])(cấu hình|thiết lập|cài đặt)(?![\p{L}\p{N}_])/giu, "config settings setup"],
  [/(?<![\p{L}\p{N}_])(đồng bộ)(?![\p{L}\p{N}_])/giu, "sync synchronize"],
  [/(?<![\p{L}\p{N}_])(tạo mới|thêm mới|tạo|thêm)(?![\p{L}\p{N}_])/giu, "create add insert"],
  [/(?<![\p{L}\p{N}_])(cập nhật|chỉnh sửa|sửa)(?![\p{L}\p{N}_])/giu, "update edit modify"],
  [/(?<![\p{L}\p{N}_])(xóa|hủy bỏ)(?![\p{L}\p{N}_])/giu, "delete remove discard"],
  [/(?<![\p{L}\p{N}_])(tìm kiếm|tra cứu)(?![\p{L}\p{N}_])/giu, "search query find lookup"],
  [/(?<![\p{L}\p{N}_])(định kỳ|lặp lại)(?![\p{L}\p{N}_])/giu, "recurring periodic repeat schedule"],
  [/(?<![\p{L}\p{N}_])(trả lời|phản hồi|giải đáp)(?![\p{L}\p{N}_])/giu, "respond answer reply responder chat"],
  [/(?<![\p{L}\p{N}_])(nhắc|bảo|yêu cầu|chỉ thị|hướng dẫn)(?![\p{L}\p{N}_])/giu, "prompt instruct instruction message"],
  [/(?<![\p{L}\p{N}_])(số liệu|thống kê|con số)(?![\p{L}\p{N}_])/giu, "figure figures metric stat stats data summary"],
  [/(?<![\p{L}\p{N}_])(mô hình|trí tuệ nhân tạo)(?![\p{L}\p{N}_])/giu, "model ai llm nano gemini ondevice"],
  [/(?<![\p{L}\p{N}_])(ngân sách|chi tiêu)(?![\p{L}\p{N}_])/giu, "budget budgets spending expense"],
  [/(?<![\p{L}\p{N}_])(chủ đề|chuyên mục)(?![\p{L}\p{N}_])/giu, "topic topics category"],
  [/(?<![\p{L}\p{N}_])(hàm|phương thức)(?![\p{L}\p{N}_])/giu, "function method"],
];
// Universal developer synonyms: only used to widen the OR pass when exact match finds nothing
const SYNONYMS: Array<[RegExp, string]> = [
  [/\b(allowed|allowlist|whitelist|permitted|blocked|forbidden)\b/i, "policy check validate reject"],
  [/\b(servers?|calling|outbound)\b/i, "endpoint url request client api"],
  [/\b(remember|persist|saved?)\b/i, "store prefs localstorage db"],
  [/\b(credential|password|token)\b/i, "secret key auth jwt"],
  [/\b(wait|longer)\b/i, "backoff delay timeout debounce"],
  [/\b(consent|agreed?)\b/i, "accepted accept terms permission"],
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
const stripWords = (s: string) => s.replace(/ \([a-z0-9_.]+(?: [a-z0-9_.]+)*\)$/i, "");

export async function handleQueryTool(
  name: string,
  args: any,
  db: DatabaseInstance
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean } | null> {
  const startTime = process.hrtime.bigint();
  graphMemory.syncIfStale(db);

  const getNodeProvenanceStmt = db.prepare(`
    SELECT ns.*, rs.title, rs.file_path, rs.source_type, rs.content
    FROM node_sources ns
    JOIN raw_sources rs ON ns.source_id = rs.id
    WHERE ns.node_id = ?
    LIMIT 1
  `);

  if (name === "kb_node_get") {
    const { node_id, include_raw, project_id } = NodeGetSchema.parse(args);

    let node = graphMemory.resolveNode(node_id, project_id);
    if (!node) {
      const suggestions = graphMemory.suggestNodes(node_id, project_id, 3);
      if (suggestions.length === 1) {
        node = suggestions[0];
      } else {
        const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.map((s) => `\`${s.id}\` (${s.label})`).join(", ")}?` : "";
        return {
          content: [{ type: "text", text: `Node '${node_id}' not found.${hint}` }],
          isError: true,
        };
      }
    }
    const resolvedId = node.id;

    const lines: string[] = [
      `### ${node.label} (\`${node.id}\`)`,
      `- **Type:** ${node.node_type} | **Domain:** ${node.domain} | **Project:** ${node.project_id}`,
      `- **Summary:** ${node.summary}`,
    ];
    const where = locationOf(node);
    if (where) lines.push(`- **Location:** \`${where}\``);

    const INTERNAL_PROPS = new Set(["file_path", "line", "end_line", "calls", "internal_imports", "placeholder", "is_chunk"]);
    const customProps = Object.fromEntries(
      Object.entries(node.properties || {}).filter(([k]) => !INTERNAL_PROPS.has(k))
    );
    if (Object.keys(customProps).length > 0) {
      lines.push(`- **Properties:** \`${JSON.stringify(customProps)}\``);
    }

    // 360-degree Call Graph & Dependencies
    const sub = graphMemory.getRadialSubgraph(resolvedId, 1, 15);
    const outbound = sub.edges.filter((e) => e.source_id === resolvedId);
    const inbound = sub.edges.filter((e) => e.target_id === resolvedId);

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
      const prov = getNodeProvenanceStmt.get(resolvedId) as any;
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
            const hasEndLine = typeof node.properties?.end_line === "number";
            const startLine = Math.max(1, node.properties.line - (hasEndLine ? 0 : 3));
            const endLine = Math.min(
              fileLines.length,
              hasEndLine ? Math.min(node.properties.end_line, startLine + 40) : startLine + 30
            );
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
    const parsed = SearchSchema.parse(args);
    const { query, limit, code, max_tokens } = parsed;
    const project_id = graphMemory.resolveProjectId(parsed.project_id);

    const conceptGroups: string[][] = [];
    let remaining = query;

    // 1. Project-specific domain lexicon (Unicode word boundaries so 'định kỳ', 'số dư', 'khoản nợ' match properly)
    const projectExtra: string[] = [];
    if (project_id) {
      try {
        const rows = db.prepare("SELECT term, synonyms FROM project_lexicon WHERE project_id = ?").all(project_id) as Array<{ term: string; synonyms: string }>;
        for (const r of rows) {
          const escaped = r.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
          if (re.test(remaining)) {
            remaining = remaining.replace(re, " ");
            const syns = r.synonyms.split(/\s+/).filter(Boolean);
            if (syns.length > 0) {
              conceptGroups.push(syns);
              projectExtra.push(...syns);
            }
          }
        }
      } catch {
        // ignore if table not present
      }
    }

    // 2. Universal Vietnamese -> English developer phrase mapping
    for (const [re, en] of VI_EN) {
      if (re.test(remaining)) {
        remaining = remaining.replace(re, " ");
        const syns = en.trim().split(/\s+/).filter(Boolean);
        if (syns.length > 0) {
          conceptGroups.push(syns);
        }
      }
    }

    // 3. Remaining standalone tokens
    const remAll = remaining.match(/[\p{L}\p{N}_]+/gu) || [];
    const remContent = remAll.filter((t) => t.length > 2 && !STOPWORDS.has(t.toLowerCase()));
    const remTokens = remContent.length > 0 || conceptGroups.length > 0 ? remContent : remAll;
    const seenTokens = new Set(conceptGroups.flat().map((t) => t.toLowerCase()));
    for (const t of remTokens) {
      if (!seenTokens.has(t.toLowerCase())) {
        conceptGroups.push([t]);
        seenTokens.add(t.toLowerCase());
      }
    }

    const tokens = conceptGroups.flat();
    const flatQueryForSynonyms = [query, ...tokens].join(" ");
    const extra = [
      ...SYNONYMS.filter(([re]) => re.test(flatQueryForSynonyms)).flatMap(([, add]) => add.split(" ")),
      ...projectExtra,
    ];
    if (tokens.length === 0) {
      return {
        content: [{ type: "text", text: "Search query must contain valid keywords." }],
        isError: true,
      };
    }

    const ftsStmt = db.prepare(`
      SELECT id, label, node_type, summary, ${BM25} AS score
      FROM nodes_fts
      WHERE nodes_fts MATCH ?
      ORDER BY ${BM25}
    `);

    const formatGroup = (g: string[]) =>
      g.length === 1 ? `"${g[0]}"*` : `(${g.map((t) => `"${t}"*`).join(" OR ")})`;

    // Multi-pass Concept-Grouped FTS5:
    // Pass 1: Primary token of each concept ANDed in {id label summary domain} (avoids file_path folder name pollution)
    // Pass 2: Full synonym group of each concept ANDed: (syn1 OR syn2) AND (syn3 OR syn4)
    // Pass 3: If query mixed untranslated Vietnamese words with English concepts, AND only the English concept groups
    // Pass 4: Fallback OR across all tokens + synonyms
    const search = (ids: string[], libs = new Set<string>()) => {
      const allowedProjects = ids.length > 0 ? new Set(ids) : null;
      const execFts = (expr: string, restrictCols = true) => {
        const match = restrictCols ? `{id label summary domain} : (${expr})` : expr;
        const rows = ftsStmt.all(match) as any[];
        if (!allowedProjects) return rows.slice(0, limit * 4);
        const filtered: any[] = [];
        for (const r of rows) {
          const proj = graphMemory.getNode(r.id)?.project_id;
          if (proj && allowedProjects.has(proj)) {
            filtered.push(r);
            if (filtered.length >= limit * 4) break;
          }
        }
        return filtered;
      };

      const primaryExpr = conceptGroups.map((g) => `"${g[0]}"*`).join(" AND ");
      const groupAndExpr = conceptGroups.map(formatGroup).join(" AND ");

      let found = execFts(primaryExpr, true);
      if (found.length === 0 && groupAndExpr !== primaryExpr) {
        found = execFts(groupAndExpr, true);
      }
      // If mixed Vietnamese + English query failed AND because codebase is English-only, try ASCII/translated concept groups
      const asciiGroups = conceptGroups.filter((g) => g.some((w) => /^[a-z0-9_]+$/i.test(w)));
      if (found.length === 0 && asciiGroups.length > 0 && asciiGroups.length < conceptGroups.length) {
        found = execFts(asciiGroups.map(formatGroup).join(" AND "), true);
      }
      if (found.length === 0 && conceptGroups.length > 1) {
        const orTokens = [...new Set([...tokens, ...extra])];
        found = execFts(orTokens.map((t) => `"${t}"*`).join(" OR "), true);
      }
      // Final fallback: include properties (file_path) column if symbol/summary columns had 0 hits
      if (found.length === 0) {
        const orTokens = [...new Set([...tokens, ...extra])];
        found = execFts(orTokens.map((t) => `"${t}"*`).join(" OR "), false);
      }
      // bm25 is negative (lower = better): a library hit must beat the project's own by a margin to rank above it
      const adj = (r: any) => r.score * (libs.has(graphMemory.getNode(r.id)?.project_id ?? "") ? 0.8 : 1);
      if (libs.size) found.sort((a, b) => adj(a) - adj(b));
      // "not indexed yet" import stubs, external packages, and project root overview nodes (unless explicitly requested)
      const isAskingForProjectOverview = /\b(project|overview|architecture|dự án|tổng quan)\b/i.test(query);
      found = found.filter((r) => {
        const node = graphMemory.getNode(r.id);
        const pr = node?.properties;
        if (pr?.placeholder || pr?.is_external) return false;
        if (!isAskingForProjectOverview && (pr?.is_project_root || pr?.is_library || r.id.startsWith("project:"))) {
          return false;
        }
        return true;
      });
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
      rawSearchText(db, results.slice(0, 3).map((r) => r.id), 10_000)
    );

    return {
      content: [{ type: "text", text: rendered + footer }],
    };
  }

  if (name === "kb_file_outline") {
    const parsed = FileOutlineSchema.parse(args);
    const file_path = parsed.file_path.trim();
    const project_id = graphMemory.resolveProjectId(parsed.project_id);

    const collectFileNodes = () => {
      const exactNodes = graphMemory.getNodesByFile(file_path, project_id);
      if (exactNodes.length > 0) return exactNodes;
      const normSuffix = "/" + file_path.replace(/^\/+/, "");
      const pool = project_id ? graphMemory.getProjectNodes(project_id) : graphMemory.getAllNodes();
      return pool.filter((n) => {
        const fp = n.properties?.file_path as string | undefined;
        return fp && (fp === file_path || fp.endsWith(normSuffix));
      });
    };

    let fileNodes = collectFileNodes();

    // If not yet indexed in graphMemory, check if the file exists on disk inside the project and auto-ingest on the fly
    if (fileNodes.length === 0) {
      let diskPath: string | undefined;
      let targetProj = project_id;
      if (path.isAbsolute(file_path) && fs.existsSync(file_path)) {
        diskPath = file_path;
      } else if (targetProj) {
        const root = graphMemory.getProjectRoot(targetProj);
        if (root) {
          const cleanRel = file_path.replace(/^\/+/, "");
          const candidates = [
            path.join(root, cleanRel),
            path.join(path.dirname(root), cleanRel),
          ];
          diskPath = candidates.find((c) => fs.existsSync(c));
        }
      }
      if (diskPath && !targetProj) {
        // Infer project from whose root directory contains diskPath
        const projs = db.prepare("SELECT id FROM projects").all() as Array<{ id: string }>;
        for (const p of projs) {
          const r = graphMemory.getProjectRoot(p.id);
          if (r && diskPath.startsWith(r + "/")) {
            targetProj = p.id;
            break;
          }
        }
      }
      if (diskPath && targetProj && fs.statSync(diskPath).isFile()) {
        try {
          const extracted = await knowledgeExtractor.extractFromFile(targetProj, diskPath, "auto");
          persistExtraction(db, targetProj, diskPath, extracted);
          fileNodes = collectFileNodes();
        } catch {
          // ignore auto-ingest failure and fall through
        }
      }
    }

    // 1. Primary: code/rule symbols (non-module, non-placeholder, non-chunk)
    let hits = fileNodes.filter((n) => n.node_type !== "module" && !n.properties?.placeholder && !n.properties?.is_chunk);
    // 2. Fallback: markdown/doc section chunks (non-module, non-placeholder)
    if (hits.length === 0 && fileNodes.length > 0) {
      hits = fileNodes.filter((n) => n.node_type !== "module" && !n.properties?.placeholder);
    }
    // 3. Fallback: module-only file (e.g. barrel index.ts, tsconfig.json, small config/UI stub)
    if (hits.length === 0 && fileNodes.length > 0) {
      hits = fileNodes.filter((n) => !n.properties?.placeholder);
    }

    if (hits.length === 0) {
      return { content: [{ type: "text", text: `No indexed symbols for '${file_path}'. Use kb_ingest_file if it is not indexed yet.` }], isError: true };
    }
    hits.sort((a, b) => (a.properties?.line ?? 0) - (b.properties?.line ?? 0));
    const resolvedFp = hits[0].properties.file_path;
    const isModuleOnly = hits.length === 1 && hits[0].node_type === "module";
    const lines = [`${resolvedFp} (${isModuleOnly ? "1 module overview, 0 child symbols" : `${hits.length} symbols`})`];
    const clip = (t: string) => (t.length > 120 ? t.slice(0, 119) + "…" : t); // a large file's outline must stay cheap
    for (const n of hits) lines.push(`${n.properties?.line ?? 1} ${n.id} — ${clip(stripWords(n.summary))}`);
    const rendered = lines.join("\n");
    const { footer } = telemetry.record(name, startTime, null, null, rendered, rawSearchText(db, [hits[0].id], 32_000));
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

    const centrality = graphMemory.getCentrality(project_id);
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

// What an agent without the graph would read: the source documents behind the matched nodes (bounded to realistic read window per file)
function rawSearchText(db: DatabaseInstance, ids: string[], maxCharsPerFile = 10_000): string {
  if (ids.length === 0) return "";
  const rows = db
    .prepare(
      `SELECT DISTINCT rs.id, MIN(LENGTH(rs.content), ?) AS capped_len
       FROM node_sources ns JOIN raw_sources rs ON ns.source_id = rs.id
       WHERE ns.node_id IN (${ids.map(() => "?").join(",")})
       LIMIT 3`
    )
    .all(maxCharsPerFile, ...ids) as { id: number; capped_len: number | null }[];
  const totalChars = rows.reduce((sum, r) => sum + (r.capped_len ?? 0), 0);
  return "x".repeat(totalChars);
}
