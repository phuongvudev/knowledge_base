import { classifyDocument, isAutoDomain } from "./classifier.js";
import path from "path";
import crypto from "crypto";
import { GraphEdge, GraphNode, NodeProvenance } from "../../types.js";
import { codeParser } from "./code_parser.js";
import { documentParser } from "./doc_parser.js";

export interface ExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rawContent: string;
  fileHash: string;
}

export class KnowledgeExtractor {
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/đ/g, "d")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Vietnamese: "Điều 1" -> "dieu_1", not "i_u_1"
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);
  }

  // Last two path segments, so index.ts / README.md in different folders don't collapse into one node
  private pathSlug(filePath: string): string {
    return this.slugify(filePath.split(path.sep).slice(-2).join("_"));
  }

  public computeFileHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  public async extractFromFile(
    projectId: string,
    filePath: string,
    domain: string = "general"
  ): Promise<ExtractionResult> {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);

    const isDocument = ext === ".pdf" || ext === ".docx" || ext === ".md" || ext === ".txt";

    if (isDocument) {
      return this.extractFromDocument(projectId, filePath, domain);
    } else {
      return this.extractFromCode(projectId, filePath, domain);
    }
  }

  private async extractFromDocument(
    projectId: string,
    filePath: string,
    domain: string
  ): Promise<ExtractionResult> {
    const { rawText, sections } = await documentParser.parseFile(filePath);
    const fileHash = this.computeFileHash(rawText);
    const fileName = path.basename(filePath);
    const cls = classifyDocument(rawText, fileName, path.extname(filePath));
    const autoDomain = isAutoDomain(domain);
    if (autoDomain) domain = cls.domain;

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // 1. Root Document Node
    const docSlug = this.pathSlug(filePath);
    const docNodeId = `doc:${docSlug}`;
    const docNode: GraphNode = {
      id: docNodeId,
      project_id: projectId,
      label: fileName,
      node_type: "policy",
      summary: `Document file ${fileName} (${sections.length} structural sections)`,
      domain,
      properties: {
        file_path: filePath,
        file_hash: fileHash,
        section_count: sections.length,
        doc_type: cls.docType,
        classification: { confidence: cls.confidence, matched: cls.matched, auto: autoDomain },
      },
      is_hub: true,
      provenance: {
        source_file: filePath,
        source_type: path.extname(filePath).slice(1) as any,
        extracted_at: new Date().toISOString(),
      },
    };
    nodes.push(docNode);

    // 2. Extract child nodes per section
    for (const sec of sections) {
      const secSlug = this.slugify(sec.title);
      const secNodeId = `${sec.sectionType}:${docSlug}:${secSlug}`;

      const secNode: GraphNode = {
        id: secNodeId,
        project_id: projectId,
        label: sec.title,
        node_type: sec.sectionType as any,
        summary: sec.content.slice(0, 150).replace(/\n/g, " "),
        domain,
        properties: {
          file_path: filePath,
          page: sec.page,
          ...(sec.line ? { line: sec.line } : {}),
          ...(sec.endLine ? { end_line: sec.endLine } : {}),
          roles_mentioned: sec.rolesMentioned,
          rules_extracted: sec.rulesExtracted,
        },
        is_hub: false,
        provenance: {
          source_file: filePath,
          source_type: path.extname(filePath).slice(1) as any,
          page: sec.page,
          line: sec.line,
          section: sec.title,
          extracted_at: new Date().toISOString(),
        },
      };
      nodes.push(secNode);

      // Edge: Document contains/defines Section
      edges.push({
        project_id: projectId,
        source_id: docNodeId,
        target_id: secNodeId,
        relation_type: "REFERENCES",
        description: `Defines ${sec.title}`,
        weight: 1.0,
      });

      // Role connections
      for (const role of sec.rolesMentioned) {
        const roleId = `role:${this.slugify(role)}`;
        nodes.push({
          id: roleId,
          project_id: projectId,
          label: role,
          node_type: "person",
          summary: `Responsible role: ${role}`,
          domain,
          properties: {},
          is_hub: false,
        });

        edges.push({
          project_id: projectId,
          source_id: secNodeId,
          target_id: roleId,
          relation_type: "APPLIES_TO",
          description: `Assigned to ${role}`,
          weight: 1.0,
        });
      }

      // Rule connections
      for (const rule of sec.rulesExtracted) {
        const ruleId = `rule:${this.slugify(rule)}`;
        nodes.push({
          id: ruleId,
          project_id: projectId,
          label: rule.slice(0, 30),
          node_type: "rule",
          summary: rule,
          domain,
          properties: { rule_text: rule },
          is_hub: false,
        });

        edges.push({
          project_id: projectId,
          source_id: secNodeId,
          target_id: ruleId,
          relation_type: "REQUIRES",
          description: `Mandates rule: ${rule.slice(0, 30)}`,
          weight: 1.0,
        });
      }
    }

    // Deduplicate nodes
    const uniqueNodes = Array.from(new Map(nodes.map((n) => [n.id, n])).values());

    return {
      nodes: uniqueNodes,
      edges,
      rawContent: rawText,
      fileHash,
    };
  }

  private async extractFromCode(
    projectId: string,
    filePath: string,
    domain: string
  ): Promise<ExtractionResult> {
    const fs = await import("fs");
    const content = fs.readFileSync(filePath, "utf-8");
    const fileHash = this.computeFileHash(content);
    const fileName = path.basename(filePath);
    const cls = classifyDocument(content, fileName, path.extname(filePath));
    const autoDomain = isAutoDomain(domain);
    if (autoDomain) domain = cls.domain;

    const parsed = codeParser.parseFile(filePath, content);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Root File/Module Node
    const fileSlug = this.pathSlug(filePath);
    const fileNodeId = `module:${fileSlug}`;
    const imports = codeParser.parseImports(filePath, content);
    nodes.push({
      id: fileNodeId,
      project_id: projectId,
      label: fileName,
      node_type: "module",
      summary: `${fileName}: ${
        parsed.length
          ? `defines ${parsed.slice(0, 6).map((p) => p.name).join(", ")}${parsed.length > 6 ? ` (+${parsed.length - 6} more)` : ""}`
          : "no recognised definitions"
      }`,
      domain,
      properties: {
        file_path: filePath,
        file_hash: fileHash,
        line: 1,
        imports: imports.internal.map((f) => path.basename(f)),
        internal_imports: imports.internal.map((f) => `module:${this.pathSlug(f)}`),
        external_imports: imports.external,
        doc_type: cls.docType,
        classification: { confidence: cls.confidence, matched: cls.matched, auto: autoDomain },
      },
      is_hub: parsed.length > 2,
      provenance: {
        source_file: filePath,
        source_type: "code",
        extracted_at: new Date().toISOString(),
      },
    });

    const localByName = new Map<string, string>();
    for (const item of parsed) {
      const itemNodeId = `${item.kind}:${fileSlug}:${this.slugify(item.name)}`;
      localByName.set(item.name, itemNodeId);
      if (item.name.includes(".")) {
        const shortName = item.name.split(".").pop()!;
        if (!localByName.has(shortName)) localByName.set(shortName, itemNodeId);
      }
    }

    for (const item of parsed) {
      const itemNodeId = `${item.kind}:${fileSlug}:${this.slugify(item.name)}`;
      const nodeType: any = item.kind === "config" ? "env_config" : item.kind;

      nodes.push({
        id: itemNodeId,
        project_id: projectId,
        label: item.name,
        node_type: nodeType,
        summary: item.summary,
        domain,
        properties: {
          file_path: filePath,
          line: item.line,
          ...(item.doc ? { doc: item.doc } : {}),
          ...(item.calls?.length ? { calls: item.calls } : {}),
        },
        is_hub: item.kind === "service",
        provenance: {
          source_file: filePath,
          source_type: "code",
          line: item.line,
          extracted_at: new Date().toISOString(),
        },
      });

      // Edge from Module to Component/Endpoint
      edges.push({
        project_id: projectId,
        source_id: fileNodeId,
        target_id: itemNodeId,
        relation_type: "DEPENDS_ON",
        description: `Module contains ${item.name}`,
        weight: 1.0,
      });

      // Intra-file symbol calls
      for (const callee of item.calls || []) {
        const targetId = localByName.get(callee);
        if (targetId && targetId !== itemNodeId) {
          edges.push({
            project_id: projectId,
            source_id: itemNodeId,
            target_id: targetId,
            relation_type: "CALLS",
            description: `Calls ${callee}`,
            weight: 1.0,
          });
        }
      }

      // Edge for dependencies (prefer local entity in same file such as SQL table or Compose service)
      for (const dep of item.dependsOn) {
        const localDepId = localByName.get(dep);
        if (localDepId && localDepId !== itemNodeId) {
          edges.push({
            project_id: projectId,
            source_id: itemNodeId,
            target_id: localDepId,
            relation_type: "DEPENDS_ON",
            description: `Depends on ${dep}`,
            weight: 1.0,
          });
          continue;
        }
        const depId = `module:${this.slugify(dep)}`;
        nodes.push({
          id: depId,
          project_id: projectId,
          label: dep,
          node_type: "module",
          summary: `External dependency / package ${dep}`,
          domain,
          properties: { is_external: true },
          is_hub: false,
        });

        edges.push({
          project_id: projectId,
          source_id: itemNodeId,
          target_id: depId,
          relation_type: "DEPENDS_ON",
          description: `Depends on ${dep}`,
          weight: 1.0,
        });
      }
    }

    // Module -> module edges for project-internal imports. The target may not be indexed yet, so a
    // placeholder node keeps the edge valid; persistExtraction never lets it overwrite a real node.
    for (const target of imports.internal) {
      const targetId = `module:${this.pathSlug(target)}`;
      if (targetId === fileNodeId) continue;
      nodes.push({
        id: targetId,
        project_id: projectId,
        label: path.basename(target),
        node_type: "module",
        summary: `Source code file ${path.basename(target)} (not indexed yet)`,
        domain,
        properties: { file_path: target, placeholder: true },
        is_hub: false,
      });
      edges.push({
        project_id: projectId,
        source_id: fileNodeId,
        target_id: targetId,
        relation_type: "DEPENDS_ON",
        description: `Imports ${path.basename(target)}`,
        weight: 1.0,
      });
    }

    // Real nodes win over placeholders when the same id appears twice
    const byId = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (!byId.get(n.id) || byId.get(n.id)!.properties.placeholder) byId.set(n.id, n);
    }
    const uniqueNodes = Array.from(byId.values());

    return {
      nodes: uniqueNodes,
      edges,
      rawContent: content,
      fileHash,
    };
  }
}

export const knowledgeExtractor = new KnowledgeExtractor();
