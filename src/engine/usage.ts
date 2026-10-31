import type { DatabaseInstance } from "../database.js";

// A pause this long between calls is treated as a new agent session (tool schemas get re-sent)
const SESSION_GAP_MS = 30 * 60_000;
const EMPTY_RESULT = /\(0 matches\)|no matches|not found|no (?:nodes|results|gaps)/i;

export function initUsage(db: DatabaseInstance): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      tool TEXT NOT NULL,
      project_id TEXT,
      duration_ms REAL,
      tokens_out INTEGER,
      is_error INTEGER DEFAULT 0,
      is_empty INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_calls_ts ON tool_calls(timestamp);
    DELETE FROM tool_calls WHERE timestamp < ${Date.now() - 90 * 86_400_000};
  `);
}

/** Records every MCP call, including failures and tools that don't report telemetry themselves. */
export function recordCall(
  db: DatabaseInstance,
  tool: string,
  args: any,
  startedNs: bigint,
  result: { content?: Array<{ text?: string }>; isError?: boolean } | null
): void {
  const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
  const isError = !result || !!result.isError;
  db.prepare(
    `INSERT INTO tool_calls (timestamp, tool, project_id, duration_ms, tokens_out, is_error, is_empty) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    tool,
    typeof args?.project_id === "string" ? args.project_id : null,
    Number((Number(process.hrtime.bigint() - startedNs) / 1e6).toFixed(2)),
    Math.ceil(text.length / 4),
    isError ? 1 : 0,
    !isError && EMPTY_RESULT.test(text) ? 1 : 0
  );
}

export function usageSummary(db: DatabaseInstance, days: number, schemaTokens: number) {
  const since = Date.now() - days * 86_400_000;
  const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as any[];

  const totals = all(
    `SELECT COUNT(*) calls, COALESCE(SUM(is_error),0) errors, COALESCE(SUM(is_empty),0) empty, MAX(timestamp) last_call_at
     FROM tool_calls WHERE timestamp >= ?`, since)[0];

  const sessions = all(
    `SELECT COUNT(*) n FROM (
       SELECT timestamp - LAG(timestamp) OVER (ORDER BY timestamp) AS gap FROM tool_calls WHERE timestamp >= ?
     ) WHERE gap IS NULL OR gap > ?`, since, SESSION_GAP_MS)[0].n;

  const saved = all(
    `SELECT COALESCE(SUM(raw_equivalent_tokens - tokens_returned), 0) s FROM telemetry WHERE timestamp >= ?`, since)[0].s;

  return {
    window_days: days,
    ...totals,
    sessions,
    schema_tokens_per_session: schemaTokens,
    overhead_tokens: schemaTokens * sessions,
    saved_tokens_gross: saved,
    saved_tokens_net: saved - schemaTokens * sessions,
    by_tool: all(
      `SELECT tool, COUNT(*) calls, SUM(is_error) errors, SUM(is_empty) empty,
              ROUND(AVG(duration_ms), 2) avg_ms, ROUND(AVG(tokens_out)) avg_tokens, SUM(tokens_out) total_tokens
       FROM tool_calls WHERE timestamp >= ? GROUP BY tool ORDER BY calls DESC`, since),
    by_day: all(
      `SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') day, COUNT(*) calls
       FROM tool_calls WHERE timestamp >= ? GROUP BY day ORDER BY day`, since),
    by_project: all(
      `SELECT COALESCE(project_id, '(không có)') project_id, COUNT(*) calls
       FROM tool_calls WHERE timestamp >= ? GROUP BY project_id ORDER BY calls DESC LIMIT 10`, since),
  };
}
