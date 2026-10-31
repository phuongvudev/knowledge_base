import fs from "node:fs";
import path from "node:path";

// Generated code, build output and vendored files: noise for an agent, and often huge
const DEFAULT_RULES = `
node_modules/
dist/
build/
out/
coverage/
target/
vendor/
__pycache__/
venv/
.dart_tool/
Pods/
.gradle/
.next/
*.g.dart
*.freezed.dart
*.gr.dart
*.mocks.dart
*.pb.dart
*_plugin_registrant.dart
*.min.*
*.map
*.d.ts
*.lock
*-lock.*
`;

// One gitignore line -> [regex over a root-relative posix path, negated]
function compile(line: string): [RegExp, boolean] | null {
  let rule = line.trim();
  if (!rule || rule.startsWith("#")) return null;
  const negated = rule.startsWith("!");
  if (negated) rule = rule.slice(1);
  const dirOnly = rule.endsWith("/");
  if (dirOnly) rule = rule.slice(0, -1);
  const anchored = rule.startsWith("/") || rule.includes("/");
  rule = rule.replace(/^\//, "");
  const body = rule
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\/\*\*/g, "\u0001")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, "/.*");
  // a directory rule only matches when something lies below it; any rule also covers everything under a match
  return [new RegExp(`${anchored ? "^" : "(?:^|/)"}${body}${dirOnly ? "/.+$" : "(?:/.*)?$"}`), negated];
}

const IGNORE_FILE = ".kbignore";

/**
 * Ignore test for files under `root`. The user decides what is noise; later lines win, so "!pattern" re-includes:
 * built-in defaults, then every .kbignore from the repo root (nearest ancestor with .git, or `root` itself) down to
 * the file's own folder, each read relative to the folder it sits in, then `extra` patterns passed with the call.
 * Takes an absolute or root-relative path. .gitignore is deliberately not read.
 */
export function loadIgnore(root: string, extra: string[] = []): (file: string) => boolean {
  root = path.resolve(root);
  const outer: string[] = [];
  if (!fs.existsSync(path.join(root, ".git"))) {
    // indexing a sub-folder of a repo: the repo's ignore files still apply
    const up: string[] = [];
    for (let d = path.dirname(root), i = 0; i < 10; d = path.dirname(d), i++) {
      up.unshift(d);
      if (fs.existsSync(path.join(d, ".git"))) {
        outer.push(...up);
        break;
      }
      if (d === path.dirname(d)) break;
    }
  }
  const defaults = DEFAULT_RULES.split("\n").map(compile).filter(Boolean) as [RegExp, boolean][];
  const extraRules = extra.map(compile).filter(Boolean) as [RegExp, boolean][];
  const cache = new Map<string, [RegExp, boolean][]>();
  const rulesIn = (dir: string) => {
    let rules = cache.get(dir);
    if (!rules) {
      rules = [];
      try {
        const lines = fs.readFileSync(path.join(dir, IGNORE_FILE), "utf-8").split(/\r?\n/);
        rules.push(...(lines.map(compile).filter(Boolean) as [RegExp, boolean][]));
      } catch {
        // no such file
      }
      cache.set(dir, rules);
    }
    return rules;
  };
  const posix = (p: string) => p.split(path.sep).join("/");

  return (file) => {
    const abs = path.isAbsolute(file) ? file : path.join(root, file);
    const rel = posix(path.relative(root, abs));
    let ignored = false;
    for (const [re, negated] of defaults) if (re.test(rel)) ignored = !negated;
    if (rel.startsWith("..")) return ignored;
    const chain = [...outer, root];
    let dir = root;
    for (const part of path.relative(root, path.dirname(abs)).split(path.sep).filter(Boolean)) chain.push((dir = path.join(dir, part)));
    for (const base of chain) {
      for (const [re, negated] of rulesIn(base)) if (re.test(posix(path.relative(base, abs)))) ignored = !negated;
    }
    for (const [re, negated] of extraRules) if (re.test(rel)) ignored = !negated;
    return ignored;
  };
}
