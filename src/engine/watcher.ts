import fs from "node:fs";
import path from "node:path";
import { initDatabase, DatabaseInstance } from "../database.js";
import { graphMemory } from "./graph_memory.js";
import { knowledgeExtractor } from "./parsers/extractor.js";
import { persistExtraction, removeFile } from "./persist.js";
import { refreshLinks } from "./deps.js";
import { loadIgnore } from "./ignore.js";

export interface WatcherOptions {
  projectId: string;
  dirPath: string;
  debounceMs?: number;
  extensions?: string[];
  onSync?: (event: "change" | "add" | "unlink", filePath: string) => void;
}

export class KnowledgeWatcher {
  private db: DatabaseInstance;
  private projectId: string;
  private dirPath: string;
  private debounceMs: number;
  private validExts: Set<string>;
  private isIgnored: (p: string) => boolean;
  private pendingQueue = new Map<string, "change" | "add" | "unlink">();
  private debounceTimer: NodeJS.Timeout | null = null;
  private watcher: fs.FSWatcher | null = null;
  private onSyncCallback?: (event: "change" | "add" | "unlink", filePath: string) => void;

  constructor(options: WatcherOptions, db?: DatabaseInstance) {
    this.projectId = options.projectId;
    this.dirPath = path.resolve(options.dirPath);
    this.debounceMs = options.debounceMs || 500;
    this.onSyncCallback = options.onSync;
    this.db = db || initDatabase();

    const exts = options.extensions || [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".py",
      ".dart",
      ".md",
      ".sql",
      ".json",
      ".yaml",
      ".yml",
    ];
    this.validExts = new Set(exts.map((e) => (e.startsWith(".") ? e : `.${e}`)));
    this.isIgnored = loadIgnore(this.dirPath);
  }

  public start(): void {
    if (!fs.existsSync(this.dirPath)) {
      throw new Error(`Target directory does not exist: ${this.dirPath}`);
    }

    console.log(`\n👁️  [KnowledgeWatcher] Watching directory: ${this.dirPath}`);
    console.log(`📌 Project: ${this.projectId} (Debounce: ${this.debounceMs}ms)\n`);

    try {
      this.watcher = fs.watch(
        this.dirPath,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(this.dirPath, filename);
          const ext = path.extname(filename).toLowerCase();

          // Check extensions & ignore patterns
          if (!this.validExts.has(ext)) return;
          if (this.isIgnored(fullPath)) return;

          const action = fs.existsSync(fullPath) ? "change" : "unlink";
          this.pendingQueue.set(fullPath, action);

          if (this.debounceTimer) clearTimeout(this.debounceTimer);
          this.debounceTimer = setTimeout(() => this.flushQueue(), this.debounceMs);
        }
      );
    } catch (err: any) {
      console.error(`[KnowledgeWatcher] Failed to start watcher:`, err.message);
    }
  }

  public stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log(`[KnowledgeWatcher] Stopped watching.`);
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async flushQueue(): Promise<void> {
    const queue = new Map(this.pendingQueue);
    this.pendingQueue.clear();

    if (queue.size === 0) return;

    for (const [filePath, action] of queue.entries()) {
      try {
        if (action === "unlink") {
          removeFile(this.db, this.projectId, filePath);
          console.log(`[KnowledgeWatcher] 🗑️  Removed: ${path.relative(this.dirPath, filePath)}`);
          this.onSyncCallback?.("unlink", filePath);
        } else {
          // Changed or Added
          const result = await knowledgeExtractor.extractFromFile(
            this.projectId,
            filePath,
            "auto"
          );

          // Check if hash changed to avoid redundant work
          const existing = this.db
            .prepare(`SELECT file_hash FROM raw_sources WHERE project_id = ? AND file_path = ?`)
            .get(this.projectId, filePath) as { file_hash: string } | undefined;

          if (existing && existing.file_hash === result.fileHash) {
            continue; // Hash is identical, no AST changes
          }

          persistExtraction(this.db, this.projectId, filePath, result);
          console.log(`[KnowledgeWatcher] ⚡ Synced: ${path.relative(this.dirPath, filePath)} (${result.nodes.length} symbols)`);
          this.onSyncCallback?.("change", filePath);
        }
      } catch (err: any) {
        console.error(`[KnowledgeWatcher] Error processing ${filePath}:`, err.message);
      }
    }

    // Refresh memory graph & links
    refreshLinks(this.db);
    graphMemory.hydrate(this.db);
  }
}

// Standalone CLI runner: tsx src/engine/watcher.ts <project_id> [dir_path]
if (process.argv[1]?.endsWith("watcher.ts") || process.argv[1]?.endsWith("watcher.js")) {
  const projectId = process.argv[2];
  const dirPath = process.argv[3] || process.cwd();

  if (!projectId) {
    console.log(`Usage: tsx src/engine/watcher.ts <project_id> [dir_path]`);
    process.exit(1);
  }

  const watcher = new KnowledgeWatcher({ projectId, dirPath });
  watcher.start();

  process.on("SIGINT", () => {
    watcher.stop();
    process.exit(0);
  });
}
