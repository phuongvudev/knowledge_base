// Rule-based document classifier: guesses business domain + document type from
// file name and content. Keyword scoring on diacritic-free text, so Vietnamese
// and English both match. shortcut: keyword rules, no ML — swap for embeddings if accuracy matters.

export interface Classification {
  domain: string;
  docType: string;
  confidence: number; // 0..1
  matched: string[];
}

const DOMAIN_KEYWORDS: Record<string, string[]> = {
  auth: ["auth", "login", "oauth", "jwt", "token", "password", "mat khau", "dang nhap", "xac thuc", "phan quyen", "rbac", "session", "sso", "mfa"],
  security: ["security", "bao mat", "encrypt", "ma hoa", "vulnerab", "lo hong", "pentest", "firewall", "gdpr", "pii"],
  payment: ["payment", "thanh toan", "refund", "hoan tien", "idempotency", "checkout", "gateway", "cong thanh toan", "invoice", "hoa don", "vnpay", "momo", "stripe"],
  finance: ["finance", "tai chinh", "ngan sach", "budget", "ke toan", "accounting", "han muc", "phe duyet", "loan", "vay", "lai suat", "ngan hang", "banking", "cfo", "kiem toan"],
  legal: ["legal", "phap ly", "hop dong", "contract", "dieu khoan", "quy che", "nghi dinh", "thong tu", "luat", "compliance", "tuan thu", "quy dinh"],
  hr: ["nhan su", "nhan vien", "tuyen dung", "luong", "payroll", "nghi phep", "leave policy", "onboarding", "hr "],
  ecommerce: ["ecommerce", "order", "don hang", "cart", "gio hang", "inventory", "ton kho", "product", "san pham", "shipping", "van chuyen", "catalog"],
  ops: ["deploy", "ci/cd", "kubernetes", "docker", "runbook", "incident", "su co", "monitoring", "giam sat", "sla", "on-call", "terraform", "pipeline", "van hanh"],
  data: ["database", "schema", "migration", "sql", "table", "bang du lieu", "etl", "warehouse", "index", "query"],
  developer: ["api", "endpoint", "sdk", "class", "function", "interface", "module", "import", "export", "controller", "service", "repository"],
};

const TYPE_RULES: Array<[string, string[]]> = [
  ["contract", ["hop dong", "contract", "ben a", "ben b", "party a", "party b"]],
  ["decision", ["adr", "quyet dinh", "decision record", "context", "consequences", "status: accepted"]],
  ["runbook", ["runbook", "playbook", "buoc 1", "step 1", "rollback", "troubleshoot", "sop"]],
  ["api-spec", ["openapi", "swagger", "endpoint", "request body", "response", "http 200", "get /", "post /"]],
  ["policy", ["quy che", "quy dinh", "chinh sach", "policy", "dieu 1", "dieu 2", "phai ", "bat buoc", "must", "shall"]],
  ["report", ["bao cao", "report", "ket qua", "summary", "tong ket", "quarterly"]],
  ["guide", ["huong dan", "guide", "tutorial", "how to", "readme", "cai dat", "installation"]],
];

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".go", ".rs", ".sql", ".json", ".yaml", ".yml", ".sh"]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1 && n < 50) {
    // whole-word-ish: previous char must not be a letter
    if (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

function score(text: string, fileName: string, rules: Record<string, string[]>) {
  const body = normalize(text.slice(0, 20000));
  const name = normalize(fileName);
  const scores: Array<{ key: string; score: number; matched: string[] }> = [];
  for (const [key, words] of Object.entries(rules)) {
    let s = 0;
    const matched: string[] = [];
    for (const w of words) {
      const c = Math.min(countOccurrences(body, w), 5); // cap so one repeated word can't dominate
      const inName = name.includes(w.trim()) ? 3 : 0; // file name is a strong signal
      if (c + inName > 0) {
        s += c + inName;
        matched.push(w.trim());
      }
    }
    scores.push({ key, score: s, matched });
  }
  return scores.sort((a, b) => b.score - a.score);
}

const MIN_SCORE = 3;

export function classifyDocument(text: string, fileName: string, ext = ""): Classification {
  const ranked = score(text, fileName, DOMAIN_KEYWORDS);
  const [top, second] = ranked;
  const isCode = CODE_EXT.has(ext.toLowerCase());

  // Code files mention "service"/"class" everywhere, so only trust a non-developer domain if it clearly wins
  let domain = "general";
  let matched: string[] = [];
  let confidence = 0;
  if (top && top.score >= MIN_SCORE) {
    domain = top.key;
    matched = top.matched;
    confidence = top.score / (top.score + (second?.score || 0) + 1);
  }
  if (isCode && domain === "general") domain = "developer";

  let docType = isCode ? "code" : "document";
  if (!isCode) {
    const types = score(text, fileName, Object.fromEntries(TYPE_RULES));
    if (types[0] && types[0].score >= 2) docType = types[0].key;
  }

  return { domain, docType, confidence: Number(confidence.toFixed(2)), matched: matched.slice(0, 5) };
}

/** "auto", empty and the legacy default "general" all mean: classify for me. */
export function isAutoDomain(domain?: string): boolean {
  return !domain || domain === "auto" || domain === "general";
}
