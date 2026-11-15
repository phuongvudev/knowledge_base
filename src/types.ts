import { z } from "zod";

// ══════════════════════════════════════════════════════════════
// Graph Entities & Relations
// ══════════════════════════════════════════════════════════════

export type NodeType =
  | "project"
  | "module"
  | "service"
  | "component"
  | "api_endpoint"
  | "data_model"
  | "env_config"
  | "decision"
  | "rule"
  | "person"
  | "policy"
  | "process"
  | "template"
  | "general";

export type RelationType =
  | "DEPENDS_ON"
  | "CALLS"
  | "STORES_IN"
  | "GOVERNED_BY"
  | "CONFIGURED_BY"
  | "OWNED_BY"
  | "AFFECTS"
  | "REQUIRES"
  | "APPLIES_TO"
  | "APPROVED_BY"
  | "SUPERSEDES"
  | "REFERENCES"
  | "CONTAINS";

export interface NodeProvenance {
  source_file: string;
  source_type: "code" | "pdf" | "docx" | "markdown" | "decision";
  page?: number;
  section?: string;
  line?: number;
  end_line?: number;
  extracted_at: string;
}

export interface GraphNode {
  id: string;
  project_id: string;
  label: string;
  node_type: NodeType;
  summary: string;
  domain: string;
  properties: Record<string, any>;
  is_hub: boolean;
  provenance?: NodeProvenance;
  created_at?: string;
  updated_at?: string;
}

export interface GraphEdge {
  id?: number;
  project_id: string;
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  description?: string;
  weight: number;
  created_at?: string;
}

export interface KnowledgeGap {
  id?: number;
  project_id: string;
  missing_item: string;
  reason: string;
  suggested_action?: string;
  status: "open" | "resolved" | "ignored";
  created_at?: string;
  resolved_at?: string;
}

export interface RawSource {
  id?: number;
  project_id: string;
  title: string;
  source_type: "code" | "pdf" | "docx" | "markdown" | "decision";
  file_path?: string;
  file_hash?: string;
  content: string;
  created_at?: string;
}

// ══════════════════════════════════════════════════════════════
// Level of Detail (Semantic Zoom)
// ══════════════════════════════════════════════════════════════

export enum LevelOfDetail {
  LOD0_MACRO = 0, // Top 5-10 domains, key hubs (~250 tokens)
  LOD1_MESO = 1,  // Modules/Services & immediate connections (~350 tokens)
  LOD2_MICRO = 2, // Full details & on-demand raw references (~500+ tokens)
}

// ══════════════════════════════════════════════════════════════
// Telemetry & Metrics
// ══════════════════════════════════════════════════════════════

export interface TelemetryRecord {
  timestamp: number;
  tool_name: string;
  duration_ms: number;
  db_duration_ms: number | null;
  graph_duration_ms: number | null;
  tokens_returned: number;
  raw_equivalent_tokens: number;
  token_savings_percent: number;
  ram_used_mb: number;
}

export interface PerformanceStats {
  total_queries: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p99_latency_ms: number;
  total_tokens_returned: number;
  total_raw_equivalent_tokens: number;
  overall_savings_percent: number;
  current_ram_mb: number;
  node_count: number;
  edge_count: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  description?: string;
  domain?: string;
  created_at?: string;
  updated_at?: string;
}

// ══════════════════════════════════════════════════════════════
// Zod Validation Schemas for MCP Tools
// ══════════════════════════════════════════════════════════════

export const CreateProjectSchema = z.object({
  project_id: z
    .string()
    .min(1)
    .describe("Unique project identifier slug (e.g. 'core-banking', 'payment-v2')"),
  name: z.string().min(1).describe("Human-readable project display name"),
  description: z
    .string()
    .optional()
    .describe("Description of the project scope and goals"),
  domain: z
    .string()
    .optional()
    .default("general")
    .describe("Primary business domain (e.g. 'finance', 'security', 'ecommerce')"),
});

export const GraphOverviewSchema = z.object({
  project_id: z.string().describe("Identifier of the project"),
  lod: z.number().min(0).max(1).optional().default(0).describe("Level of detail: 0 for Macro domains, 1 for Key Hubs"),
  format: z.enum(["mermaid", "summary"]).optional().default("mermaid").describe("Visual diagram format"),
});

export const GraphExploreSchema = z.object({
  node_id: z.string().describe("ID of the central node to explore"),
  depth: z.number().min(1).max(2).optional().default(1).describe("Search radius (1-2 steps)"),
  project_id: z.string().optional().describe("Optional project filter to disambiguate symbol"),
});

export const GraphImpactSchema = z.object({
  target_node_id: z.string().describe("ID of the node being modified or evaluated"),
  project_id: z.string().optional().describe("Optional project filter to disambiguate symbol"),
});

export const IngestFileSchema = z.object({
  project_id: z.string().describe("Target project identifier"),
  file_path: z.string().describe("Absolute or relative file path to ingest"),
  domain: z.string().optional().default("auto").describe("Domain category (e.g. auth, billing, legal, ops); 'auto' classifies from content"),
});

export const BatchIngestSchema = z.object({
  project_id: z.string().describe("Target project identifier"),
  dir_path: z.string().describe("Directory path to scan and ingest"),
  extensions: z.array(z.string()).optional().describe("Allowed extensions (e.g. ['.pdf', '.docx', '.ts', '.py', '.md'])"),
  force: z.boolean().optional().default(false).describe("Re-index files even if unchanged"),
  ignore: z.array(z.string()).optional().describe("Extra gitignore-style patterns to skip, on top of .kbignore"),
});

export const AddNodeSchema = z.object({
  project_id: z.string().describe("Project identifier"),
  id: z.string().describe("Unique node identifier slug (e.g. 'rule:idempotency', 'service:auth')"),
  label: z.string().describe("Human readable name"),
  node_type: z.enum([
    "project", "module", "service", "component", "api_endpoint",
    "data_model", "env_config", "decision", "rule", "person",
    "policy", "process", "template"
  ]).describe("Entity classification"),
  summary: z.string().describe("1-2 sentence core distillation (~20-40 tokens)"),
  domain: z.string().optional().default("general").describe("Domain name"),
  links_to: z.array(z.object({
    target_id: z.string(),
    relation: z.enum([
      "DEPENDS_ON", "CALLS", "STORES_IN", "GOVERNED_BY",
      "CONFIGURED_BY", "OWNED_BY", "AFFECTS", "REQUIRES",
      "APPLIES_TO", "APPROVED_BY", "SUPERSEDES", "REFERENCES", "CONTAINS"
    ]),
    description: z.string().optional()
  })).optional().describe("Outbound links to existing nodes"),
});

export const AddRelationSchema = z.object({
  project_id: z.string().describe("Project identifier"),
  source_id: z.string().describe("Source node ID"),
  target_id: z.string().describe("Target node ID"),
  relation_type: z.enum([
    "DEPENDS_ON", "CALLS", "STORES_IN", "GOVERNED_BY",
    "CONFIGURED_BY", "OWNED_BY", "AFFECTS", "REQUIRES",
    "APPLIES_TO", "APPROVED_BY", "SUPERSEDES", "REFERENCES", "CONTAINS"
  ]).describe("Relation type"),
  description: z.string().optional().describe("Contextual note for this relationship"),
});

export const FlagGapSchema = z.object({
  project_id: z.string().describe("Project identifier"),
  missing_item: z.string().describe("Missing component or concept (e.g. 'service:billing', 'schema:payment_webhook')"),
  reason: z.string().describe("Why this data is needed and how the gap was discovered"),
  suggested_action: z.string().optional().describe("Recommended action (e.g. 'Upload billing-spec.yaml')"),
});

export const AuditGapsSchema = z.object({
  project_id: z.string().describe("Project identifier to audit"),
});

export const NodeGetSchema = z.object({
  node_id: z.string().describe("ID of the node to retrieve"),
  include_raw: z.boolean().optional().default(false).describe("Whether to fetch raw source text/provenance excerpt"),
  project_id: z.string().optional().describe("Optional project filter to disambiguate symbol"),
});

export const SearchSchema = z.object({
  query: z.string().describe("Full-text search keyword"),
  project_id: z.string().optional().describe("Optional project filter"),
  limit: z.number().int().min(1).max(50).optional().default(5).describe("Maximum number of results to return"),
  code: z.number().int().min(0).max(60).optional().default(0).describe("Source lines to include for the top 2 hits"),
  max_tokens: z.number().int().min(50).optional().describe("Cap on the size of the response"),
  auto_ingest_lib: z.boolean().optional().default(false).describe("If true and search misses an unindexed dependency, auto-indexes that library and retries"),
});

export const ResolveLibrarySchema = z.object({
  project_id: z.string().describe("Project requiring or importing the library (e.g. 'budgetable-v2')"),
  library_name: z.string().describe("Name of the 3rd-party library/package, e.g. 'flutter_bloc', 'go_router', 'objectbox'"),
  auto_ingest: z.boolean().optional().default(true).describe("If true, automatically creates 'lib-<name>' project, batch ingests from package cache, and links it. If false, returns redirection info only."),
});

export const FileOutlineSchema = z.object({
  file_path: z.string().describe("Absolute path, or a path suffix such as 'engine/persist.ts'"),
  project_id: z.string().optional().describe("Optional project filter"),
});

export const SyncSchema = z.object({
  project_id: z.string().describe("Project whose indexed files should be refreshed"),
  dir_path: z.string().optional().describe("Also index files in this directory that are not indexed yet"),
  ignore: z.array(z.string()).optional().describe("Extra gitignore-style patterns to skip, on top of .kbignore"),
  force: z.boolean().optional().default(false).describe("If true, forces re-parsing of all files regardless of unchanged SHA-256 hash"),
});

export const StatsSchema = z.object({
  project_id: z.string().optional().describe("Optional project filter"),
});

export const MetricsSchema = z.object({
  reset: z.boolean().optional().default(false).describe("Whether to reset accumulated metrics"),
});

export const PruneLibrariesSchema = z.object({
  dry_run: z.boolean().optional().default(false).describe("If true, only previews what would be pruned without deleting"),
  vacuum: z.boolean().optional().default(true).describe("If true, runs SQLite VACUUM to reclaim disk space after pruning"),
});

export const AuditArchitectureSchema = z.object({
  project_id: z.string().describe("Target project slug"),
});
