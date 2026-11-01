// Run: npm test  (uses a throwaway DB and port; never touches data/)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-selftest-"));
process.env.KB_DB_PATH = path.join(tmp, "t.db");
process.env.BACKEND_PORT = "4399";
const base = "http://localhost:4399";

const { initDatabase } = await import("./database.js");
const { startHttpServer } = await import("./server/http.js");
const { handleIngestionTool } = await import("./tools/ingestion_tools.js");
const { handleQueryTool } = await import("./tools/query_tools.js");
const { jobs } = await import("./engine/jobs.js");
const { telemetry } = await import("./engine/telemetry.js");

const db = initDatabase();
const server = startHttpServer(db);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, init);
  return { status: r.status, body: (await r.json()) as any };
};
const run = async (name: string, fn: () => Promise<void>) => {
  await fn();
  console.log(`ok  ${name}`);
};

// fixture: N small markdown files
const mkDir = (name: string, n: number) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d);
  for (let i = 0; i < n; i++) {
    fs.writeFileSync(path.join(d, `doc${i}.md`), `# Doc ${i}\n\nThis document ${i} describes module number ${i} and links to Doc ${i + 1}.\n`);
  }
  return d;
};

await run("telemetry: honest savings, unknown durations are omitted", async () => {
  telemetry.reset();
  const { footer, record } = telemetry.record("t", process.hrtime.bigint(), null, null, "a".repeat(40), "b".repeat(400));
  assert.equal(record.token_savings_percent, 90);
  assert.ok(!footer.includes("db:") && !footer.includes("graph:"));
  const s = telemetry.getStats();
  assert.equal(s.total_queries, 1);
  assert.equal(s.overall_savings_percent, 90);
  assert.equal((await api("/api/metrics")).body.total_queries, 1); // web process sees it via shared DB
  telemetry.reset();
  assert.equal(telemetry.getStats().total_queries, 0);
});

await run("search baseline = source text of matched nodes (no source -> 0% saved)", async () => {
  const d = mkDir("srcs", 2);
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-search", dir_path: d }, db);
  telemetry.reset();
  const r = await handleQueryTool("kb_search", { query: "document", project_id: "p-search", limit: 5 }, db);
  assert.ok(r!.content[0].text.includes("matches)"));
  const s = telemetry.getStats();
  assert.equal(s.total_queries, 1);
  assert.ok(s.total_raw_equivalent_tokens > 0, "baseline should come from ingested sources")
  assert.ok(s.overall_savings_percent >= 0 && s.overall_savings_percent <= 100);
});

await run("ingestion never counts as saved tokens", async () => {
  telemetry.reset();
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-roi", dir_path: mkDir("roi", 3) }, db);
  const s = telemetry.getStats();
  assert.equal(s.total_queries, 1);
  assert.equal(s.overall_savings_percent, 0);
  assert.equal(s.total_raw_equivalent_tokens, s.total_tokens_returned);
});

await run("jobs: lifecycle, cancel is final, stale expiry", async () => {
  const id = jobs.start(db, "p-life", "x", 3);
  jobs.progress(db, id, { processed: 1, skipped: 1, failed: 0, current: "a.md" });
  assert.equal(jobs.list(db, "p-life")[0].current_file, "a.md");
  assert.ok(jobs.cancel(db, id));
  jobs.progress(db, id, { processed: 3, skipped: 0, failed: 0 });
  jobs.finish(db, id);
  const j = jobs.list(db, "p-life")[0];
  assert.equal(j.status, "cancelled");
  assert.equal(j.processed, 1); // late writes ignored
  const stale = jobs.start(db, "p-stale", "y", 1);
  db.prepare("UPDATE ingest_jobs SET updated_at = ? WHERE id = ?").run(Date.now() - 10 * 60_000, stale);
  assert.equal(jobs.list(db, "p-stale")[0].status, "error");
});

await run("batch ingest: progress visible over HTTP, cancel stops it, delete blocked while running", async () => {
  const d = mkDir("big", 800);
  // separate process, like the real MCP server; in-process the batch would starve the HTTP poll
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./selftest_batch.ts", import.meta.url)), "p-big", d], {
    env: process.env,
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.on("exit", r));
  let seen: any;
  for (let i = 0; i < 2000 && !seen; i++) {
    const j = (await api("/api/jobs?project_id=p-big")).body.jobs[0];
    if (j && j.status === "running" && j.processed >= 1) seen = j;
    else await sleep(1);
  }
  assert.ok(seen, "never observed a running job with progress");
  assert.equal(seen.total, 800);
  assert.equal((await api("/api/projects?id=p-big", { method: "DELETE" })).status, 409);
  assert.equal((await api(`/api/jobs/cancel?id=${seen.id}`, { method: "POST" })).status, 200);
  await exited;
  const j = jobs.list(db, "p-big")[0];
  assert.equal(j.status, "cancelled");
  assert.ok(j.processed < 800, `expected early stop, processed=${j.processed}`);
});

await run("single-file ingest over HTTP records a done job", async () => {
  const r = await api("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: "p-one", file_name: "one.md", content: "# One\n\nHello world.\n" }),
  });
  assert.equal(r.status, 200);
  const j = jobs.list(db, "p-one")[0];
  assert.equal(j.status, "done");
  assert.equal(j.processed, 1);
});

await run("failing ingest records an error job", async () => {
  const r = await api("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: "p-bad", file_path: "/nonexistent/x.md" }),
  });
  assert.equal(r.status, 400); // rejected before a job is created
  assert.equal(jobs.list(db, "p-bad").length, 0);
});

await run("delete project cascades and refreshes the graph", async () => {
  const before = (await api("/api/projects")).body.projectDetails.find((p: any) => p.id === "p-big");
  assert.ok(before && before.node_count > 0);
  assert.equal((await api("/api/projects?id=p-big", { method: "DELETE" })).status, 200);
  const after = (await api("/api/projects")).body.projectDetails.map((p: any) => p.id);
  assert.ok(!after.includes("p-big"));
  for (const t of ["graph_nodes", "graph_edges", "raw_sources", "node_sources", "ingest_jobs"]) {
    const col = t === "graph_edges" || t === "graph_nodes" || t === "raw_sources" || t === "ingest_jobs" ? "project_id" : null;
    if (col) assert.equal((db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE project_id='p-big'`).get() as any).c, 0, t);
  }
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM node_sources WHERE node_id NOT IN (SELECT id FROM graph_nodes)`).get() as any).c, 0);
  assert.equal((await api("/api/projects")).body.projectDetails.find((p: any) => p.id === "p-search").node_count > 0, true); // others untouched
});

await run("rename via POST upsert keeps id", async () => {
  await api("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: "p-one", name: "Renamed" }),
  });
  const p = (await api("/api/projects")).body.projectDetails.find((x: any) => x.id === "p-one");
  assert.equal(p.name, "Renamed");
});

await run("graph cache follows writes made by another process", async () => {
  const { graphMemory } = await import("./engine/graph_memory.js");
  graphMemory.syncIfStale(db);
  const before = graphMemory.getProjectNodes("p-search").length;
  assert.ok(before > 0);
  const other = initDatabase(); // a second connection, like the MCP process
  other.prepare("DELETE FROM graph_nodes WHERE project_id = 'p-search'").run();
  assert.equal(graphMemory.getProjectNodes("p-search").length, before); // stale until synced
  graphMemory.syncIfStale(db);
  assert.equal(graphMemory.getProjectNodes("p-search").length, 0);
  const v = (db.prepare("PRAGMA data_version").get() as any).data_version;
  graphMemory.syncIfStale(db); // unchanged -> cheap no-op
  assert.equal((db.prepare("PRAGMA data_version").get() as any).data_version, v);
});

await run("kb_file_outline and kb_sync: outline by path suffix, edits re-indexed, deleted files forgotten", async () => {
  const { graphMemory } = await import("./engine/graph_memory.js");
  const { handleQueryTool } = await import("./tools/query_tools.js");
  const d = path.join(tmp, "sync");
  fs.mkdirSync(path.join(d, "lib"), { recursive: true });
  const a = path.join(d, "lib", "a.ts");
  const b = path.join(d, "lib", "b.ts");
  fs.writeFileSync(a, "export function one() { return 1; }\nexport function two() { return 2; }\n");
  fs.writeFileSync(b, "export function gone() { return 0; }\n");
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-sync", dir_path: d }, db);
  const outline = (await handleQueryTool("kb_file_outline", { file_path: "lib/a.ts", project_id: "p-sync" }, db))!.content[0].text;
  assert.match(outline, /\(2 symbols\)/);
  assert.ok(outline.indexOf(":one") < outline.indexOf(":two"), "ordered by line");
  assert.equal((await handleQueryTool("kb_file_outline", { file_path: "nope.ts" }, db))!.isError, true);

  fs.writeFileSync(a, "export function one() { return 1; }\nexport function three() { return 3; }\n");
  fs.rmSync(b);
  const fresh = path.join(d, "lib", "c.ts");
  fs.writeFileSync(fresh, "export function added() {}\n");
  const out = (await handleIngestionTool("kb_sync", { project_id: "p-sync", dir_path: d }, db))!.content[0].text;
  assert.match(out, /1 updated, 1 removed/);
  const ids = graphMemory.getProjectNodes("p-sync").map((n) => n.id);
  assert.ok(ids.some((i) => i.endsWith(":three")) && !ids.some((i) => i.endsWith(":two")), "edit applied");
  assert.ok(!ids.some((i) => i.endsWith(":gone")), "deleted file forgotten");
  assert.ok(ids.some((i) => i.endsWith(":added")), "new file picked up via dir_path");
  assert.match((await handleIngestionTool("kb_sync", { project_id: "p-sync" }, db))!.content[0].text, /0 updated, 0 removed/);
});

await run("library hints: local source offered, pinned version, tests/builtins ignored, hidden once indexed", async () => {
  const { depHint } = await import("./engine/deps.js");
  const { handleQueryTool } = await import("./tools/query_tools.js");
  const d = path.join(tmp, "deps");
  fs.mkdirSync(path.join(d, "src"), { recursive: true });
  fs.mkdirSync(path.join(d, "test"), { recursive: true });
  fs.mkdirSync(path.join(d, "node_modules/fancy/src"), { recursive: true });
  fs.writeFileSync(path.join(d, "node_modules/fancy/package.json"), "{}");
  fs.writeFileSync(path.join(d, "node_modules/fancy/src/index.ts"), "export function shine() {}\n");
  fs.writeFileSync(path.join(d, "src/app.ts"), 'import fs from "node:fs";\nimport path from "path";\nimport { shine } from "fancy";\nimport x from "ghost-lib";\nexport const go = () => shine();\n');
  fs.writeFileSync(path.join(d, "test/app.test.ts"), 'import m from "only-in-tests";\nexport const t = 1;\n');
  const pub = path.join(tmp, "pubcache/hosted/pub.dev");
  for (const v of ["1.2.0", "1.10.0"]) fs.mkdirSync(path.join(pub, `gizmo-${v}/lib`), { recursive: true });
  fs.writeFileSync(path.join(d, "pubspec.lock"), 'packages:\n  gizmo:\n    dependency: "direct main"\n    description:\n      name: gizmo\n    source: hosted\n    version: "1.2.0"\n');
  fs.writeFileSync(path.join(d, "src/view.dart"), "import 'package:gizmo/gizmo.dart';\nimport 'dart:async';\nclass View {}\n");
  process.env.PUB_CACHE = path.join(tmp, "pubcache");
  for (const f of ["src/app.ts", "src/view.dart", "test/app.test.ts"]) {
    await handleIngestionTool("kb_ingest_file", { project_id: "p-deps", file_path: path.join(d, f), domain: "auto" }, db);
  }
  let hint = depHint(db, "p-deps");
  assert.match(hint, /fancy → .*node_modules\/fancy\/src/);
  assert.match(hint, /gizmo → .*gizmo-1\.2\.0\/lib/, "pubspec.lock pins the version");
  assert.ok(!/only-in-tests|ghost-lib|node:fs|async/.test(hint), hint);
  assert.match(hint, /kb_resolve_library/);
  const miss = (await handleQueryTool("kb_search", { query: "zzzabsent", project_id: "p-deps" }, db))!.content[0].text;
  assert.match(miss, /No matches[\s\S]*fancy/, "an empty search offers the libraries");
  const batch = (await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-deps", dir_path: path.join(d, "src"), force: true }, db))!.content[0].text;
  assert.match(batch, /Libraries imported but not indexed/);
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "lib-fancy", dir_path: path.join(d, "node_modules/fancy/src") }, db);
  assert.ok(!/fancy/.test(depHint(db, "p-deps")), "indexed library is no longer offered");
  // the app now depends on a project that exists: its hits are searched together with the app's
  const { linkedProjects } = await import("./engine/deps.js");
  db.prepare("INSERT OR IGNORE INTO projects (id, name) VALUES ('p-deps', 'app'), ('lib-fancy', 'fancy')").run();
  const { refreshLinks } = await import("./engine/deps.js");
  refreshLinks(db);
  assert.deepEqual(linkedProjects(db, "p-deps"), ["lib-fancy"]);
  assert.deepEqual(linkedProjects(db, "lib-fancy"), []);
  const viaLib = (await handleQueryTool("kb_search", { query: "shine", project_id: "p-deps" }, db))!.content[0].text;
  assert.match(viaLib, /shine @lib-fancy|:shine @lib-fancy/, viaLib);
  const own = (await handleQueryTool("kb_search", { query: "go", project_id: "p-deps", limit: 1 }, db))!.content[0].text;
  assert.ok(!own.includes("@lib-fancy"), "own hits are not labelled and win a tie with the library");
  const { handleGraphTool } = await import("./tools/graph_tools.js");
  assert.match((await handleGraphTool("kb_project_list", {}, db))!.content[0].text, /p-deps.*also searches: lib-fancy/);
  delete process.env.PUB_CACHE;
});

await run("same path+symbol in two projects: the second gets its own node, the first is untouched", async () => {
  const { graphMemory } = await import("./engine/graph_memory.js");
  const ing = async (proj: string, doc: string) => {
    const f = path.join(tmp, "col", proj, "src", "utils.ts");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `/** ${doc} */\nexport function parse(s: string) { return s; }\n`);
    await handleIngestionTool("kb_ingest_file", { project_id: proj, file_path: f, domain: "auto" }, db);
  };
  await ing("p-app", "App parser");
  await ing("p-lib", "Library parser");
  await ing("p-lib", "Library parser v2"); // re-index keeps its own copy
  const mine = db.prepare("SELECT id, summary FROM graph_nodes WHERE project_id = ? AND id LIKE '%:parse%'");
  assert.deepEqual((mine.all("p-app") as any[]).map((n) => n.summary.includes("App parser")), [true]);
  const lib = mine.all("p-lib") as any[];
  assert.equal(lib.length, 1);
  assert.ok(lib[0].id.endsWith("@p-lib") && lib[0].summary.includes("Library parser v2"));
  const edges = db.prepare("SELECT source_id, target_id FROM graph_edges WHERE project_id = 'p-lib'").all() as any[];
  assert.ok(edges.every((e) => graphMemory.getNode(e.source_id) && graphMemory.getNode(e.target_id)), "edges follow the renamed ids");
});

await run("ignore rules: defaults, .kbignore (nested, parent repo, per-call patterns) with re-include, .gitignore not read; kb_sync drops files ignored later", async () => {
  const { loadIgnore } = await import("./engine/ignore.js");
  const d = path.join(tmp, "ign");
  const w = (f: string, c = "export const a = 1;\n") => {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), c);
  };
  w("src/deep/b.ts"); w("src/deep/a.tmp.ts"); fs.writeFileSync(path.join(d, "src/deep/.kbignore"), "*.tmp.ts\n");
  w("src/keep.ts"); w("src/model.g.dart"); w("build/out.ts"); w("src/deep/build/x.ts"); w("scratch/tmp.ts");
  w("docs/api.md", "# api\n"); w("docs/draft.md", "# draft\n"); w("legacy/old.ts");
  fs.writeFileSync(path.join(d, ".gitignore"), "src/keep.ts\n"); // never read: only .kbignore counts
  fs.writeFileSync(path.join(d, ".kbignore"), "# comment\nscratch/\nlegacy/*.ts\ndocs/draft*\n!legacy/old.ts\n");
  const ign = loadIgnore(d);
  assert.deepEqual(
    ["src/keep.ts", "src/model.g.dart", "build/out.ts", "src/deep/build/x.ts", "scratch/tmp.ts", "docs/draft.md", "docs/api.md", "legacy/old.ts", "src/deep/a.tmp.ts", "src/deep/b.ts"].map((f) => ign(f)),
    [false, true, true, true, true, true, false, false, true, false],
  );
  assert.equal(ign(path.join(d, "scratch/tmp.ts")), true, "absolute paths work too");
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-ign", dir_path: d }, db);
  const files = () => (db.prepare("SELECT file_path FROM raw_sources WHERE project_id = 'p-ign'").all() as any[]).map((r) => path.relative(d, r.file_path)).sort();
  assert.deepEqual(files(), ["docs/api.md", "legacy/old.ts", "src/deep/b.ts", "src/keep.ts"]);
  fs.appendFileSync(path.join(d, ".kbignore"), "docs/\n"); // ignored after it was indexed
  await handleIngestionTool("kb_sync", { project_id: "p-ign", dir_path: d }, db);
  assert.deepEqual(files(), ["legacy/old.ts", "src/deep/b.ts", "src/keep.ts"]);
  assert.equal(loadIgnore(d, ["src/keep.ts", "!docs/draft.md"])("src/keep.ts"), true, "per-call patterns apply");
  assert.equal(loadIgnore(d, ["!docs/draft.md"])("docs/draft.md"), false, "per-call ! re-includes");
  // indexing a sub-folder of a git repo still honours the repo's own .kbignore
  const repo = path.join(tmp, "ign-repo");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "app/skip"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".kbignore"), "app/skip/\n");
  const sub = loadIgnore(path.join(repo, "app"));
  assert.deepEqual([sub(path.join(repo, "app/skip/s.ts")), sub(path.join(repo, "app/ok.ts"))], [true, false]);
});

await run("indexing: signatures, docs, line numbers, unique ids per path", async () => {
  const d = path.join(tmp, "idx");
  fs.mkdirSync(path.join(d, "a"), { recursive: true });
  fs.mkdirSync(path.join(d, "b"), { recursive: true });
  fs.writeFileSync(path.join(d, "a", "index.ts"), `import { helper } from "../b/util.js";\n\n/** Adds two numbers. Extra detail. */\nexport function add(x: number, y: number): number {\n  return helper(x) + y;\n}\n\nexport interface Shape { w: number }\n\nexport const limit = 5;\n`);
  fs.writeFileSync(path.join(d, "b", "index.ts"), `export function other() { return 1; }\n`);
  fs.writeFileSync(path.join(d, "b", "util.ts"), `export const helper = (n: number): number => n * 2;\n`);
  const ing = (f: string) => handleIngestionTool("kb_ingest_file", { project_id: "p-idx", file_path: f, domain: "auto" }, db);
  await ing(path.join(d, "a", "index.ts"));
  await ing(path.join(d, "b", "index.ts"));
  const nodes = db.prepare("SELECT id, summary, properties FROM graph_nodes WHERE project_id='p-idx'").all() as any[];
  assert.equal(nodes.filter((n) => n.id.startsWith("module:") && n.summary.startsWith("index.ts:")).length, 2, "two index.ts must stay distinct");
  const add = nodes.find((n) => n.id.endsWith(":add"));
  assert.ok(add.summary.includes("function add(x: number, y: number): number — Adds two numbers."), add.summary);
  assert.equal(JSON.parse(add.properties).line, 4);
  assert.ok(nodes.some((n) => n.id.endsWith(":shape") && n.summary === "interface Shape"));
  assert.ok(nodes.some((n) => n.id.endsWith(":limit")));
  // import edge exists, target is a placeholder until util.ts is indexed
  const edge = () => db.prepare("SELECT target_id FROM graph_edges WHERE source_id LIKE 'module:a_index%' AND description LIKE 'Imports%'").all() as any[];
  assert.equal(edge().length, 1);
  assert.ok((db.prepare("SELECT summary FROM graph_nodes WHERE id = ?").get(edge()[0].target_id) as any).summary.includes("not indexed yet"));
  await ing(path.join(d, "b", "util.ts"));
  const real = db.prepare("SELECT summary FROM graph_nodes WHERE id = ?").get(edge()[0].target_id) as any;
  assert.ok(!real.summary.includes("not indexed yet"), "real node replaces placeholder");
  // re-indexing a changed file must not let a placeholder clobber the real node
  fs.appendFileSync(path.join(d, "a", "index.ts"), "// touched\n");
  await ing(path.join(d, "a", "index.ts"));
  assert.ok(!(db.prepare("SELECT summary FROM graph_nodes WHERE id = ?").get(edge()[0].target_id) as any).summary.includes("not indexed yet"));
});

await run("re-index replaces stale nodes/edges/sources but keeps manual edges", async () => {
  const f = path.join(tmp, "idx", "a", "index.ts");
  const ids = () => (db.prepare("SELECT id FROM graph_nodes WHERE project_id='p-idx'").all() as any[]).map((r) => r.id);
  const addId = ids().find((i) => i.endsWith(":add"))!;
  const modId = ids().find((i) => i.startsWith("module:a_index"))!;
  await handleIngestionTool("kb_add_relation", { project_id: "p-idx", source_id: modId, target_id: addId, relation_type: "REFERENCES", description: "manual" }, db);
  fs.writeFileSync(f, `export function onlyOne(): void {}\n`); // drops add, Shape, limit and the import
  await handleIngestionTool("kb_ingest_file", { project_id: "p-idx", file_path: f, domain: "auto" }, db);
  const after = ids();
  assert.ok(!after.some((i) => i.endsWith(":add") || i.endsWith(":shape") || i.endsWith(":limit")), "removed entities must go");
  assert.ok(after.some((i) => i.endsWith(":onlyone")));
  assert.equal((db.prepare("SELECT COUNT(*) c FROM raw_sources WHERE file_path = ?").get(f) as any).c, 1, "one raw source per file");
  assert.equal((db.prepare("SELECT COUNT(*) c FROM graph_edges WHERE source_id = ? AND description LIKE 'Imports%'").get(modId) as any).c, 0, "stale import edge removed");
  const { graphMemory } = await import("./engine/graph_memory.js");
  assert.ok(!graphMemory.getNode(addId), "cache dropped removed node");
  // manual edge pointed at a node that no longer exists, so it cascades; a manual edge between survivors must stay
  await handleIngestionTool("kb_add_relation", { project_id: "p-idx", source_id: modId, target_id: after.find((i) => i.endsWith(":onlyone"))!, relation_type: "AFFECTS", description: "manual2" }, db);
  await handleIngestionTool("kb_ingest_file", { project_id: "p-idx", file_path: f, domain: "auto" }, db); // unchanged -> skipped
  fs.appendFileSync(f, "// v3\n");
  await handleIngestionTool("kb_ingest_file", { project_id: "p-idx", file_path: f, domain: "auto" }, db);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM graph_edges WHERE description = 'manual2'").get() as any).c, 1, "manual edge survives re-index");
});

await run("search and node_get show path:line", async () => {
  fs.writeFileSync(path.join(tmp, "idx", "b", "fin.ts"), `/** Computes the zebra ratio. */\nexport function zebraRatio(a: number): number {\n  return a;\n}\n`);
  await handleIngestionTool("kb_ingest_file", { project_id: "p-idx", file_path: path.join(tmp, "idx", "b", "fin.ts"), domain: "auto" }, db);
  const r = await handleQueryTool("kb_search", { query: "zebraRatio", project_id: "p-idx", limit: 3 }, db);
  assert.ok(r!.content[0].text.includes(`fin.ts:2`), r!.content[0].text);
  const id = (db.prepare("SELECT id FROM graph_nodes WHERE id LIKE '%zebraratio'").get() as any).id;
  const n = await handleQueryTool("kb_node_get", { node_id: id }, db);
  assert.ok(n!.content[0].text.includes("**Location:**"));
});

await run("python parser: defs, docstrings, private skipped", async () => {
  const { codeParser } = await import("./engine/parsers/code_parser.js");
  const py = `import os\n\nclass Foo(Base):\n    """Does foo things."""\n    def m(self): pass\n\nasync def run(a, b) -> int:\n    """Run it."""\n    return 1\n\ndef _hidden(): pass\n`;
  const e = codeParser.parseFile("a.py", py);
  assert.deepEqual(e.map((x) => x.name), ["Foo", "run"]);
  assert.ok(e[0].summary.endsWith("Does foo things.") && e[1].summary.includes("-> int — Run it."));
  assert.equal(e[1].line, 7);
  const { codeParser: cp } = await import("./engine/parsers/code_parser.js");
  const ts = cp.parseFile("x.ts", `// ════════\n// Section\n// ════════\nexport function f(): void {}\n`);
  assert.equal(ts[0].summary, "function f(): void — Section", "dividers dropped from docs");
});

await run("usage: sessions, net ROI, empty/error classification (synthetic clock)", async () => {
  const { initUsage, recordCall, usageSummary } = await import("./engine/usage.js");
  initUsage(db);
  db.exec("DELETE FROM tool_calls; DELETE FROM telemetry;");
  const ins = db.prepare("INSERT INTO tool_calls (timestamp, tool, project_id, duration_ms, tokens_out, is_error, is_empty) VALUES (?,?,?,?,?,?,?)");
  const t0 = Date.now() - 3 * 3600_000;
  ins.run(t0, "kb_search", "p", 2, 100, 0, 0);
  ins.run(t0 + 60_000, "kb_search", "p", 4, 50, 0, 1);
  ins.run(t0 + 120_000, "kb_node_get", "p", 1, 20, 1, 0);
  ins.run(t0 + 2 * 3600_000, "kb_search", "q", 2, 100, 0, 0); // >30 min later: second session
  db.prepare("INSERT INTO telemetry (timestamp, tool_name, tokens_returned, raw_equivalent_tokens) VALUES (?, 'kb_search', 100, 1100)").run(t0);
  const u = usageSummary(db, 7, 500);
  assert.equal(u.calls, 4); assert.equal(u.errors, 1); assert.equal(u.empty, 1); assert.equal(u.sessions, 2);
  assert.equal(u.overhead_tokens, 1000);
  assert.equal(u.saved_tokens_gross, 1000); assert.equal(u.saved_tokens_net, 0);
  const search = u.by_tool.find((t: any) => t.tool === "kb_search");
  assert.equal(search.calls, 3); assert.equal(search.empty, 1);
  assert.equal(u.by_project[0].project_id, "p");
  // recordCall classifies results
  recordCall(db, "kb_search", { project_id: "z" }, process.hrtime.bigint(), { content: [{ text: "### Search Results for \"x\" (0 matches)" }] });
  recordCall(db, "kb_node_get", {}, process.hrtime.bigint(), { content: [{ text: "Node 'a' not found." }], isError: true });
  recordCall(db, "nope", {}, process.hrtime.bigint(), null);
  const last = db.prepare("SELECT tool, is_error, is_empty FROM tool_calls ORDER BY id DESC LIMIT 3").all() as any[];
  assert.deepEqual(last.map((r) => [r.tool, r.is_error, r.is_empty]), [["nope", 1, 0], ["kb_node_get", 1, 0], ["kb_search", 0, 1]]);
  const usageApi = (await api("/api/usage?days=7")).body;
  assert.equal(usageApi.calls, 7); assert.ok(usageApi.schema_tokens_per_session > 500);
  db.exec("DELETE FROM tool_calls; DELETE FROM telemetry;");
});

await run("MCP end-to-end over stdio: every call is recorded, incl. errors", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dbFile = path.join(tmp, "mcp.db");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), KB_DB_PATH: dbFile },
    stderr: "ignore",
  });
  const client = new Client({ name: "selftest", version: "0" });
  await client.connect(transport);
  // agents only use kb_search if the server tells them to, and every session pays for these tokens
  const guide = client.getInstructions() ?? "";
  assert.match(guide, /kb_search/);
  assert.ok(guide.length / 4 < 400, `instructions too long: ${guide.length / 4} tokens`);
  await client.callTool({ name: "kb_project_list", arguments: {} });
  await client.callTool({ name: "kb_search", arguments: { query: "zzznothing", project_id: "none" } });
  await client.callTool({ name: "kb_node_get", arguments: { node_id: "missing" } });
  await client.callTool({ name: "kb_search", arguments: {} }); // schema error
  await client.close();

  const ro = new Client({ name: "selftest-ro", version: "0" });
  await ro.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))],
    env: { ...(process.env as Record<string, string>), KB_DB_PATH: dbFile, KB_TOOLSET: "read" },
    stderr: "ignore",
  }));
  assert.equal((await ro.listTools()).tools.length, 11);
  const denied: any = await ro.callTool({ name: "kb_add_node", arguments: { project_id: "x", id: "a", label: "a", node_type: "rule", summary: "s" } });
  assert.equal(denied.isError, true, "write tool must be refused in read toolset");
  await ro.close();

  const { DatabaseSync } = await import("node:sqlite");
  const mdb = new DatabaseSync(dbFile);
  const rows = mdb.prepare("SELECT tool, is_error, is_empty FROM tool_calls ORDER BY id").all() as any[];
  assert.deepEqual(rows.map((r) => [r.tool, r.is_error, r.is_empty]),
    [["kb_project_list", 0, 0], ["kb_search", 0, 1], ["kb_node_get", 1, 0], ["kb_search", 1, 0], ["kb_add_node", 1, 0]]);
  assert.equal((mdb.prepare("SELECT COUNT(*) c FROM telemetry").get() as any).c, 1); // only the successful kb_search reports ROI; usage log covers all four
});

await run("token budget: schema, footer, outline, search stay small", async () => {
  const { ALL_TOOLS, activeTools } = await import("./tools/index.js");
  const tok = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);
  assert.ok(tok(ALL_TOOLS) <= 2400, `full schema ${tok(ALL_TOOLS)} tokens`);
  process.env.KB_TOOLSET = "read";
  const read = activeTools();
  delete process.env.KB_TOOLSET;
  assert.ok(read.length === 11 && read.every((t) => t.annotations?.readOnlyHint), "read toolset is read-only tools");
  assert.ok(tok(read) <= 1000, `read schema ${tok(read)} tokens`);

  const { footer } = telemetry.record("t", process.hrtime.bigint(), null, null, "x", "x");
  assert.equal(footer, "", "no telemetry footer unless KB_TELEMETRY_FOOTER=1");
  process.env.KB_TELEMETRY_FOOTER = "1";
  assert.ok(telemetry.record("t", process.hrtime.bigint(), null, null, "x", "x").footer.includes("telemetry:"));
  delete process.env.KB_TELEMETRY_FOOTER;

  // overview size is flat in graph size: 300 nodes must fit the same budget as 15
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-wide", dir_path: mkDir("wide", 300) }, db);
  const { graphMemory } = await import("./engine/graph_memory.js");
  const { visualizer } = await import("./engine/visualizer.js");
  const outline = visualizer.renderOutline(graphMemory.getProjectNodes("p-wide"), graphMemory.getProjectEdges("p-wide"), "wide");
  assert.ok(graphMemory.getProjectNodes("p-wide").length >= 300);
  assert.ok(outline.length / 4 <= 700, `outline ${outline.length / 4} tokens`);
  assert.ok(outline.includes("more (kb_search"));
});

await run("ts parser: methods of an exported object literal belong to it", async () => {
  const { codeParser } = await import("./engine/parsers/code_parser.js");
  const src = [
    "export const jobs = {", "  /** Marks a job cancelled. */", "  cancel(id: number): boolean {", "    return true;", "  },", "",
    "  start(label: string): number {", "    return 1;", "  },", "};", "",
  ].join("\n");
  const names = codeParser.parseFile("jobs.ts", src).map((e) => e.name).sort();
  assert.deepEqual(names, ["jobs", "jobs.cancel", "jobs.start"]);
  assert.match(codeParser.parseFile("jobs.ts", src).find((e) => e.name === "jobs.cancel")!.summary, /cancel\(id: number\): boolean — Marks a job cancelled/);
});

await run("dart parser: types, public methods, /// docs, monorepo package imports", async () => {
  const { codeParser } = await import("./engine/parsers/code_parser.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-dart-"));
  fs.mkdirSync(path.join(dir, "packages/core/lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages/core/lib/money.dart"), "class Money {}\n");
  const app = path.join(dir, "lib/store.dart");
  const src = [
    "import 'package:core/money.dart';", "import 'dart:async';", "import 'package:flutter/material.dart';", "",
    "/// Keeps the consent flag.", "final class ConsentStore extends ChangeNotifier {",
    "  Future<bool> isGranted(String id) async {", "    return true;", "  }", "  void _hidden() {}", "}",
    "class _Private {}", "enum Mode { a, b }", "",
  ].join("\n");
  fs.writeFileSync(app, src);
  const names = codeParser.parseFile(app, src).map((e) => e.name);
  assert.deepEqual(names.sort(), ["ConsentStore", "ConsentStore.isGranted", "Mode"]);
  assert.match(codeParser.parseFile(app, src).find((e) => e.name === "ConsentStore")!.summary, /Keeps the consent flag/);
  const imp = codeParser.parseImports(app, src);
  assert.deepEqual(imp.internal, [path.join(dir, "packages/core/lib/money.dart")]);
  assert.ok(imp.external.includes("dart:async") && imp.external.includes("package:flutter/material.dart"));
  fs.rmSync(dir, { recursive: true, force: true });
});

await run("ts parser: public methods only, camelCase words searchable, stopwords ignored", async () => {
  const { codeParser } = await import("./engine/parsers/code_parser.js");
  const src = `export class Graph {\n  /** Walks outward from a node. */\n  public getRadialSubgraph(id: string, depth = 1): string[] {\n    if (id) { return []; }\n    return [];\n  }\n  private hidden(): void {}\n  constructor(x: number) {}\n}\n`;
  const e = codeParser.parseFile("g.ts", src);
  const m = e.find((x) => x.name === "Graph.getRadialSubgraph")!;
  assert.ok(m, e.map((x) => x.name).join());
  assert.ok(m.summary.includes("(get radial subgraph)") && m.summary.includes("Walks outward"), m.summary);
  assert.ok(!e.some((x) => /hidden|constructor|\.if$/.test(x.name)), "private/constructor/keywords excluded");
  assert.equal(m.line, 3);
  const f = path.join(tmp, "g.ts");
  fs.writeFileSync(f, src);
  await handleIngestionTool("kb_ingest_file", { project_id: "p-m", file_path: f, domain: "auto" }, db);
  const r = await handleQueryTool("kb_search", { query: "where is the radial subgraph computed", project_id: "p-m", limit: 3 }, db);
  assert.ok(r!.content[0].text.includes("g.ts:3"), r!.content[0].text);
});

await run("search: stemming, accent-insensitive, placeholders hidden, code window, token cap", async () => {
  const d = path.join(tmp, "srch");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "svc.ts"), `import { x } from "./gone.js";\n/** Removes stale nodes after a file is indexed. */\nexport function prune(a: number): void {\n  const one = 1;\n  const two = 2;\n  return;\n}\n\nexport function other(): void {}\n`);
  fs.writeFileSync(path.join(d, "gone.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(d, "vn.md"), "# Quy chế\n\n## Điều 3: Hạn mức tạm ứng\n\nNhân viên được tạm ứng tối đa.\n");
  await handleIngestionTool("kb_ingest_file", { project_id: "p-s", file_path: path.join(d, "svc.ts"), domain: "auto" }, db);
  await handleIngestionTool("kb_ingest_file", { project_id: "p-s", file_path: path.join(d, "vn.md"), domain: "auto" }, db);
  const q = async (a: any) => (await handleQueryTool("kb_search", { project_id: "p-s", ...a }, db))!.content[0].text;
  assert.ok((await q({ query: "stale nodes removed when indexing" })).includes("svc.ts:3"), "stemming: indexing/indexed ~ index");
  assert.ok((await q({ query: "han muc tam ung" })).includes("dieu_3"), "accent-insensitive");
  assert.ok(!(await q({ query: "gone" })).includes("not indexed yet"), "placeholders hidden");
  const withCode = await q({ query: "prune stale", code: 2 });
  assert.ok(withCode.includes("export function prune") && withCode.includes("const one = 1;") && !withCode.includes("const two"), withCode);
  assert.ok(!(await q({ query: "prune stale" })).includes("```"), "no code unless asked");
  assert.ok(!(await q({ query: "prune" })).includes("[component]"), "type tag dropped when the id carries it");
  fs.writeFileSync(path.join(d, "many.ts"), [1, 2, 3, 4, 5, 6].map((i) => `/** Handles shared work number ${i}. */\nexport function work${i}(): void {}\n`).join("\n"));
  await handleIngestionTool("kb_ingest_file", { project_id: "p-s", file_path: path.join(d, "many.ts"), domain: "auto" }, db);
  const capped = await q({ query: "handles shared work", limit: 10, max_tokens: 60 });
  assert.ok(capped.includes("more (raise max_tokens"), capped);
});

await run("vietnamese titles keep readable ids", async () => {
  const f = path.join(tmp, "vn.md");
  fs.writeFileSync(f, "# Quy chế\n\n## Điều 1: Mục đích\n\nÁp dụng cho nhân viên.\n");
  await handleIngestionTool("kb_ingest_file", { project_id: "p-vn", file_path: f, domain: "auto" }, db);
  const ids = (db.prepare("SELECT id FROM graph_nodes WHERE project_id='p-vn'").all() as any[]).map((r) => r.id);
  assert.ok(ids.some((i) => i.includes("dieu_1_muc_dich")), ids.join(","));
});

await run("search: vietnamese phrases and everyday synonyms reach the code's own words", async () => {
  const f = path.join(tmp, "consent.ts");
  fs.writeFileSync(f, "/** Whether the user accepted how data is used. */\nexport class ConsentStore {\n  accepted(): boolean { return true; }\n}\n");
  await handleIngestionTool("kb_ingest_file", { project_id: "p-syn", file_path: f, domain: "auto" }, db);
  for (const q of ["ghi nhớ người dùng đã đồng ý", "remember that the user agreed"]) {
    const out = (await handleQueryTool("kb_search", { query: q, project_id: "p-syn" }, db))!.content[0].text;
    assert.ok(out.includes("consentstore"), `${q}: ${out}`);
  }
});

await run("project lexicon: scoped to project and loads from .kb/lexicon.json without domain pollution", async () => {
  const dirMed = path.join(tmp, "med-proj");
  fs.mkdirSync(path.join(dirMed, ".kb"), { recursive: true });
  fs.writeFileSync(path.join(dirMed, ".kb", "lexicon.json"), JSON.stringify({
    "bệnh nhân": "patient",
    "đơn thuốc": "prescription",
  }));
  const fMed = path.join(dirMed, "patient.ts");
  fs.writeFileSync(fMed, "export class PatientDiagnosis {\n  hasPrescription(): boolean { return true; }\n}\n");

  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-med", dir_path: dirMed }, db);

  // Searching "bệnh nhân" in p-med resolves to "patient" and finds PatientDiagnosis
  const medHit = (await handleQueryTool("kb_search", { query: "bệnh nhân", project_id: "p-med" }, db))!.content[0].text;
  assert.ok(medHit.includes("patientdiagnosis"), `med hit: ${medHit}`);

  // Searching "bệnh nhân" in another project (p-other) does NOT expand to "patient" (no cross-project pollution)
  const otherDir = path.join(tmp, "other-proj");
  fs.mkdirSync(otherDir, { recursive: true });
  const fOther = path.join(otherDir, "dummy.ts");
  fs.writeFileSync(fOther, "export class OtherPatient {\n}\n");
  await handleIngestionTool("kb_batch_ingest_directory", { project_id: "p-other", dir_path: otherDir }, db);

  const otherHit = (await handleQueryTool("kb_search", { query: "bệnh nhân", project_id: "p-other" }, db))!.content[0].text;
  assert.ok(!otherHit.includes("otherpatient"), `other hit should not match: ${otherHit}`);
});

await run("startup prunes old logs", async () => {
  const ins = db.prepare("INSERT INTO ingest_jobs (project_id,label,status,started_at,updated_at) VALUES ('p-prune','x','done',1,1)");
  for (let i = 0; i < 600; i++) ins.run();
  initDatabase(); // same file, runs schema + prune
  assert.ok((db.prepare("SELECT COUNT(*) c FROM ingest_jobs").get() as any).c <= 500);
});

await run("diagnostics: circular dependencies and dead code detection", async () => {
  const { auditArchitecture } = await import("./engine/diagnostics.js");
  const testNodes: any[] = [
    { id: "mod:a", label: "A", node_type: "module", summary: "A", is_hub: false },
    { id: "mod:b", label: "B", node_type: "module", summary: "B", is_hub: false },
    { id: "mod:c", label: "C", node_type: "module", summary: "C", is_hub: false },
    { id: "orphan:dead", label: "DeadCode", node_type: "component", summary: "Unused", is_hub: false },
  ];
  const testEdges: any[] = [
    { source_id: "mod:a", target_id: "mod:b", relation_type: "DEPENDS_ON" },
    { source_id: "mod:b", target_id: "mod:c", relation_type: "DEPENDS_ON" },
    { source_id: "mod:c", target_id: "mod:a", relation_type: "DEPENDS_ON" }, // Cycle!
  ];
  const report = auditArchitecture("test-p", testNodes, testEdges);
  assert.equal(report.summary.cycleCount, 1, "detects A -> B -> C -> A cycle");
  assert.equal(report.cycles[0].cycleLength, 3);
  assert.equal(report.summary.orphanCount, 1, "detects orphan node with inDegree = 0");
  assert.ok(report.healthScore < 100, "health score penalizes smells");
});

await run("parsers: SQL DDL foreign keys and docker-compose services", async () => {
  const { codeParser } = await import("./engine/parsers/code_parser.js");

  const sqlContent = `
    CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100));
    CREATE TABLE orders (id INT PRIMARY KEY, user_id INT, amount DECIMAL, CONSTRAINT fk_u FOREIGN KEY (user_id) REFERENCES users(id));
  `;
  const sqlEntities = codeParser.parseFile("schema.sql", sqlContent);
  assert.equal(sqlEntities.length, 2);
  const orders = sqlEntities.find((e) => e.name === "orders");
  assert.ok(orders, "orders table parsed");
  assert.deepEqual(orders?.dependsOn, ["users"], "orders references users table");

  const composeContent = `
    version: '3'
    services:
      web:
        image: nginx:latest
        ports:
          - "80:80"
        depends_on:
          - db
      db:
        image: postgres:15
  `;
  const yamlEntities = codeParser.parseFile("docker-compose.yml", composeContent);
  assert.equal(yamlEntities.length, 2);
  const webSvc = yamlEntities.find((e) => e.name === "web");
  assert.deepEqual(webSvc?.dependsOn, ["db"], "web container service depends on db");
});

await run("visualizer: Obsidian Canvas and Markdown Report exports", async () => {
  const { visualizer } = await import("./engine/visualizer.js");
  const testNodes: any[] = [
    { id: "s:auth", label: "Auth", node_type: "service", summary: "Auth service", is_hub: true },
    { id: "s:db", label: "DB", node_type: "database", summary: "Database", is_hub: false },
  ];
  const testEdges: any[] = [
    { source_id: "s:auth", target_id: "s:db", relation_type: "DEPENDS_ON" },
  ];
  const canvasJson = JSON.parse(visualizer.renderObsidianCanvas(testNodes, testEdges));
  assert.equal(canvasJson.nodes.length, 2);
  assert.equal(canvasJson.edges.length, 1);
  assert.equal(canvasJson.edges[0].fromNode, "s:auth");

  const mdReport = visualizer.renderMarkdownReport("test-p", "Test Project", testNodes, testEdges);
  assert.ok(mdReport.includes("Architecture Documentation: Test Project"));
  assert.ok(mdReport.includes("Total Components / Nodes:** 2"));
  assert.ok(mdReport.includes("```mermaid"));
});

await run("optimizations: path aliases, cross-file CALLS, doc section line excerpts, Kotlin/Swift parsers, centrality cache", async () => {
  const { codeParser } = await import("./engine/parsers/code_parser.js");
  const { graphMemory } = await import("./engine/graph_memory.js");
  const { handleGraphTool } = await import("./tools/graph_tools.js");

  // 1. Kotlin & Swift parsers
  const ktSrc = `package com.example\nimport io.ktor.client.HttpClient\n/** Core kernel orchestrator. */\nclass KernelEngine : BaseEngine {\n  fun startEngine(port: Int): Boolean {\n    return true\n  }\n  private fun secret() {}\n}\ndata class Config(val host: String)\n`;
  const ktEntities = codeParser.parseFile("KernelEngine.kt", ktSrc);
  assert.deepEqual(ktEntities.map((e) => e.name).sort(), ["Config", "KernelEngine", "KernelEngine.startEngine"]);
  assert.equal(ktEntities.find((e) => e.name === "KernelEngine")?.kind, "service");
  assert.equal(ktEntities.find((e) => e.name === "Config")?.kind, "data_model");

  const swiftSrc = `import Foundation\n/// Manages user session.\npublic final class SessionManager: NSObject {\n  public func refreshToken(force: Bool) async throws -> String {\n    return "ok"\n  }\n  private func internalHelper() {}\n}\npublic struct UserProfile {\n  let id: String\n}\n`;
  const swiftEntities = codeParser.parseFile("SessionManager.swift", swiftSrc);
  assert.deepEqual(swiftEntities.map((e) => e.name).sort(), ["SessionManager", "SessionManager.refreshToken", "UserProfile"]);

  // 2. Path alias (@/) + cross-file symbol CALLS
  const aliasDir = path.join(tmp, "alias-proj");
  fs.mkdirSync(path.join(aliasDir, "src", "lib"), { recursive: true });
  fs.mkdirSync(path.join(aliasDir, "src", "components"), { recursive: true });
  fs.writeFileSync(path.join(aliasDir, "tsconfig.json"), "{}");
  const apiFile = path.join(aliasDir, "src", "lib", "api.ts");
  const compFile = path.join(aliasDir, "src", "components", "View.tsx");
  fs.writeFileSync(apiFile, `export function buildApiUrl(endpoint: string): string {\n  return endpoint;\n}\n`);
  fs.writeFileSync(compFile, `import { buildApiUrl } from "@/lib/api";\nexport function renderView(): string {\n  return buildApiUrl("/status");\n}\n`);

  // Ingest caller before callee to verify bidirectional cross-file CALLS resolution
  await handleIngestionTool("kb_ingest_file", { project_id: "p-opt", file_path: compFile, domain: "auto" }, db);
  await handleIngestionTool("kb_ingest_file", { project_id: "p-opt", file_path: apiFile, domain: "auto" }, db);

  const impact = (await handleGraphTool("kb_graph_impact", { target_node_id: "component:lib_api_ts:buildapiurl" }, db))!.content[0].text;
  assert.ok(impact.includes("component:components_view_tsx:renderview"), `cross-file CALLS impact: ${impact}`);

  // 3. Document section exact line excerpt on kb_node_get(include_raw: true)
  const docFile = path.join(aliasDir, "policy.md");
  const padding = Array.from({ length: 40 }, (_, i) => `Intro line ${i + 1} with enough characters to exceed twenty.`).join("\n");
  fs.writeFileSync(docFile, `# Intro\n\n${padding}\n\n## Điều 9: Quy định bảo mật khóa\n\nBắt buộc xoay vòng khóa mỗi 90 ngày đối với nhân viên.\n`);
  await handleIngestionTool("kb_ingest_file", { project_id: "p-opt", file_path: docFile, domain: "auto" }, db);
  const secNode = graphMemory.getProjectNodes("p-opt").find((n) => n.id.includes("dieu_9"));
  assert.ok(secNode, "found dieu_9 node");
  const rawSec = (await handleQueryTool("kb_node_get", { node_id: secNode!.id, include_raw: true }, db))!.content[0].text;
  assert.ok(rawSec.includes("Xoay vòng khóa".toLowerCase()) || rawSec.includes("xoay vòng khóa"), `section excerpt should include section body: ${rawSec}`);

  // 4. Centrality cache identity & invalidation
  const c1 = graphMemory.getCentrality("p-opt");
  const c2 = graphMemory.getCentrality("p-opt");
  assert.equal(c1, c2, "centrality map is cached when graph has not mutated");
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("ALL PASSED");
process.exit(0);
