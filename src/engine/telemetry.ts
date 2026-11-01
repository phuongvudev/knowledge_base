import { PerformanceStats, TelemetryRecord } from "../types.js";
import type { DatabaseInstance } from "../database.js";

class TelemetryEngine {
  private records: TelemetryRecord[] = [];
  private maxRecords = 500;
  // MCP server and web server are separate processes; the shared DB is how they see each other's calls
  private db: DatabaseInstance | null = null;

  public attach(db: DatabaseInstance): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER, tool_name TEXT, duration_ms REAL, db_duration_ms REAL,
        graph_duration_ms REAL, tokens_returned INTEGER, raw_equivalent_tokens INTEGER,
        token_savings_percent REAL, ram_used_mb REAL
      );
    `);
    db.exec(`DELETE FROM telemetry WHERE id NOT IN (SELECT id FROM telemetry ORDER BY id DESC LIMIT 5000)`);
    this.db = db;
  }

  private load(): TelemetryRecord[] {
    if (!this.db) return this.records;
    return this.db
      .prepare(`SELECT * FROM telemetry ORDER BY id DESC LIMIT ?`)
      .all(this.maxRecords) as unknown as TelemetryRecord[];
  }

  // Approximate token estimator (1 token ~= 4 chars)
  public estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  public record(
    toolName: string,
    startTime: bigint,
    dbDurationMs: number | null,
    graphDurationMs: number | null,
    returnedText: string,
    rawEquivalentText: string
  ): { footer: string; record: TelemetryRecord } {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000;

    const tokensReturned = this.estimateTokens(returnedText);
    const rawTokens = Math.max(tokensReturned, this.estimateTokens(rawEquivalentText));
    const tokenSavingsPercent =
      rawTokens > 0
        ? Number((((rawTokens - tokensReturned) / rawTokens) * 100).toFixed(1))
        : 0;

    const mem = process.memoryUsage();
    const ramUsedMb = Number((mem.heapUsed / 1024 / 1024).toFixed(1));

    const rec: TelemetryRecord = {
      timestamp: Date.now(),
      tool_name: toolName,
      duration_ms: Number(durationMs.toFixed(2)),
      db_duration_ms: dbDurationMs === null ? null : Number(dbDurationMs.toFixed(2)),
      graph_duration_ms: graphDurationMs === null ? null : Number(graphDurationMs.toFixed(2)),
      tokens_returned: tokensReturned,
      raw_equivalent_tokens: rawTokens,
      token_savings_percent: Math.max(0, tokenSavingsPercent),
      ram_used_mb: ramUsedMb,
    };

    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO telemetry (timestamp, tool_name, duration_ms, db_duration_ms, graph_duration_ms,
             tokens_returned, raw_equivalent_tokens, token_savings_percent, ram_used_mb)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(rec.timestamp, rec.tool_name, rec.duration_ms, rec.db_duration_ms, rec.graph_duration_ms,
          rec.tokens_returned, rec.raw_equivalent_tokens, rec.token_savings_percent, rec.ram_used_mb);
    } else {
      this.records.push(rec);
      if (this.records.length > this.maxRecords) this.records.shift();
    }

    const parts = [rec.db_duration_ms !== null && `db: ${rec.db_duration_ms}ms`, rec.graph_duration_ms !== null && `graph: ${rec.graph_duration_ms}ms`].filter(Boolean).join(", ");
    // The agent pays for every token it receives and never needs this: stats live in the DB. Opt in for debugging.
    const footer = process.env.KB_TELEMETRY_FOOTER !== "1" ? "" : `\n\n<!-- telemetry: latency=${rec.duration_ms}ms${parts ? ` (${parts})` : ""} | tokens_returned=${rec.tokens_returned} | raw_equivalent=${rec.raw_equivalent_tokens} | saved=${rec.token_savings_percent}% | ram=${rec.ram_used_mb}MB -->`;

    return { footer, record: rec };
  }

  public getStats(nodeCount: number = 0, edgeCount: number = 0): PerformanceStats {
    const records = this.load();
    if (records.length === 0) {
      const mem = process.memoryUsage();
      return {
        total_queries: 0,
        avg_latency_ms: 0,
        p50_latency_ms: 0,
        p95_latency_ms: 0,
        p99_latency_ms: 0,
        total_tokens_returned: 0,
        total_raw_equivalent_tokens: 0,
        overall_savings_percent: 0,
        current_ram_mb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
        node_count: nodeCount,
        edge_count: edgeCount,
      };
    }

    const WRITE_TOOLS = new Set([
      "kb_batch_ingest_directory",
      "kb_ingest_file",
      "kb_sync",
      "kb_resolve_library",
    ]);
    const queryRecords = records.filter((r) => !WRITE_TOOLS.has(r.tool_name));
    const latRecords = queryRecords.length > 0 ? queryRecords : records;

    const latencies = latRecords.map((r) => r.duration_ms).sort((a, b) => a - b);
    const totalDuration = latencies.reduce((acc, v) => acc + v, 0);
    const totalReturned = records.reduce((acc, r) => acc + r.tokens_returned, 0);
    const totalRaw = records.reduce((acc, r) => acc + r.raw_equivalent_tokens, 0);

    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

    const overallSavings =
      totalRaw > 0 ? Number((((totalRaw - totalReturned) / totalRaw) * 100).toFixed(1)) : 0;

    const mem = process.memoryUsage();

    return {
      total_queries: latRecords.length,
      avg_latency_ms: Number((totalDuration / latRecords.length).toFixed(2)),
      p50_latency_ms: Number(p50.toFixed(2)),
      p95_latency_ms: Number(p95.toFixed(2)),
      p99_latency_ms: Number(p99.toFixed(2)),
      total_tokens_returned: totalReturned,
      total_raw_equivalent_tokens: totalRaw,
      overall_savings_percent: Math.max(0, overallSavings),
      current_ram_mb: records[0]?.ram_used_mb ?? Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
      node_count: nodeCount,
      edge_count: edgeCount,
    };
  }

  public reset(): void {
    this.records = [];
    this.db?.exec("DELETE FROM telemetry");
  }
}

export const telemetry = new TelemetryEngine();
