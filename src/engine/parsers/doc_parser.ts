import fs from "fs";
import path from "path";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

export interface DocumentSection {
  title: string;
  content: string;
  page?: number;
  line?: number;
  endLine?: number;
  sectionType: "policy" | "process" | "rule" | "template" | "general";
  rolesMentioned: string[];
  rulesExtracted: string[];
}

export class DocumentParser {
  public async parseFile(filePath: string, preloadedText?: string): Promise<{
    rawText: string;
    sections: DocumentSection[];
  }> {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === ".pdf") {
      return this.parsePDF(filePath);
    } else if (ext === ".docx") {
      return this.parseDOCX(filePath);
    } else {
      // Plain text or Markdown
      const content = preloadedText ?? fs.readFileSync(filePath, "utf-8");
      return this.parseMarkdownOrText(filePath, content);
    }
  }

  private async parsePDF(filePath: string): Promise<{
    rawText: string;
    sections: DocumentSection[];
  }> {
    const buffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(buffer);
    const rawText = pdfData.text;

    const sections = this.extractSections(path.basename(filePath), rawText);
    return { rawText, sections };
  }

  private async parseDOCX(filePath: string): Promise<{
    rawText: string;
    sections: DocumentSection[];
  }> {
    const buffer = fs.readFileSync(filePath);
    const result = await mammoth.extractRawText({ buffer });
    const rawText = result.value;

    const sections = this.extractSections(path.basename(filePath), rawText);
    return { rawText, sections };
  }

  private parseMarkdownOrText(
    filePath: string,
    content: string
  ): { rawText: string; sections: DocumentSection[] } {
    const sections = this.extractSections(path.basename(filePath), content);
    return { rawText: content, sections };
  }

  /**
   * Structural Chunking: Splits by Headings, Chapters, or Articles (Điều, Mục)
   */
  private extractSections(fileName: string, fullText: string): DocumentSection[] {
    const sections: DocumentSection[] = [];
    const lines = fullText.split("\n");

    let currentTitle = `${fileName} - Overview`;
    let currentContent: string[] = [];
    let currentStartLine = 1;
    let pageNum = 1;

    // Regex for structural headers:
    // Markdown # Header, or Vietnamese "Điều 1:", "Chương I:", "Mục 2:", "Article 1"
    const headerRegex = /^(?:#{1,3}\s+|Điều\s+\d+|Chương\s+[IVXLCDM\d]+|Mục\s+\d+|Article\s+\d+)(.*)/i;

    for (let idx = 0; idx < lines.length; idx++) {
      const rawLine = lines[idx];
      const lineNum = idx + 1;
      const line = rawLine.trim();

      // Simple page marker heuristic
      if (line.match(/---\s*Page\s*(\d+)\s*---/i)) {
        const match = line.match(/(\d+)/);
        if (match) pageNum = parseInt(match[1], 10);
        continue;
      }

      const match = line.match(headerRegex);
      if (match) {
        if (currentContent.length > 0) {
          // Flush previous section
          const text = currentContent.join("\n").trim();
          if (text.length > 20) {
            sections.push(this.classifySection(currentTitle, text, pageNum, currentStartLine, Math.max(currentStartLine, lineNum - 1)));
          }
        }
        currentTitle = line.replace(/^#{1,3}\s+/, "").trim();
        currentContent = [];
        currentStartLine = lineNum;
      } else {
        if (line.length > 0) {
          currentContent.push(line);
        }
      }
    }

    if (currentContent.length > 0) {
      const text = currentContent.join("\n").trim();
      if (text.length > 20) {
        sections.push(this.classifySection(currentTitle, text, pageNum, currentStartLine, lines.length));
      }
    }

    if (sections.length === 0) {
      sections.push({
        title: fileName,
        content: fullText.slice(0, 2000),
        page: 1,
        line: 1,
        endLine: lines.length,
        sectionType: "general",
        rolesMentioned: [],
        rulesExtracted: [],
      });
    }

    return sections;
  }

  private classifySection(
    title: string,
    text: string,
    page: number,
    line?: number,
    endLine?: number
  ): DocumentSection {
    const lower = (title + " " + text).toLowerCase();

    let sectionType: DocumentSection["sectionType"] = "general";
    if (lower.includes("chính sách") || lower.includes("policy") || lower.includes("quy định")) {
      sectionType = "policy";
    } else if (lower.includes("quy trình") || lower.includes("thủ tục") || lower.includes("process") || lower.includes("bước")) {
      sectionType = "process";
    } else if (lower.includes("bắt buộc") || lower.includes("hạn mức") || lower.includes("điều kiện") || lower.includes("rule")) {
      sectionType = "rule";
    } else if (lower.includes("biểu mẫu") || lower.includes("mẫu số") || lower.includes("template")) {
      sectionType = "template";
    }

    // Extract roles mentioned: Phòng Kế toán, Giám đốc, Nhân viên, Admin, Lead, CFO, Manager
    const roles: string[] = [];
    const roleMatches = text.match(/(?:phòng\s+[A-Za-zÀ-ỹ]+|giám\s+đốc|trưởng\s+phòng|kế\s+toán|nhân\s+viên|admin|manager|lead|cfo|ceo)/gi);
    if (roleMatches) {
      for (const r of roleMatches) {
        const cleaned = r.trim().toLowerCase();
        if (!roles.includes(cleaned)) roles.push(cleaned);
      }
    }

    // Extract rules / limits: numbers with triệu, VND, $, ngày, hạn mức
    const rules: string[] = [];
    const ruleMatches = text.match(/(?:hạn\s+mức|tối\s+đa|tối\s+thiểu|không\s+quá|bắt\s+buộc|trong\s+vòng)\s+[^\n.,;]+/gi);
    if (ruleMatches) {
      for (const rm of ruleMatches) {
        rules.push(rm.trim());
      }
    }

    return {
      title,
      content: text,
      page,
      line,
      endLine,
      sectionType,
      rolesMentioned: roles.slice(0, 3),
      rulesExtracted: rules.slice(0, 3),
    };
  }
}

export const documentParser = new DocumentParser();
