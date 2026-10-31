import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import type { DatabaseInstance } from "../database.js";
import { codeParser } from "./parsers/code_parser.js";

export interface Dep {
  name: string;
  files: number;
  /** local directory holding the package source, if we can find one */
  source: string | null;
  /** project that already indexes that directory */
  indexedAs: string | null;
}

const TEST_FILE = /(^|\/)(tests?|__tests__|integration_test)\/|[._]test\.|\.spec\./;
const NODE_BUILTINS = new Set(builtinModules);

// "package:foo/x.dart" -> foo, "@a/b/c" -> @a/b, "lodash/fp" -> lodash; null for sdk/builtin imports
function packageName(spec: string): string | null {
  if (spec.startsWith("dart:") || spec.startsWith("node:")) return null;
  if (spec.startsWith("package:")) return spec.slice(8).split("/")[0] || null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  // path aliases ("@/lib") and strings that only look like imports are not packages
  return NODE_BUILTINS.has(name) || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name) ? null : name;
}

// The version pubspec.lock pins; undefined when there is no lock or the package is not in it
export function lockedVersion(name: string, fromFile: string): string | undefined {
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const lock = path.join(dir, "pubspec.lock");
    if (fs.existsSync(lock)) return new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    version: "([^"]+)"`, "m").exec(fs.readFileSync(lock, "utf-8"))?.[1];
    if (dir === path.dirname(dir)) return undefined;
  }
}

// shortcut: without a lock entry, the newest pub-cache version wins; npm uses the nearest node_modules (what is installed).
export function locate(name: string, fromFile: string): string | null {
  if (fromFile.endsWith(".dart")) {
    const hosted = path.join(process.env.PUB_CACHE || path.join(os.homedir(), ".pub-cache"), "hosted", "pub.dev");
    if (!fs.existsSync(hosted)) return null;
    const locked = lockedVersion(name, fromFile);
    if (locked && fs.existsSync(path.join(hosted, `${name}-${locked}`))) return path.join(hosted, `${name}-${locked}`, "lib");
    const newest = fs.readdirSync(hosted)
      .filter((d) => d.startsWith(name + "-") && /^\d/.test(d.slice(name.length + 1)))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
    return newest ? path.join(hosted, newest, "lib") : null;
  }
  for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(pkg, "package.json"))) return fs.existsSync(path.join(pkg, "src")) ? path.join(pkg, "src") : pkg;
    if (dir === path.dirname(dir)) return null;
  }
}

/** Third-party packages a project imports, most used first, with where their source lives and whether it is indexed. */
export function listDeps(db: DatabaseInstance, projectId: string): Dep[] {
  const rows = db
    .prepare(`SELECT file_path, content FROM raw_sources WHERE project_id = ? AND source_type IN ('ts','tsx','js','jsx','mjs','dart') AND content IS NOT NULL`)
    .all(projectId) as { file_path: string; content: string }[];
  const used = new Map<string, { files: number; from: string }>();
  for (const r of rows) {
    if (TEST_FILE.test(r.file_path)) continue; // dev-only imports (the test package, mocks) are not worth indexing
    const names = new Set(codeParser.parseImports(r.file_path, r.content).external.map(packageName).filter(Boolean) as string[]);
    for (const n of names) used.set(n, { files: (used.get(n)?.files ?? 0) + 1, from: used.get(n)?.from ?? r.file_path });
  }
  const indexed = db.prepare(`SELECT project_id FROM raw_sources WHERE file_path LIKE ? ESCAPE '\\' LIMIT 1`);
  return [...used.entries()]
    .map(([name, u]) => {
      const source = locate(name, u.from);
      const hit = source ? (indexed.get(source.replace(/[\\%_]/g, "\\$&") + "/%") as { project_id: string } | undefined) : undefined;
      return { name, files: u.files, source, indexedAs: hit?.project_id ?? null };
    })
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
}

/** Finds a specific dependency for a project, looking up version and local path. */
export function findDep(
  db: DatabaseInstance,
  projectId: string,
  libraryName: string
): { name: string; source: string | null; indexedAs: string | null; version?: string } | null {
  const cleanName = libraryName.replace(/^(package:|lib-)/, "").replace(/\/.*$/, "").trim().toLowerCase();
  const all = listDeps(db, projectId);
  const found =
    all.find((d) => d.name.toLowerCase() === cleanName) ||
    all.find((d) => d.name.toLowerCase().includes(cleanName) || cleanName.includes(d.name.toLowerCase()));

  const sample = db
    .prepare("SELECT file_path FROM raw_sources WHERE project_id = ? AND source_type IN ('dart','ts','js','tsx','jsx') LIMIT 1")
    .get(projectId) as { file_path: string } | undefined;

  if (found) {
    const version = sample?.file_path ? lockedVersion(found.name, sample.file_path) : undefined;
    return { ...found, version };
  }

  // Fallback: direct locate via sample file in project
  if (sample?.file_path) {
    const source = locate(cleanName, sample.file_path);
    if (source) {
      const indexed = db.prepare(`SELECT project_id FROM raw_sources WHERE file_path LIKE ? ESCAPE '\\' LIMIT 1`);
      const hit = indexed.get(source.replace(/[\\%_]/g, "\\$&") + "/%") as { project_id: string } | undefined;
      const version = lockedVersion(cleanName, sample.file_path);
      return { name: cleanName, source, indexedAs: hit?.project_id ?? null, version };
    }
  }

  return null;
}

/** One line for the end of an indexing result or an empty search: libraries worth offering to index. "" when none. */
export function depHint(db: DatabaseInstance, projectId: string): string {
  const todo = listDeps(db, projectId).filter((d) => d.source && !d.indexedAs);
  if (!todo.length) return "";
  const top = todo.slice(0, 3).map((d) => `${d.name} → ${d.source}`).join(", ");
  return `\nLibraries imported but not indexed (use kb_resolve_library(project_id, name, auto_ingest=true) to auto-index): ${top}${todo.length > 3 ? ` (+${todo.length - 3} more)` : ""}`;
}

/**
 * Rebuild project links: A -> L when A imports a library whose source is indexed as project L.
 * shortcut: re-reads every project's imports each time (a second or so for ~1000 files); cache per project if it gets slow.
 */
export function refreshLinks(db: DatabaseInstance): void {
  const projects = (db.prepare(`SELECT id FROM projects`).all() as { id: string }[]).map((p) => p.id);
  const links: [string, string][] = [];
  for (const id of projects) {
    for (const linked of new Set(listDeps(db, id).map((d) => d.indexedAs))) if (linked && linked !== id) links.push([id, linked]);
  }
  db.exec("BEGIN");
  try {
    db.exec(`DELETE FROM project_links`);
    const ins = db.prepare(`INSERT OR IGNORE INTO project_links (project_id, linked_id) VALUES (?, ?)`);
    for (const [a, b] of links) ins.run(a, b);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Library projects `projectId` depends on (only ones that still exist). */
export function linkedProjects(db: DatabaseInstance, projectId: string): string[] {
  return (db.prepare(`SELECT l.linked_id AS id FROM project_links l JOIN projects p ON p.id = l.linked_id WHERE l.project_id = ? ORDER BY l.linked_id`).all(projectId) as { id: string }[]).map((r) => r.id);
}
