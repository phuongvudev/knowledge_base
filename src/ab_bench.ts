// A/B on this repo: "find where X is implemented" with kb_search vs plain grep + read.
// Modelled agents, not live ones: both must end up having read the file that answers the question.
//   KB   : kb_search output, then read a 25-line window at the returned path:line (two steps)
//   KB1  : kb_search with code=12, answered from the one response
//   Grep : first 60 lines of `grep -rin <keyword> src`, then read the whole matching file
// Run: npm run ab            (this repo)
//      npm run ab -- dart     (budgetable-v2 Flutter sample, needs AB_DART_ROOT or the default path)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ab-"));
process.env.KB_DB_PATH = path.join(tmp, "ab.db");
const { initDatabase } = await import("./database.js");
const { graphMemory } = await import("./engine/graph_memory.js");
const { handleIngestionTool } = await import("./tools/ingestion_tools.js");
const { handleQueryTool } = await import("./tools/query_tools.js");

const holdout = process.argv.includes("holdout"); // second plan: questions written after tuning, never used to tune
const dart = process.argv.includes("dart") || holdout;
const root = dart ? process.env.AB_DART_ROOT || "/Volumes/Data/workstation/personal/projects/flutter/budgetable_v2" : process.cwd();
const db = initDatabase();
graphMemory.hydrate(db);
const scan = dart ? ["lib", "packages"] : ["src"];
for (const d of scan) {
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "ab", dir_path: path.join(root, d), extensions: dart ? [".dart"] : undefined }, db);
}

const tok = (s: string) => Math.ceil(s.length / 4);
const dartCases = [
  { q: "mask api keys so they are not shown in logs", grep: "redact", file: "packages/ai_provider_core/lib/src/secret_redactor.dart" },
  { q: "delay between job retries grows exponentially", grep: "backoff", file: "packages/local_job_engine/lib/src/retry_policy.dart" },
  { q: "parse amount typed by user like 1.5tr or 200k", grep: "amount", file: "lib/features/onboarding/domain/amount_parser.dart" },
  { q: "validate widget spec before rendering dashboard", grep: "validat", file: "packages/dashboard_widgets/lib/src/core/spec_validator.dart" },
  { q: "extract balance change from bank notification text", grep: "balance", file: "packages/notification_capture/lib/src/balance_notification_parser.dart" },
  { q: "parse receipt text into total and merchant", grep: "receipt", file: "packages/receipt_scanner/lib/src/receipt_parser.dart" },
  { q: "cancel an in flight llm request", grep: "cancel", file: "packages/ai_provider_core/lib/src/cancel_token.dart" },
  { q: "restrict which endpoints an ai provider may call", grep: "endpoint", file: "packages/ai_provider_core/lib/src/endpoint_policy.dart" },
  { q: "plan when reminders fire", grep: "remind", file: "lib/features/reminders/domain/reminder_planner.dart" },
  { q: "extract widget blocks from model reply", grep: "block", file: "packages/genui_core/lib/src/widget_block_parser.dart" },
  { q: "store whether user consented to ai", grep: "consent", file: "lib/features/ai/data/ai_consent_store.dart" },
  { q: "persist chat history", grep: "history", file: "lib/features/conversation/data/chat_history_store.dart" },
];
// Held-out plan: paraphrased behaviour questions (no identifiers), incl. one Vietnamese, one test-file trap
const holdoutCases = [
  { q: "refresh screens after a backup is restored", grep: "restored", file: "lib/core/shell/data_restored_bus.dart" },
  { q: "fix trailing commas and code fences in json from a small model", grep: "json", file: "packages/genui_core/lib/src/lenient_json.dart" },
  { q: "remember which version of the whats new screen was shown", grep: "whats", file: "lib/features/whats_new/data/whats_new_store.dart" },
  { q: "number of grid columns for screen width", grep: "column", file: "packages/dashboard_widgets/lib/src/core/layout_engine.dart" },
  { q: "decide which widget is on top of a stack", grep: "stack", file: "packages/dashboard_widgets/lib/src/core/smart_stack.dart" },
  { q: "tool calling for model that cannot do it natively", grep: "tool", file: "packages/on_device_llm/lib/src/prompt_tool_calling.dart" },
  { q: "convert recipe between names and ids", grep: "recipe", file: "lib/features/ai/genui/recipe_codec.dart" },
  { q: "background check that shows due reminders", grep: "remind", file: "lib/core/jobs/workmanager_job_scheduler.dart" },
  { q: "probe how capable an ai provider is", grep: "probe", file: "packages/ai_provider_core/lib/src/capability_probe.dart" },
  { q: "answer a chat message with text and widgets", grep: "chat", file: "lib/features/ai/genui/chat_responder.dart" },
  { q: "câu hỏi tiếp theo của bot khi onboarding", grep: "onboarding", file: "lib/features/onboarding/domain/onboarding_script.dart" },
  { q: "what a finance topic can read lazily", grep: "topic", file: "lib/features/ai/genui/finance_query_tool.dart" },
];
const cases = holdout ? holdoutCases : dart ? dartCases : [
  { q: "where token savings percent is computed", grep: "savings", file: "src/engine/telemetry.ts" },
  { q: "remove stale nodes when a file is re-indexed", grep: "stale", file: "src/engine/persist.ts" },
  { q: "cancel a running indexing job", grep: "cancel", file: "src/engine/jobs.ts" },
  { q: "which tools are read only", grep: "readonly", file: "src/tools/index.ts" },
  { q: "http endpoint for metrics", grep: "metrics", file: "src/server/http.ts" },
  { q: "split calls into sessions for usage analytics", grep: "session", file: "src/engine/usage.ts" },
  { q: "pagerank centrality of nodes", grep: "centrality", file: "src/engine/pagerank.ts" },
  { q: "classify document domain", grep: "classif", file: "src/engine/parsers/classifier.ts" },
  { q: "parse python def and class", grep: "python", file: "src/engine/parsers/code_parser.ts" },
  { q: "radial subgraph around a node", grep: "radial", file: "src/engine/graph_memory.ts" },
];

type Row = { q: string; kb: number | null; kb1: number | null; grep: number | null; rank: number | null };
const rows: Row[] = [];
for (const c of cases) {
  const target = path.join(root, c.file);
  const lines = fs.readFileSync(target, "utf-8").split("\n");

  const out0 = (await handleQueryTool("kb_search", { query: c.q, project_id: "ab", limit: 5 }, db))!.content[0].text;
  const abs = (t: string) => { const r = t.match(/^paths relative to (.+)$/m)?.[1]; return r ? t.replace(/→ (?!\/)/g, `→ ${r}`) : t; };
  const out = abs(out0);
  const hit = out.split("\n").map((l) => l.match(/→ (.+?):(\d+)$/)).find((m) => m && m[1] === target);
  let kb: number | null = null;
  if (hit) {
    const at = Number(hit[2]);
    kb = tok(out0) + tok(lines.slice(Math.max(0, at - 1), at + 25).join("\n"));
  }

  // only the top 2 symbols carry code (not module overviews); the block must belong to the target file
  const oneRaw = (await handleQueryTool("kb_search", { query: c.q, project_id: "ab", limit: 5, code: 12 }, db))!.content[0].text;
  const one = abs(oneRaw);
  const top3 = one.split("\n- ").slice(1).filter((e) => e.includes("```")).slice(0, 2).some((e) => e.includes(`→ ${target}:`) && e.includes("```"));
  const kb1 = top3 ? tok(oneRaw) : null;

  let g = "";
  try {
    g = execFileSync("grep", ["-rin", dart ? "--include=*.dart" : "--include=*.ts", c.grep, ...scan], { cwd: root, encoding: "utf-8" });
  } catch {}
  const head = g.split("\n").slice(0, 60).join("\n");
  const grep = head.includes(c.file) ? tok(head) + tok(lines.join("\n")) : null;

  const rank = out.split("\n").filter((l) => l.startsWith("- ")).findIndex((l) => l.includes(`→ ${target}:`)) + 1 || null;
  rows.push({ q: c.q, kb, kb1, grep, rank });
}

const fmt = (n: number | null) => (n === null ? "MISS" : String(n)).padStart(6);
console.log("question".padEnd(48), "    KB   KB1  Grep rank");
for (const r of rows) console.log(r.q.padEnd(48), fmt(r.kb), fmt(r.kb1), fmt(r.grep), String(r.rank ?? "-").padStart(4));
const found = (k: "kb" | "kb1" | "grep") => rows.filter((r) => r[k] !== null).length;
console.log(`\ntarget at rank 1: ${rows.filter((r) => r.rank === 1).length}/${rows.length}, top 3: ${rows.filter((r) => r.rank && r.rank <= 3).length}/${rows.length}`);
console.log(`found: KB ${found("kb")}/${rows.length}, KB1 ${found("kb1")}/${rows.length}, grep ${found("grep")}/${rows.length}`);
const all3 = rows.filter((r) => r.kb !== null && r.kb1 !== null && r.grep !== null);
const sum = (k: "kb" | "kb1" | "grep") => all3.reduce((a, r) => a + (r[k] as number), 0);
console.log(`tokens on the ${all3.length} questions all three answered: KB ${sum("kb")}, KB1 ${sum("kb1")}, grep ${sum("grep")} (KB1 ${Math.round((1 - sum("kb1") / sum("grep")) * 100)}% less than grep)`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
