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
  /** whole comment above the symbol: searchable, never shown in result lists */
  doc?: string;
}

const MAX_SUMMARY = 220;
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".dart"];

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
    const re = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1] || m[2];
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      const target = this.resolveRelative(path.dirname(filePath), spec);
      if (target) internal.add(target);
    }
    return { external: [...external], internal: [...internal] };
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

    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
      this.parseTypeScript(fileName, content, entities);
    } else if (ext === ".py") {
      this.parsePython(fileName, content, entities);
    } else if (ext === ".dart") {
      this.parseDart(fileName, content, entities);
    } else if (ext === ".sql") {
      this.parseSQL(fileName, content, entities);
    } else if (ext === ".json") {
      this.parseJSON(fileName, content, entities);
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
        dependsOn: imports.slice(0, 3),
        storesIn: [],
        line: lineOf(content, routeMatch.index),
      });
    }

    // 2. Classes / Services
    const classRegex = /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$.]+))?/gm;
    let classMatch;
    while ((classMatch = classRegex.exec(content)) !== null) {
      const className = classMatch[1];
      const isService = className.toLowerCase().includes("service");
      out.push({
        name: className,
        kind: isService ? "service" : "component",
        summary: describe(`class ${className}${classMatch[2] ? ` extends ${classMatch[2]}` : ""}`, docAbove(content, classMatch.index), className),
        calls: [],
        dependsOn: imports.slice(0, 5),
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
      if (name.startsWith("_")) continue; // private to the library; its public parent is enough
      const isService = /service|repository|bloc|cubit|controller/i.test(name);
      push(name, /enum|typedef/.test(kw) ? "data_model" : isService ? "service" : "component", `${(mods || "").trim()} ${kw} ${name}${base ? ` extends ${base.trim()}` : ""}`.trim(), m.index);
      if (kw === "class" || kw === "mixin") classes.push({ name, line: lineOf(content, m.index) });
    }

    // Public methods (2-space indent): "Type name(args) {" or "=>"; skip private, control flow, constructors via Type == class name
    const methodRe = /^  (?:static\s+|Future<[^>]*>\s+|Stream<[^>]*>\s+|[A-Z][\w<>?,. ]*\s+|void\s+|bool\s+|int\s+|double\s+|String\s+|Widget\s+)+([a-z]\w*)\s*(?:<[^>\n]*>)?\(([^)]*)\)\s*(?:async\*?\s*)?(?:\{|=>)/gm;
    const SKIP = new Set(["if", "for", "while", "switch", "catch", "return", "build", "dispose", "initState"]);
    while ((m = methodRe.exec(content)) !== null) {
      if (SKIP.has(m[1])) continue;
      const line = lineOf(content, m.index);
      const owner = [...classes].reverse().find((c) => c.line <= line);
      if (!owner || line - owner.line > 600) continue;
      const head = m[0].replace(/\s*(\{|=>)$/, "").replace(/\s+/g, " ").trim();
      push(`${owner.name}.${m[1]}`, "component", `${owner.name}: ${head}`, m.index);
    }

    // Top-level functions and consts (no indent)
    const fnRe = /^(?:Future<[^>]*>|Stream<[^>]*>|[A-Za-z_][\w<>?,. ]*?)\s+([a-z]\w*)\s*\(([^)]*)\)\s*(?:async\*?\s*)?(?:\{|=>)/gm;
    while ((m = fnRe.exec(content)) !== null) {
      if (SKIP.has(m[1]) || /^(return|else|new|await)\b/.test(m[0])) continue;
      push(m[1], "component", m[0].replace(/\s*(\{|=>)$/, "").replace(/\s+/g, " ").trim(), m.index);
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
      out.push({
        name: className,
        kind: className.toLowerCase().includes("service") ? "service" : "component",
        summary: describe(`class ${className}${classMatch[2] ? `(${classMatch[2]})` : ""}`, docstring(classMatch.index), className),
        calls: [],
        dependsOn: imports.slice(0, 5),
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
        dependsOn: imports.slice(0, 5),
        storesIn: [],
      });
    }
  }

  private parseSQL(
    fileName: string,
    content: string,
    out: ParsedCodeEntity[]
  ): void {
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/gi;
    let match;
    while ((match = tableRegex.exec(content)) !== null) {
      const tableName = match[1];
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
