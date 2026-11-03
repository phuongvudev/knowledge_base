import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

export type DatabaseInstance = DatabaseSync;

export function initDatabase(dbPath?: string): DatabaseInstance {
  const resolvedPath =
    dbPath ||
    process.env.KB_DB_PATH ||
    path.join(process.cwd(), "data", "neural_knowledge.db");

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);

  // ══════════════════════════════════════════════════════════════
  // Production PRAGMAs: Zero-Copy, High-Concurrency WAL Mode
  // ══════════════════════════════════════════════════════════════
  db.exec("PRAGMA busy_timeout = 5000;");     // MCP + web processes share this file; wait instead of "database is locked"
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA mmap_size = 30000000000;"); // 30GB MMAP for kernel zero-copy
  db.exec("PRAGMA cache_size = -64000;");     // 64MB RAM page cache
  db.exec("PRAGMA temp_store = MEMORY;");     // Temp tables in memory
  db.exec("PRAGMA foreign_keys = ON;");

  // ══════════════════════════════════════════════════════════════
  // Schema Initialization
  // ══════════════════════════════════════════════════════════════
  db.exec(`
    -- project -> library project it imports; derived from imports, rebuilt after indexing
    CREATE TABLE IF NOT EXISTS project_links (
      project_id TEXT NOT NULL,
      linked_id TEXT NOT NULL,
      PRIMARY KEY (project_id, linked_id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      domain TEXT DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS graph_nodes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      node_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      domain TEXT DEFAULT 'general',
      properties TEXT,
      is_hub BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      description TEXT,
      weight REAL DEFAULT 1.0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      UNIQUE(source_id, target_id, relation_type)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_project ON graph_edges(project_id);
    CREATE INDEX IF NOT EXISTS idx_nodes_domain ON graph_nodes(project_id, domain, node_type);
    CREATE INDEX IF NOT EXISTS idx_nodes_updated ON graph_nodes(updated_at);

    CREATE TABLE IF NOT EXISTS project_lexicon (
      project_id TEXT NOT NULL,
      term TEXT NOT NULL,
      synonyms TEXT NOT NULL,
      PRIMARY KEY (project_id, term)
    );
    CREATE INDEX IF NOT EXISTS idx_lexicon_project ON project_lexicon(project_id);

    -- Auto-seed existing distinct project_ids
    INSERT OR IGNORE INTO projects (id, name, description, domain)
    SELECT DISTINCT project_id, project_id, 'Dự án đã nạp', 'general'
    FROM graph_nodes;

    CREATE TABLE IF NOT EXISTS ingest_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      total INTEGER DEFAULT 0,
      processed INTEGER DEFAULT 0,
      skipped INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      current_file TEXT,
      error TEXT,
      started_at INTEGER,
      updated_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_project ON ingest_jobs(project_id, id);

    -- Bound the append-only logs
    DELETE FROM ingest_jobs WHERE id NOT IN (SELECT id FROM ingest_jobs ORDER BY id DESC LIMIT 500);

    CREATE TABLE IF NOT EXISTS knowledge_gaps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      missing_item TEXT NOT NULL,
      reason TEXT NOT NULL,
      suggested_action TEXT,
      status TEXT DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_gaps_project ON knowledge_gaps(project_id, status);

    CREATE TABLE IF NOT EXISTS raw_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      file_path TEXT,
      file_hash TEXT,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sources_hash ON raw_sources(project_id, file_hash);

    CREATE TABLE IF NOT EXISTS node_sources (
      node_id TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      page_number INTEGER,
      section_title TEXT,
      PRIMARY KEY (node_id, source_id),
      FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (source_id) REFERENCES raw_sources(id) ON DELETE CASCADE
    );

    -- FTS5 Full-Text Search
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id, label, node_type, summary, domain, properties,
      content='graph_nodes', content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS raw_sources_fts USING fts5(
      title, content,
      content='raw_sources', content_rowid='id'
    );
  `);

  // FTS5 Triggers for graph_nodes
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON graph_nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, label, node_type, summary, domain, properties)
      VALUES (new.rowid, new.id, new.label, new.node_type, new.summary, new.domain, new.properties);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON graph_nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, label, node_type, summary, domain, properties)
      VALUES ('delete', old.rowid, old.id, old.label, old.node_type, old.summary, old.domain, old.properties);
    END;

    CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON graph_nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, label, node_type, summary, domain, properties)
      VALUES ('delete', old.rowid, old.id, old.label, old.node_type, old.summary, old.domain, old.properties);
      INSERT INTO nodes_fts(rowid, id, label, node_type, summary, domain, properties)
      VALUES (new.rowid, new.id, new.label, new.node_type, new.summary, new.domain, new.properties);
    END;

    -- FTS5 Triggers for raw_sources
    CREATE TRIGGER IF NOT EXISTS sources_ai AFTER INSERT ON raw_sources BEGIN
      INSERT INTO raw_sources_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS sources_ad AFTER DELETE ON raw_sources BEGIN
      INSERT INTO raw_sources_fts(raw_sources_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS sources_au AFTER UPDATE ON raw_sources BEGIN
      INSERT INTO raw_sources_fts(raw_sources_fts, rowid, title, content)
      VALUES ('delete', old.id, old.title, old.content);
      INSERT INTO raw_sources_fts(rowid, title, content)
      VALUES (new.id, new.title, new.content);
    END;
  `);

  // Edges written by the extractor are tagged with their file so re-indexing can replace them
  // without touching edges added by hand (kb_add_relation). SQLite has no ADD COLUMN IF NOT EXISTS.
  const edgeCols = db.prepare("PRAGMA table_info(graph_edges)").all() as any[];
  if (!edgeCols.some((c) => c.name === "source_file")) {
    db.exec("ALTER TABLE graph_edges ADD COLUMN source_file TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_edges_file ON graph_edges(source_file)");
  }

  // Stemming ("indexed" finds "index") and accent-insensitive Vietnamese search need a new tokenizer;
  // FTS tables can't be altered, so rebuild from graph_nodes once.
  const ftsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'").get() as any)?.sql ?? "";
  if (!ftsSql.includes("porter")) {
    db.exec("DROP TABLE IF EXISTS nodes_fts");
    db.exec(`CREATE VIRTUAL TABLE nodes_fts USING fts5(
      id, label, node_type, summary, domain, properties,
      content='graph_nodes', content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    )`);
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  return db;
}
