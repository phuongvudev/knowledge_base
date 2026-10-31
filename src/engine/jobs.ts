import type { DatabaseInstance } from "../database.js";

export interface IngestJob {
  id: number;
  project_id: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled";
  total: number;
  processed: number;
  skipped: number;
  failed: number;
  current_file: string | null;
  error: string | null;
  started_at: number;
  updated_at: number;
}

// A running job untouched this long belongs to a crashed/killed process
const STALE_MS = 120_000;

// Jobs live in the shared DB so the web UI sees indexing started by the MCP server
export const jobs = {
  start(db: DatabaseInstance, projectId: string, label: string, total: number): number {
    const now = Date.now();
    const r = db
      .prepare(`INSERT INTO ingest_jobs (project_id, label, status, total, started_at, updated_at)
                VALUES (?, ?, 'running', ?, ?, ?)`)
      .run(projectId, label, total, now, now);
    return Number(r.lastInsertRowid);
  },

  progress(
    db: DatabaseInstance,
    id: number,
    p: { processed: number; skipped: number; failed: number; current?: string }
  ): void {
    db.prepare(`UPDATE ingest_jobs SET processed = ?, skipped = ?, failed = ?, current_file = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(p.processed, p.skipped, p.failed, p.current ?? null, Date.now(), id);
  },

  // Cooperative: the ingest loop polls isCancelled() between files
  cancel(db: DatabaseInstance, id: number): boolean {
    const r = db.prepare(`UPDATE ingest_jobs SET status = 'cancelled', current_file = NULL, updated_at = ?
                          WHERE id = ? AND status = 'running'`).run(Date.now(), id);
    return Number(r.changes) > 0;
  },

  isCancelled(db: DatabaseInstance, id: number): boolean {
    const r = db.prepare(`SELECT status FROM ingest_jobs WHERE id = ?`).get(id) as { status: string } | undefined;
    return r?.status === "cancelled";
  },

  hasRunning(db: DatabaseInstance, projectId: string): boolean {
    this.list(db, projectId, 1); // expires stale jobs first
    return !!db.prepare(`SELECT 1 FROM ingest_jobs WHERE project_id = ? AND status = 'running'`).get(projectId);
  },

  finish(db: DatabaseInstance, id: number, error?: string): void {
    // a cancelled job stays cancelled
    db.prepare(`UPDATE ingest_jobs SET status = ?, error = ?, current_file = NULL, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(error ? "error" : "done", error ?? null, Date.now(), id);
  },

  list(db: DatabaseInstance, projectId?: string, limit = 20): IngestJob[] {
    db.prepare(`UPDATE ingest_jobs SET status = 'error', error = 'Tiến trình bị gián đoạn', current_file = NULL
                WHERE status = 'running' AND updated_at < ?`).run(Date.now() - STALE_MS);
    const sql = `SELECT * FROM ingest_jobs ${projectId ? "WHERE project_id = ?" : ""} ORDER BY id DESC LIMIT ?`;
    const params = projectId ? [projectId, limit] : [limit];
    return db.prepare(sql).all(...params) as unknown as IngestJob[];
  },
};
