import path from "path";
import fs from "fs";

export interface ParsedCodeEntity {
  name: string;
  kind: "service" | "component" | "api_endpoint" | "data_model" | "config";
  summary: string;
  calls: string[];
  dependsOn: string[];
  storesIn: string[];
  line?: number;
  end_line?: number;
  /** whole comment above the symbol: searchable, never shown in result lists */
  doc?: string;
}

const MAX_SUMMARY = 220;
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".dart", ".kt", ".kts", ".swift"];

const BUILTIN_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "instanceof", "super", "this",
  "require", "import", "export", "new", "delete", "void", "yield", "await", "async",
  "Array", "Map", "Set", "WeakMap", "WeakSet", "Promise", "Object", "String", "Number", "Boolean",
  "Symbol", "BigInt", "Math", "JSON", "Date", "RegExp", "Error", "TypeError", "RangeError", "Buffer",
  "URL", "URLSearchParams", "TextEncoder", "TextDecoder", "console", "process",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "fetch",
  "describe", "it", "test", "expect", "assert",
  "get", "set", "has", "add", "delete", "clear", "keys", "values", "entries", "forEach",
  "map", "filter", "reduce", "find", "findIndex", "some", "every", "includes", "indexOf",
  "slice", "splice", "push", "pop", "shift", "unshift", "join", "split", "replace", "replaceAll",
  "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "startsWith", "endsWith", "match", "exec",
  "sort", "reverse", "flat", "flatMap", "fill", "from", "of", "isArray", "assign", "freeze",
  "stringify", "parse", "now", "min", "max", "floor", "ceil", "round", "abs", "sqrt", "pow",
  "log", "warn", "error", "info", "debug", "toString", "valueOf", "toFixed",
  "print", "len", "range", "list", "dict", "set", "str", "int", "float", "bool", "tuple", "isinstance", "getattr", "setattr",
  "println", "listOf", "mapOf", "setOf", "mutableListOf", "mutableMapOf", "mutableSetOf", "emptyList", "emptyMap",
]);

function extractCalls(snippet: string, ownName: string): string[] {
  const shortOwn = ownName.includes(".") ? ownName.split(".").pop()! : ownName;
  const out = new Set<string>();
  const re = /\b(?:new\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    const id = m[1];
    if (id.length < 3 || id === ownName || id === shortOwn || BUILTIN_CALLS.has(id)) continue;
    out.add(id);
    if (out.size >= 30) break;
  }
  return [...out];
}

const lineOf = (content: string, index: number) => content.slice(0, index).split("\n").length;

// First sentence of the JSDoc / `//` block directly above `index` (what an agent wants to know before opening the file)
function docAbove(content: string, index: number, full = false): string {
  const before = content.slice(0, index).trimEnd();
  let text = "";
  if (before.endsWith("*/")) {
    text = before.slice(before.lastIndexOf("/**") + 3, -2).replace(/^\s*\*\s?/gm, "");
  } else {
    const lines = before.split("\n");
    const doc: string[] = [];
    for (let i = lines.length - 1; i >= 0 && lines[i].trim().startsWith("//"); i--) {
      const t = lines[i].trim().slice(2).replace(/^\//, ""); // "///" doc comments in Dart
      if (/[\p{L}\p{N}]/u.test(t)) doc.unshift(t); // skip "════" style dividers
    }
    text = doc.join(" ");
  }
  const body = text.split("\n").filter((l) => !l.trim().startsWith("@")).join(" ").replace(/\s+/g, " ").trim();
  if (full) return body.slice(0, 400);
  const first = body.split(/(?<=[.!?])\s/)[0] || "";
  return first.length > 140 ? first.slice(0, 140).replace(/\s+\S*$/, "") + "…" : first;
}

// FTS matches whole tokens, so "radial subgraph" can't find getRadialSubgraph unless the words are spelled out
const words = (name: string) => {
  const w = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_$]+/g, " ").trim().toLowerCase();
  return w.includes(" ") ? ` (${w})` : "";
};

const describe = (signature: string, doc: string, name = "") =>
  ((doc ? `${signature} — ${doc}` : signature) + words(name)).replace(/\s+/g, " ").slice(0, MAX_SUMMARY);

export function findMatchingParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function extractChunkSummary(lines: string[], fallbackName: string): string {
  const text = lines.join("\n");
  const strMatches: string[] = [];
  const strRe = /['"]((?:\\.|[^'"\\]){8,250})['"]/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(text)) !== null) {
    const clean = m[1]
      .replace(/\\[nrt]/g, " ")
      .replace(/\\(["'\\])/g, "$1")
      .replace(/[\${}]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean.length >= 10 && !/^[a-zA-Z0-9_.-]+$/.test(clean)) {
      strMatches.push(clean);
      if (strMatches.length >= 3) break;
    }
  }

  const comments: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if ((trimmed.startsWith("//") && !trimmed.startsWith("///")) || trimmed.startsWith("#")) {
      const c = trimmed.replace(/^(\/\/|#)\s*/, "").trim();
      if (c.length >= 8) {
        comments.push(c);
        if (comments.length >= 2) break;
      }
    }
  }

  const excerpts = [...strMatches, ...comments].map((s) => (s.length > 80 ? s.slice(0, 77) + "…" : s));
  if (excerpts.length > 0) {
    return excerpts.join(" · ");
  }
  const codeSample = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("}"))
    .slice(0, 2)
    .join("; ");
  return codeSample ? codeSample.slice(0, 100) : fallbackName;
}

export interface FileImports {
  /** npm packages / node builtins */
  external: string[];
  /** absolute paths of imported project files that exist on disk */
  internal: string[];
}

export class CodeParser {
  public parseImports(filePath: string, content: string): FileImports {
    const external = new Set<string>();
    const internal = new Set<string>();
    if (filePath.endsWith(".dart")) {
      const dre = /^\s*(?:import|export|part)\s+'([^']+)'/gm;
      let d;
      while ((d = dre.exec(content)) !== null) {
        const own = d[1].startsWith("package:") ? this.resolveDartPackage(filePath, d[1]) : null;
        if (own) internal.add(own);
        else if (d[1].startsWith("dart:") || d[1].startsWith("package:")) external.add(d[1]);
        else {
          const target = path.resolve(path.dirname(filePath), d[1]);
          if (fs.existsSync(target)) internal.add(target);
        }
      }
      return { external: [...external], internal: [...internal] };
    }
    if (filePath.endsWith(".kt") || filePath.endsWith(".kts")) {
      const kre = /^\s*import\s+([A-Za-z0-9_.]+)/gm;
      let k;
      while ((k = kre.exec(content)) !== null) {
        const pkg = k[1];
        if (!pkg.startsWith("kotlin.") && !pkg.startsWith("java.") && !pkg.startsWith("javax.")) {
          external.add(pkg.split(".").slice(0, 2).join("."));
        }
      }
      return { external: [...external], internal: [...internal] };
    }
    const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1] || m[2];
      if (spec.startsWith("@/") || spec.startsWith("~/")) {
        const aliased = this.resolveAlias(filePath, spec.slice(2));
        if (aliased) {
          internal.add(aliased);
          continue;
        }
      }
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      const target = this.resolveRelative(path.dirname(filePath), spec);
      if (target) internal.add(target);
    }
    return { external: [...external], internal: [...internal] };
  }

  private resolveAlias(fromFile: string, relSpec: string): string | null {
    for (let dir = path.dirname(fromFile), i = 0; i < 6 && dir !== path.dirname(dir); dir = path.dirname(dir), i++) {
      if (fs.existsSync(path.join(dir, "tsconfig.json")) || fs.existsSync(path.join(dir, "package.json"))) {
        const hit =
          this.resolveRelative(path.join(dir, "src"), "./" + relSpec) ||
          this.resolveRelative(dir, "./" + relSpec);
        if (hit) return hit;
      }
    }
    return null;
  }

  // package:foo/x.dart is ours when an ancestor is package foo itself or has packages/foo (melos layout)
  private resolveDartPackage(from: string, spec: string): string | null {
    const [, name, rest] = spec.match(/^package:([^/]+)\/(.+)$/) ?? [];
    if (!name) return null;
    for (let dir = path.dirname(from), i = 0; i < 8 && dir !== path.dirname(dir); dir = path.dirname(dir), i++) {
      const pubspec = path.join(dir, "pubspec.yaml");
      const candidates = [path.join(dir, "packages", name, "lib", rest)];
      if (fs.existsSync(pubspec) && new RegExp(`^name:\\s*${name}\\s*$`, "m").test(fs.readFileSync(pubspec, "utf-8"))) candidates.push(path.join(dir, "lib", rest));
      const hit = candidates.find((c) => fs.existsSync(c));
      if (hit) return hit;
    }
    return null;
  }

  // TS projects import "./x.js" for x.ts, so try swapping the extension too
  private resolveRelative(dir: string, spec: string): string | null {
    const base = path.resolve(dir, spec);
    const stem = base.replace(/\.(m?js|jsx)$/, "");
    const candidates = [base, ...SOURCE_EXTS.map((e) => stem + e), ...SOURCE_EXTS.map((e) => path.join(base, "index" + e))];
    return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
  }

  public parseFile(filePath: string, content: string): ParsedCodeEntity[] {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath, ext);
    const entities: ParsedCodeEntity[] = [];

    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs") {
      this.parseTypeScript(fileName, content, entities);
    } else if (ext === ".py") {
      this.parsePython(fileName, content, entities);
    } else if (ext === ".dart") {
      this.parseDart(fileName, content, entities);
    } else if (ext === ".kt" || ext === ".kts") {
      this.parseKotlin(fileName, content, entities);
    } else if (ext === ".swift") {
      this.parseSwift(fileName, content, entities);
    } else if (ext === ".sql") {
      this.parseSQL(fileName, content, entities);
    } else if (ext === ".json") {
      this.parseJSON(fileName, content, entities);
    } else if (ext === ".yaml" || ext === ".yml") {
      this.parseYAML(fileName, content, entities);
    } else if (fileName.toLowerCase() === "dockerfile" || ext === ".dockerfile") {
      this.parseDockerfile(fileName, content, entities);
    } else {
      // Fallback generic code parser
      entities.push({
        name: fileName,
        kind: "component",
        summary: `Source component defined in ${path.basename(filePath)}`,
        calls: [],
        dependsOn: [],
        storesIn: [],
      });
    }

    const lines = content.split("\n");
    const sortedByLine = [...entities].filter((e) => e.line).sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    for (let i = 0; i < sortedByLine.length; i++) {
      const cur = sortedByLine[i];
      const startLine = cur.line ?? 1;
      const nextLine = sortedByLine[i + 1]?.line ?? (lines.length + 1);
      cur.end_line = Math.max(startLine, nextLine - 1);
      if (cur.calls.length === 0) {
        const bodySlice = lines.slice(startLine - 1, Math.min(cur.end_line, startLine + 400)).join("\n");
        cur.calls = extractCalls(bodySlice, cur.name);
      }
    }

    // Chunk long code entities (> 35 lines) into sub-blocks so embedded prompts, SQL, and strings are indexed
    const chunks: ParsedCodeEntity[] = [];
    const CHUNK_SIZE = 30;
    const CHUNK_OVERLAP = 5;
    for (const cur of sortedByLine) {
      if (cur.kind === "api_endpoint" || cur.name.includes("#L")) continue;
      const start = cur.line ?? 1;
      const end = cur.end_line ?? start;
      const length = end - start + 1;
      if (length > 35) {
        for (let cStart = start; cStart <= end; cStart += (CHUNK_SIZE - CHUNK_OVERLAP)) {
          const cEnd = Math.min(end, cStart + CHUNK_SIZE - 1);
          if (cEnd - cStart < 8 && cStart > start) break;
          const chunkSlice = lines.slice(cStart - 1, cEnd);
          const chunkSummary = extractChunkSummary(chunkSlice, `${cur.name}#L${cStart}-${cEnd}`);
          chunks.push({
            name: `${cur.name}#L${cStart}-${cEnd}`,
            kind: "component",
            summary: describe(`${cur.name} [L${cStart}-${cEnd}]: ${chunkSummary}`, "", cur.name),
            calls: extractCalls(chunkSlice.join("\n"), cur.name),
            dependsOn: [],
            storesIn: [],
            line: cStart,
            end_line: cEnd,
            doc: chunkSlice.join("\n").slice(0, 500),
          });
        }
      }
    }
    entities.push(...chunks);

    if (ext !== ".py") {
      const starts = [0];
      for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) starts.push(i + 1);
      for (const e of entities) {
        const doc = e.line && e.line > 1 ? docAbove(content, starts[e.line - 1] ?? 0, true) : "";
        if (doc && doc.length > e.summary.length) e.doc = doc;
      }
    }
    return entities;
  }

  private parseTypeScript(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    const lines = content.split("\n");

    // Extract imports (dependencies)
    const imports: string[] = [];
    const importRegex = /import\s+.*?from\s+['"](.*?)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const pkg = match[1];
      if (!pkg.startsWith(".")) {
        imports.push(pkg);
      }
    }

    // 1. Detect API Endpoints: e.g. router.get('/path'), app.post('/path'), @Get('/path')
    const routeRegex = /(?:router|app|fastify)\.(get|post|put|delete|patch)\s*\(\s*['"](.*?)['"]/gi;
    let routeMatch;
    while ((routeMatch = routeRegex.exec(content)) !== null) {
      const method = routeMatch[1].toUpperCase();
      const routePath = routeMatch[2];
      out.push({
        name: `${method} ${routePath}`,
        kind: "api_endpoint",
        summary: `API Endpoint ${method} ${routePath} in ${fileName}`,
        calls: [],
        dependsOn: [],
        storesIn: [],
        line: lineOf(content, routeMatch.index),
      });
    }

    // 2. Classes / Services
    const classRegex = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$.]+))?/gm;
    let classMatch;
    while ((classMatch = classRegex.exec(content)) !== null) {
      const className = classMatch[1];
      const baseClass = classMatch[2]?.trim();
      const isService = className.toLowerCase().includes("service");
      out.push({
        name: className,
        kind: isService ? "service" : "component",
        summary: describe(`class ${className}${baseClass ? ` extends ${baseClass}` : ""}`, docAbove(content, classMatch.index), className),
        calls: baseClass ? [baseClass] : [],
        dependsOn: [],
        storesIn: [],
        line: lineOf(content, classMatch.index),
      });
    }

    // 3. Exported functions and arrow-function consts: the callable surface other files use
    const fnRegex = /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)\s*(\([^)]*\))?(?:\s*:\s*([^{;\n]+))?/gm;
    const arrowRegex = /^export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=\s*(async\s*)?(\([^)]*\)|[A-Za-z0-9_$]+)\s*(?::\s*([^=\n]+?))?\s*=>/gm;
    for (const [re, async] of [[fnRegex, false], [arrowRegex, true]] as const) {
      let m;
      while ((m = re.exec(content)) !== null) {
        const params = (async ? m[3] : m[2]) || "()";
        const ret = (async ? m[4] : m[3])?.trim();
        out.push({
          name: m[1],
          kind: "component",
          summary: describe(`function ${m[1]}${params.replace(/\s+/g, " ")}${ret ? `: ${ret}` : ""}`, docAbove(content, m.index), m[1]),
          calls: [],
          dependsOn: [],
          storesIn: [],
          line: lineOf(content, m.index),
        });
      }
    }

    // Public methods: indented, not private/protected, attributed to the nearest class above
    const methodRegex = /^[ \t]+(?:public\s+|static\s+|async\s+|override\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\(([^)]*)\)\s*(?::\s*([^{;\n]+?))?\s*\{/gm;
    const classAt = out.filter((e) => e.kind !== "api_endpoint" && /class /.test(e.summary)).map((e) => ({ name: e.name, line: e.line ?? 0 }));
    // `export const jobs = {` objects own their methods the way a class does
    const objectRe = /^export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=\s*\{\s*$/gm;
    let objMatch;
    while ((objMatch = objectRe.exec(content)) !== null) classAt.push({ name: objMatch[1], line: lineOf(content, objMatch.index) });
    classAt.sort((a, b) => a.line - b.line);
    const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "constructor", "super"]);
    let methodMatch;
    while ((methodMatch = methodRegex.exec(content)) !== null) {
      const head = methodMatch[0];
      if (NOT_METHODS.has(methodMatch[1]) || /\b(private|protected)\b/.test(head)) continue;
      const line = lineOf(content, methodMatch.index);
      const owner = [...classAt].reverse().find((c) => c.line <= line);
      if (!owner || line - owner.line > 400) continue;
      const params = methodMatch[2].replace(/\s+/g, " ").trim();
      out.push({
        name: `${owner.name}.${methodMatch[1]}`,
        kind: "component",
        summary: describe(`${owner.name}.${methodMatch[1]}(${params})${methodMatch[3] ? `: ${methodMatch[3].trim()}` : ""}`, docAbove(content, methodMatch.index), methodMatch[1]),
        calls: [],
        dependsOn: [],
        storesIn: [],
        line,
      });
    }

    // Other exported consts (singletons, tables, configs); arrow functions were captured above
    const constRegex = /^export\s+const\s+([A-Za-z0-9_$]+)\s*(?::\s*([^=\n]+?))?\s*=\s*(?:new\s+([A-Za-z0-9_$.]+))?/gm;
    let constMatch;
    while ((constMatch = constRegex.exec(content)) !== null) {
      if (out.some((e) => e.name === constMatch![1])) continue;
      const type = constMatch[3] || constMatch[2];
      out.push({
        name: constMatch[1],
        kind: "component",
        summary: describe(`const ${constMatch[1]}${type ? `: ${type.trim()}` : ""}`, docAbove(content, constMatch.index), constMatch[1]),
        calls: [],
        dependsOn: [],
        storesIn: [],
        line: lineOf(content, constMatch.index),
      });
    }

    // 4. Exported types / interfaces / enums: the data contracts
    const typeRegex = /^export\s+(?:declare\s+)?(interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
    let typeMatch;
    while ((typeMatch = typeRegex.exec(content)) !== null) {
      out.push({
        name: typeMatch[2],
        kind: "data_model",
        summary: describe(`${typeMatch[1]} ${typeMatch[2]}`, docAbove(content, typeMatch.index), typeMatch[2]),
        calls: [],
        dependsOn: [],
        storesIn: [],
        line: lineOf(content, typeMatch.index),
      });
    }

    // Nothing recognisable: one entry for the whole file, described by its header comment if any
    if (out.length === 0) {
      out.push({
        name: fileName,
        kind: "component",
        summary: `module ${fileName} (${lines.length} lines)`,
        calls: [],
        dependsOn: imports.slice(0, 5),
        storesIn: [],
        line: 1,
      });
    }
  }

  private parseDart(fileName: string, content: string, out: ParsedCodeEntity[]): void {
    const push = (name: string, kind: ParsedCodeEntity["kind"], sig: string, index: number) =>
      out.push({ name, kind, summary: describe(sig, docAbove(content, index), name), calls: [], dependsOn: [], storesIn: [], line: lineOf(content, index) });

    // Types: class / mixin / enum / extension / typedef (modifiers first, then optional "extends X")
    const typeRe = /^(?:@\w+(?:\([^)]*\))?\s*)*((?:abstract|sealed|final|base|interface)\s+)*(class|mixin|enum|extension\s+type|extension|typedef)\s+([A-Za-z_]\w*)(?:<[^>{]*>)?(?:\s+(?:extends|on)\s+([\w.<>?, ]+?))?(?=\s*[{=(]|\s+(?:with|implements)\b)/gm;
    const classes: { name: string; line: number }[] = [];
    let m;
    while ((m = typeRe.exec(content)) !== null) {
      const [, mods, kw, name, base] = m;
      const isService = /service|repository|bloc|cubit|controller/i.test(name);
      push(name, /enum|typedef/.test(kw) ? "data_model" : isService ? "service" : "component", `${(mods || "").trim()} ${kw} ${name}${base ? ` extends ${base.trim()}` : ""}`.trim(), m.index);
      if (kw === "class" || kw === "mixin") classes.push({ name, line: lineOf(content, m.index) });
    }

    const SKIP = new Set([
      "if", "for", "while", "switch", "catch", "return", "throw", "yield", "await", "new",
      "class", "mixin", "enum", "extension", "typedef",
      "build", "dispose", "initState", "toString", "operator", "Function", "assert"
    ]);

    // Methods and getters inside classes (indented 2-4 spaces)
    const methodDeclRe = /^[ \t]{2,4}(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:static|external|abstract|override)\s+)*(?:(?:Future<[^>]*>|Stream<[^>]*>|[A-Za-z_][\w<>?,. ]*?)\s+)?(?:get\s+([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\s*\()/gm;
    while ((m = methodDeclRe.exec(content)) !== null) {
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const lineText = content.slice(lineStart, m.index + m[0].length).trim();
      if (/^(?:return|throw|yield|await)\b/.test(lineText)) continue;

      const isGetter = !!m[1];
      const name = isGetter ? m[1] : m[2];
      if (SKIP.has(name)) continue;

      const line = lineOf(content, m.index);
      const owner = [...classes].reverse().find((c) => c.line <= line);
      if (!owner || line - owner.line > 1000) continue;

      if (isGetter) {
        const after = content.slice(m.index + m[0].length, m.index + m[0].length + 40).trim();
        if (/^(=>|\{)/.test(after)) {
          push(`${owner.name}.${name}`, "component", `${owner.name}: get ${name}`, m.index);
        }
      } else {
        const parenStart = content.indexOf("(", m.index + m[0].length - 1);
        const parenEnd = findMatchingParen(content, parenStart);
        if (parenEnd !== -1) {
          const after = content.slice(parenEnd + 1, parenEnd + 50).trim();
          if (/^(?:async\*?\s*|sync\*?\s*)?(=>|\{)/.test(after) || (after.startsWith(";") && /\b(abstract|external)\b/.test(lineText))) {
            const rawHead = content.slice(m.index, parenEnd + 1).replace(/\s+/g, " ").trim();
            push(`${owner.name}.${name}`, "component", `${owner.name}: ${rawHead}`, m.index);
          }
        }
      }
    }

    // Top-level functions and getters (0 indent)
    const topFnRe = /^(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:Future<[^>]*>|Stream<[^>]*>|[A-Za-z_][\w<>?,. ]*?)\s+)?(?:get\s+([A-Za-z_]\w*)|([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\s*\()/gm;
    while ((m = topFnRe.exec(content)) !== null) {
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const lineText = content.slice(lineStart, m.index + m[0].length).trim();
      if (/^(?:return|throw|yield|await)\b/.test(lineText)) continue;

      const isGetter = !!m[1];
      const name = isGetter ? m[1] : m[2];
      if (SKIP.has(name) || classes.some((c) => c.name === name)) continue;

      if (isGetter) {
        const after = content.slice(m.index + m[0].length, m.index + m[0].length + 40).trim();
        if (/^(=>|\{)/.test(after)) {
          push(name, "component", `get ${name}`, m.index);
        }
      } else {
        const parenStart = content.indexOf("(", m.index + m[0].length - 1);
        const parenEnd = findMatchingParen(content, parenStart);
        if (parenEnd !== -1) {
          const after = content.slice(parenEnd + 1, parenEnd + 50).trim();
          if (/^(?:async\*?\s*|sync\*?\s*)?(=>|\{)/.test(after) || (after.startsWith(";") && /\bexternal\b/.test(lineText))) {
            const rawHead = content.slice(m.index, parenEnd + 1).replace(/\s+/g, " ").trim();
            push(name, "component", rawHead, m.index);
          }
        }
      }
    }

    if (out.length === 0) {
      out.push({ name: fileName, kind: "component", summary: `Dart library ${fileName} (${content.split("\n").length} lines)`, calls: [], dependsOn: [], storesIn: [], line: 1 });
    }
  }

  private parsePython(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    const lines = content.split("\n");
    const imports: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
        const parts = trimmed.split(" ");
        if (parts[1]) imports.push(parts[1].split(".")[0]);
      }
    }

    // Detect FastAPI / Flask routes: @app.get("/path"), @router.post("/path")
    const routeRegex = /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"](.*?)['"]/gi;
    let routeMatch;
    while ((routeMatch = routeRegex.exec(content)) !== null) {
      const method = routeMatch[1].toUpperCase();
      const routePath = routeMatch[2];
      out.push({
        name: `${method} ${routePath}`,
        kind: "api_endpoint",
        summary: `API Route ${method} ${routePath} in ${fileName}`,
        calls: [],
        dependsOn: imports.slice(0, 3),
        storesIn: [],
        line: lineOf(content, routeMatch.index),
      });
    }

    // First line of the docstring that follows `index` (end of a def/class header)
    const docstring = (index: number) => {
      const m = /^\s*(?:"""|\'\'\')\s*([^\n]*?)(?:"""|\'\'\')?\s*$/m.exec(content.slice(index, index + 400).replace(/^[^\n]*\n/, ""));
      return m?.[1]?.trim() || "";
    };

    const classRegex = /^class\s+([A-Za-z0-9_]+)\s*(?:\(([^)]*)\))?\s*:/gm;
    let classMatch;
    while ((classMatch = classRegex.exec(content)) !== null) {
      const className = classMatch[1];
      const baseClass = classMatch[2]?.trim();
      out.push({
        name: className,
        kind: className.toLowerCase().includes("service") ? "service" : "component",
        summary: describe(`class ${className}${baseClass ? `(${baseClass})` : ""}`, docstring(classMatch.index), className),
        calls: baseClass ? [baseClass] : [],
        dependsOn: [],
        storesIn: [],
        line: lineOf(content, classMatch.index),
      });
    }

    // Top-level functions only (no indent): methods are reachable through their class
    const defRegex = /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*(\([^)]*\))\s*(?:->\s*([^:]+))?:/gm;
    let defMatch;
    while ((defMatch = defRegex.exec(content)) !== null) {
      if (defMatch[1].startsWith("_")) continue;
      out.push({
        name: defMatch[1],
        kind: "component",
        summary: describe(`def ${defMatch[1]}${defMatch[2]}${defMatch[3] ? ` -> ${defMatch[3].trim()}` : ""}`, docstring(defMatch.index), defMatch[1]),
        calls: [],
        dependsOn: [],
        storesIn: [],
        line: lineOf(content, defMatch.index),
      });
    }

    if (out.length === 0) {
      out.push({
        name: fileName,
        kind: "component",
        summary: `Python module ${fileName} (${lines.length} lines)`,
        calls: [],
        dependsOn: [],
        storesIn: [],
      });
    }
  }

  private parseKotlin(fileName: string, content: string, out: ParsedCodeEntity[]): void {
    const push = (name: string, kind: ParsedCodeEntity["kind"], sig: string, index: number) =>
      out.push({ name, kind, summary: describe(sig, docAbove(content, index), name), calls: [], dependsOn: [], storesIn: [], line: lineOf(content, index) });

    const typeRe = /^[ \t]*(?:@\w+(?:\([^)]*\))?\s*)*((?:public|internal|open|abstract|sealed|data|enum|value|annotation|private)\s+)*(class|interface|object)\s+([A-Za-z_]\w*)(?:<[^>{]*>)?(?:\s*(?:\([^)]*\))?\s*:\s*([^{=\n]+))?/gm;
    const classes: { name: string; line: number }[] = [];
    let m;
    while ((m = typeRe.exec(content)) !== null) {
      const [, mods, kw, name, base] = m;
      const isDataModel = /\b(data|enum|value)\b/.test(mods || "") || kw === "interface";
      const isService = /service|repository|manager|engine|controller|orchestrator|kernel/i.test(name);
      push(
        name,
        isDataModel ? "data_model" : isService ? "service" : "component",
        `${(mods || "").trim()} ${kw} ${name}${base ? ` : ${base.trim()}` : ""}`.trim(),
        m.index
      );
      classes.push({ name, line: lineOf(content, m.index) });
    }

    const funRe = /^([ \t]*)(?:(?:public|internal|open|override|suspend|inline|operator|private|protected)\s+)*fun\s+(?:<[^>\n]*>\s*)?(?:[A-Za-z0-9_<>?., ]+\.)?([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\s*\(/gm;
    while ((m = funRe.exec(content)) !== null) {
      const indent = m[1].length;
      const fnName = m[2];
      const parenStart = content.indexOf("(", m.index + m[0].length - 1);
      const parenEnd = findMatchingParen(content, parenStart);
      if (parenEnd === -1) continue;
      const params = content.slice(parenStart + 1, parenEnd).replace(/\s+/g, " ").trim();
      const after = content.slice(parenEnd + 1, parenEnd + 80);
      const retMatch = after.match(/^\s*:\s*([^{=\n]+)/);
      const ret = retMatch?.[1]?.trim();
      const line = lineOf(content, m.index);
      const owner = indent > 0 ? [...classes].reverse().find((c) => c.line <= line && line - c.line <= 600) : undefined;
      const fullName = owner ? `${owner.name}.${fnName}` : fnName;
      push(fullName, "component", `fun ${fullName}(${params})${ret ? `: ${ret}` : ""}`, m.index);
    }

    if (out.length === 0) {
      out.push({
        name: fileName,
        kind: "component",
        summary: `Kotlin module ${fileName} (${content.split("\n").length} lines)`,
        calls: [],
        dependsOn: [],
        storesIn: [],
        line: 1,
      });
    }
  }

  private parseSwift(fileName: string, content: string, out: ParsedCodeEntity[]): void {
    const push = (name: string, kind: ParsedCodeEntity["kind"], sig: string, index: number) =>
      out.push({ name, kind, summary: describe(sig, docAbove(content, index), name), calls: [], dependsOn: [], storesIn: [], line: lineOf(content, index) });

    const typeRe = /^[ \t]*(?:@\w+(?:\([^)]*\))?\s*)*((?:public|open|internal|final|indirect|private|fileprivate)\s+)*(class|struct|enum|protocol|actor)\s+([A-Za-z_]\w*)(?:<[^>{]*>)?(?:\s*:\s*([^{=\n]+))?/gm;
    const classes: { name: string; line: number }[] = [];
    let m;
    while ((m = typeRe.exec(content)) !== null) {
      const [, mods, kw, name, base] = m;
      const isDataModel = kw === "struct" || kw === "enum" || kw === "protocol";
      const isService = /service|repository|manager|controller|viewModel/i.test(name);
      push(
        name,
        isDataModel ? "data_model" : isService ? "service" : "component",
        `${(mods || "").trim()} ${kw} ${name}${base ? `: ${base.trim()}` : ""}`.trim(),
        m.index
      );
      classes.push({ name, line: lineOf(content, m.index) });
    }

    const funcRe = /^([ \t]*)(?:(?:public|open|static|class|override|mutating|private|fileprivate)\s+)*func\s+([A-Za-z_]\w*)\s*(?:<[^>\n]*>)?\s*\(/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const fnName = m[2];
      const parenStart = content.indexOf("(", m.index + m[0].length - 1);
      const parenEnd = findMatchingParen(content, parenStart);
      if (parenEnd === -1) continue;
      const params = content.slice(parenStart + 1, parenEnd).replace(/\s+/g, " ").trim();
      const after = content.slice(parenEnd + 1, parenEnd + 80);
      const retMatch = after.match(/^\s*(?:async\s*)?(?:throws\s*)?(?:->\s*([^{=\n]+))?/);
      const ret = retMatch?.[1]?.trim();
      const line = lineOf(content, m.index);
      const owner = indent > 0 ? [...classes].reverse().find((c) => c.line <= line && line - c.line <= 600) : undefined;
      const fullName = owner ? `${owner.name}.${fnName}` : fnName;
      push(fullName, "component", `func ${fullName}(${params})${ret ? ` -> ${ret}` : ""}`, m.index);
    }

    if (out.length === 0) {
      out.push({
        name: fileName,
        kind: "component",
        summary: `Swift module ${fileName} (${content.split("\n").length} lines)`,
        calls: [],
        dependsOn: [],
        storesIn: [],
        line: 1,
      });
    }
  }

  private parseSQL(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    const tableBlockRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_`"\[\]]+)\s*\(([\s\S]*?)\)(?:;|\n\s*GO|\n\s*CREATE|$)/gi;
    let match;
    let found = 0;

    while ((match = tableBlockRegex.exec(content)) !== null) {
      found++;
      const rawName = match[1].replace(/[`"\[\]]/g, "");
      const body = match[2];

      const lines = body.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("--"));
      const cols: string[] = [];
      const dependsOn: string[] = [];

      for (const line of lines) {
        const fkMatch = line.match(/(?:FOREIGN\s+KEY.*?)?REFERENCES\s+([A-Za-z0-9_`"\[\]]+)/i);
        if (fkMatch) {
          const refTable = fkMatch[1].replace(/[`"\[\]]/g, "");
          if (refTable && refTable !== rawName && !dependsOn.includes(refTable)) {
            dependsOn.push(refTable);
          }
        }

        const colMatch = line.match(/^([A-Za-z0-9_`"\[\]]+)\s+([A-Za-z0-9_()]+)/);
        if (
          colMatch &&
          !/^(PRIMARY|FOREIGN|CONSTRAINT|UNIQUE|CHECK|KEY|INDEX)$/i.test(colMatch[1])
        ) {
          cols.push(colMatch[1].replace(/[`"\[\]]/g, ""));
        }
      }

      const summaryCols = cols.length
        ? `columns: ${cols.slice(0, 8).join(", ")}${cols.length > 8 ? ` (+${cols.length - 8} more)` : ""}`
        : "";
      const summaryFk = dependsOn.length ? ` -> references ${dependsOn.join(", ")}` : "";

      out.push({
        name: rawName,
        kind: "data_model",
        summary: `Table '${rawName}' in ${fileName}.sql${summaryCols ? ` (${summaryCols})` : ""}${summaryFk}`,
        calls: [],
        dependsOn,
        storesIn: [],
      });
    }

    if (found === 0) {
      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_`"\[\]]+)/gi;
      let m;
      while ((m = tableRegex.exec(content)) !== null) {
        const tableName = m[1].replace(/[`"\[\]]/g, "");
        out.push({
          name: tableName,
          kind: "data_model",
          summary: `Database table '${tableName}' defined in ${fileName}.sql`,
          calls: [],
          dependsOn: [],
          storesIn: [],
        });
      }
    }
  }

  private parseYAML(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    if (fileName.includes("docker-compose") || content.includes("services:")) {
      const lines = content.split("\n");
      let inServices = false;
      let baseIndent = 0;
      let serviceIndent = -1;
      let currentService: { name: string; image?: string; ports: string[]; dependsOn: string[] } | null = null;

      const finishService = () => {
        if (currentService) {
          out.push({
            name: currentService.name,
            kind: "service",
            summary: `Container Service '${currentService.name}'${currentService.image ? ` (image: ${currentService.image})` : ""}${currentService.ports.length ? ` [ports: ${currentService.ports.join(", ")}]` : ""}`,
            calls: [],
            dependsOn: currentService.dependsOn,
            storesIn: [],
          });
          currentService = null;
        }
      };

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        if (/^services:\s*$/i.test(trimmed)) {
          finishService();
          inServices = true;
          baseIndent = line.search(/\S/);
          serviceIndent = -1;
          continue;
        }

        if (inServices) {
          const indent = line.search(/\S/);
          if (indent <= baseIndent && /^[a-z0-9_-]+:/i.test(trimmed)) {
            finishService();
            inServices = false;
            continue;
          }

          const svcMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
          if (svcMatch) {
            if (serviceIndent === -1 && indent > baseIndent) {
              serviceIndent = indent;
            }
            if (indent === serviceIndent) {
              finishService();
              currentService = { name: svcMatch[1], ports: [], dependsOn: [] };
              continue;
            }
          }

          if (currentService) {
            const imgMatch = trimmed.match(/^image:\s*(.+)$/i);
            if (imgMatch) currentService.image = imgMatch[1].trim().replace(/['"]/g, "");

            const depMatch = trimmed.match(/^-\s+([A-Za-z0-9_-]+)$/);
            if (depMatch && /depends_on/i.test(lines[i - 1] || "")) {
              currentService.dependsOn.push(depMatch[1]);
            }
          }
        }
      }

      finishService();
    }
  }

  private parseDockerfile(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    const fromMatch = content.match(/^FROM\s+([^\s\n]+)/im);
    const exposeMatches = [...content.matchAll(/^EXPOSE\s+([^\s\n]+)/gim)].map((m) => m[1]);

    out.push({
      name: fileName || "Dockerfile",
      kind: "config",
      summary: `Container build recipe${fromMatch ? ` based on ${fromMatch[1]}` : ""}${exposeMatches.length ? ` exposing port(s) ${exposeMatches.join(", ")}` : ""}`,
      calls: [],
      dependsOn: [],
      storesIn: [],
    });
  }

  private parseJSON(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    if (fileName === "package") {
      try {
        const pkg = JSON.parse(content);
        const name = pkg.name || "application";
        out.push({
          name,
          kind: "service",
          summary: `Project package: ${name} v${pkg.version || "1.0.0"} - ${
            pkg.description || "Node.js application"
          }`,
          calls: [],
          dependsOn: Object.keys(pkg.dependencies || {}).slice(0, 10),
          storesIn: [],
        });
      } catch {
        // ignore
      }
    } else {
      out.push({
        name: fileName,
        kind: "config",
        summary: `Configuration file ${fileName}.json`,
        calls: [],
        dependsOn: [],
        storesIn: [],
      });
    }
  }
}

export const codeParser = new CodeParser();
