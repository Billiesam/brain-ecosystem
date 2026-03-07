/**
 * Trace Collector — Observability für das Brain Ecosystem
 *
 * Inspiriert von OpenTelemetry / LangSmith Tracing.
 * Erfasst Spans (Arbeitseinheiten) in hierarchischen Traces,
 * speichert sie in SQLite und berechnet Latenz-Statistiken.
 *
 * Usage:
 * ```typescript
 * const traceId = collector.startTrace('research-cycle');
 * const spanId = collector.startSpan(traceId, 'llm-call', { template: 'explain' });
 * // ... do work ...
 * collector.endSpan(spanId, { tokens: 150, cost: 0.001 });
 * collector.endTrace(traceId);
 * ```
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface Trace {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  spanCount: number;
  totalTokens: number;
  totalCost: number;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface Span {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  status: 'running' | 'completed' | 'error';
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  tokens: number;
  cost: number;
  metadata: Record<string, unknown>;
  error?: string;
}

export interface TraceTree {
  trace: Trace;
  spans: Span[];
}

export interface TraceStats {
  totalTraces: number;
  totalSpans: number;
  totalTokens: number;
  totalCost: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p99DurationMs: number;
  tracesByName: Record<string, number>;
  activeTraces: number;
}

export interface TraceListOptions {
  limit?: number;
  offset?: number;
  name?: string;
  status?: 'running' | 'completed' | 'error';
  since?: number;
}

export interface TraceCollectorStatus {
  totalTraces: number;
  activeTraces: number;
  totalSpans: number;
  totalTokens: number;
  totalCost: number;
}

// ── Migration ───────────────────────────────────────────

export function runTraceMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_traces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      span_count INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_traces_name ON workflow_traces(name);
    CREATE INDEX IF NOT EXISTS idx_traces_status ON workflow_traces(status);
    CREATE INDEX IF NOT EXISTS idx_traces_started ON workflow_traces(started_at);

    CREATE TABLE IF NOT EXISTS trace_spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_ms INTEGER,
      tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      error TEXT,
      FOREIGN KEY (trace_id) REFERENCES workflow_traces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_spans_trace ON trace_spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_spans_parent ON trace_spans(parent_span_id);
  `);
}

// ── Collector ───────────────────────────────────────────

export class TraceCollector {
  private readonly log = getLogger();
  private stmtInsertTrace: Database.Statement;
  private stmtInsertSpan: Database.Statement;
  private stmtEndTrace: Database.Statement;
  private stmtEndSpan: Database.Statement;
  private stmtUpdateTraceStats: Database.Statement;

  constructor(private db: Database.Database) {
    runTraceMigration(db);

    this.stmtInsertTrace = db.prepare(
      `INSERT INTO workflow_traces (id, name, status, started_at, metadata)
       VALUES (?, ?, 'running', ?, ?)`,
    );
    this.stmtInsertSpan = db.prepare(
      `INSERT INTO trace_spans (id, trace_id, parent_span_id, name, status, started_at, metadata)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    );
    this.stmtEndTrace = db.prepare(
      `UPDATE workflow_traces SET status = ?, ended_at = ?, duration_ms = ?, error = ?
       WHERE id = ?`,
    );
    this.stmtEndSpan = db.prepare(
      `UPDATE trace_spans SET status = ?, ended_at = ?, duration_ms = ?, tokens = ?, cost = ?, error = ?
       WHERE id = ?`,
    );
    this.stmtUpdateTraceStats = db.prepare(
      `UPDATE workflow_traces SET
         span_count = (SELECT COUNT(*) FROM trace_spans WHERE trace_id = ?),
         total_tokens = (SELECT COALESCE(SUM(tokens), 0) FROM trace_spans WHERE trace_id = ?),
         total_cost = (SELECT COALESCE(SUM(cost), 0) FROM trace_spans WHERE trace_id = ?)
       WHERE id = ?`,
    );

    this.log.debug('[TraceCollector] Initialized');
  }

  // ── Trace Lifecycle ─────────────────────────────────

  /** Start a new trace. Returns trace ID. */
  startTrace(name: string, metadata: Record<string, unknown> = {}): string {
    const id = randomUUID();
    const now = Date.now();
    try {
      this.stmtInsertTrace.run(id, name, now, JSON.stringify(metadata));
    } catch (e) {
      this.log.warn(`[TraceCollector] Failed to start trace: ${(e as Error).message}`);
    }
    return id;
  }

  /** End a trace (complete or error). */
  endTrace(traceId: string, error?: string): void {
    const now = Date.now();
    try {
      const trace = this.db.prepare('SELECT started_at FROM workflow_traces WHERE id = ?').get(traceId) as { started_at: number } | undefined;
      const duration = trace ? now - trace.started_at : 0;
      const status = error ? 'error' : 'completed';

      // Update aggregate stats from spans
      this.stmtUpdateTraceStats.run(traceId, traceId, traceId, traceId);
      this.stmtEndTrace.run(status, now, duration, error ?? null, traceId);
    } catch (e) {
      this.log.warn(`[TraceCollector] Failed to end trace: ${(e as Error).message}`);
    }
  }

  // ── Span Lifecycle ──────────────────────────────────

  /** Start a span within a trace. Returns span ID. */
  startSpan(traceId: string, name: string, options?: {
    parentSpanId?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    const now = Date.now();
    try {
      this.stmtInsertSpan.run(
        id, traceId, options?.parentSpanId ?? null, name, now,
        JSON.stringify(options?.metadata ?? {}),
      );
    } catch (e) {
      this.log.warn(`[TraceCollector] Failed to start span: ${(e as Error).message}`);
    }
    return id;
  }

  /** End a span with optional results. */
  endSpan(spanId: string, result?: {
    tokens?: number;
    cost?: number;
    error?: string;
  }): void {
    const now = Date.now();
    try {
      const span = this.db.prepare('SELECT started_at FROM trace_spans WHERE id = ?').get(spanId) as { started_at: number } | undefined;
      const duration = span ? now - span.started_at : 0;
      const status = result?.error ? 'error' : 'completed';

      this.stmtEndSpan.run(
        status, now, duration, result?.tokens ?? 0, result?.cost ?? 0,
        result?.error ?? null, spanId,
      );
    } catch (e) {
      this.log.warn(`[TraceCollector] Failed to end span: ${(e as Error).message}`);
    }
  }

  // ── Queries ─────────────────────────────────────────

  /** Get a single trace with all its spans. */
  getTrace(traceId: string): TraceTree | null {
    try {
      const row = this.db.prepare('SELECT * FROM workflow_traces WHERE id = ?').get(traceId) as Record<string, unknown> | undefined;
      if (!row) return null;

      const spans = this.db.prepare(
        'SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at',
      ).all(traceId) as Array<Record<string, unknown>>;

      return {
        trace: this.mapTrace(row),
        spans: spans.map(s => this.mapSpan(s)),
      };
    } catch {
      return null;
    }
  }

  /** List traces with optional filters. */
  listTraces(options: TraceListOptions = {}): Trace[] {
    const { limit = 50, offset = 0, name, status, since } = options;
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (name) { conditions.push('name = ?'); params.push(name); }
      if (status) { conditions.push('status = ?'); params.push(status); }
      if (since) { conditions.push('started_at >= ?'); params.push(since); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT * FROM workflow_traces ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map(r => this.mapTrace(r));
    } catch {
      return [];
    }
  }

  /** Get aggregate statistics. */
  getStats(): TraceStats {
    try {
      const totals = this.db.prepare(`
        SELECT
          COUNT(*) as total_traces,
          COALESCE(SUM(span_count), 0) as total_spans,
          COALESCE(SUM(total_tokens), 0) as total_tokens,
          COALESCE(SUM(total_cost), 0) as total_cost,
          COALESCE(AVG(duration_ms), 0) as avg_duration
        FROM workflow_traces
        WHERE status != 'running'
      `).get() as Record<string, number>;

      const active = this.db.prepare(
        "SELECT COUNT(*) as count FROM workflow_traces WHERE status = 'running'",
      ).get() as { count: number };

      // P50 / P99 from completed traces
      const durations = this.db.prepare(
        "SELECT duration_ms FROM workflow_traces WHERE status = 'completed' AND duration_ms IS NOT NULL ORDER BY duration_ms",
      ).all() as Array<{ duration_ms: number }>;

      const p50 = durations.length > 0
        ? durations[Math.floor(durations.length * 0.5)]?.duration_ms ?? 0
        : 0;
      const p99 = durations.length > 0
        ? durations[Math.floor(durations.length * 0.99)]?.duration_ms ?? 0
        : 0;

      // Traces by name
      const byName = this.db.prepare(
        'SELECT name, COUNT(*) as count FROM workflow_traces GROUP BY name',
      ).all() as Array<{ name: string; count: number }>;

      const tracesByName: Record<string, number> = {};
      for (const row of byName) {
        tracesByName[row.name] = row.count;
      }

      return {
        totalTraces: totals.total_traces ?? 0,
        totalSpans: totals.total_spans ?? 0,
        totalTokens: totals.total_tokens ?? 0,
        totalCost: totals.total_cost ?? 0,
        avgDurationMs: Math.round(totals.avg_duration ?? 0),
        p50DurationMs: p50,
        p99DurationMs: p99,
        tracesByName,
        activeTraces: active.count,
      };
    } catch {
      return {
        totalTraces: 0, totalSpans: 0, totalTokens: 0, totalCost: 0,
        avgDurationMs: 0, p50DurationMs: 0, p99DurationMs: 0,
        tracesByName: {}, activeTraces: 0,
      };
    }
  }

  /** Get collector status (lightweight). */
  getStatus(): TraceCollectorStatus {
    try {
      const row = this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as active,
          COALESCE(SUM(span_count), 0) as spans,
          COALESCE(SUM(total_tokens), 0) as tokens,
          COALESCE(SUM(total_cost), 0) as cost
        FROM workflow_traces
      `).get() as Record<string, number>;

      return {
        totalTraces: row.total ?? 0,
        activeTraces: row.active ?? 0,
        totalSpans: row.spans ?? 0,
        totalTokens: row.tokens ?? 0,
        totalCost: row.cost ?? 0,
      };
    } catch {
      return { totalTraces: 0, activeTraces: 0, totalSpans: 0, totalTokens: 0, totalCost: 0 };
    }
  }

  /** Delete traces older than maxAgeDays. Returns number pruned. */
  prune(maxAgeDays = 30): number {
    try {
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      // Delete spans first (FK constraint)
      this.db.prepare(
        'DELETE FROM trace_spans WHERE trace_id IN (SELECT id FROM workflow_traces WHERE started_at < ? AND status != ?)',
      ).run(cutoff, 'running');
      const result = this.db.prepare(
        'DELETE FROM workflow_traces WHERE started_at < ? AND status != ?',
      ).run(cutoff, 'running');
      return result.changes;
    } catch {
      return 0;
    }
  }

  // ── Private ─────────────────────────────────────────

  private mapTrace(row: Record<string, unknown>): Trace {
    return {
      id: row.id as string,
      name: row.name as string,
      status: row.status as Trace['status'],
      startedAt: row.started_at as number,
      endedAt: row.ended_at as number | null,
      durationMs: row.duration_ms as number | null,
      spanCount: row.span_count as number,
      totalTokens: row.total_tokens as number,
      totalCost: row.total_cost as number,
      metadata: JSON.parse((row.metadata as string) || '{}'),
      error: row.error as string | undefined,
    };
  }

  private mapSpan(row: Record<string, unknown>): Span {
    return {
      id: row.id as string,
      traceId: row.trace_id as string,
      parentSpanId: row.parent_span_id as string | null,
      name: row.name as string,
      status: row.status as Span['status'],
      startedAt: row.started_at as number,
      endedAt: row.ended_at as number | null,
      durationMs: row.duration_ms as number | null,
      tokens: row.tokens as number,
      cost: row.cost as number,
      metadata: JSON.parse((row.metadata as string) || '{}'),
      error: row.error as string | undefined,
    };
  }
}
