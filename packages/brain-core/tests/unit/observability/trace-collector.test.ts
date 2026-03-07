import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TraceCollector } from '../../../src/observability/trace-collector.js';

describe('TraceCollector', () => {
  let db: Database.Database;
  let collector: TraceCollector;

  beforeEach(() => {
    db = new Database(':memory:');
    collector = new TraceCollector(db);
  });

  // ── Migration ───────────────────────────────────────

  it('creates tables on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow_traces','trace_spans') ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map(t => t.name)).toEqual(['trace_spans', 'workflow_traces']);
  });

  // ── Trace Lifecycle ────────────────────────────────

  it('starts and ends a trace', () => {
    const traceId = collector.startTrace('test-workflow');
    expect(traceId).toBeTruthy();

    collector.endTrace(traceId);

    const tree = collector.getTrace(traceId);
    expect(tree).not.toBeNull();
    expect(tree!.trace.name).toBe('test-workflow');
    expect(tree!.trace.status).toBe('completed');
    expect(tree!.trace.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('ends trace with error status', () => {
    const traceId = collector.startTrace('failing');
    collector.endTrace(traceId, 'Something went wrong');

    const tree = collector.getTrace(traceId);
    expect(tree!.trace.status).toBe('error');
    expect(tree!.trace.error).toBe('Something went wrong');
  });

  it('stores metadata on trace', () => {
    const traceId = collector.startTrace('meta-test', { source: 'brain', version: 2 });
    collector.endTrace(traceId);

    const tree = collector.getTrace(traceId);
    expect(tree!.trace.metadata).toEqual({ source: 'brain', version: 2 });
  });

  // ── Span Lifecycle ──────────────────────────────────

  it('creates spans within a trace', () => {
    const traceId = collector.startTrace('with-spans');
    const spanId = collector.startSpan(traceId, 'llm-call');
    collector.endSpan(spanId, { tokens: 150, cost: 0.005 });
    collector.endTrace(traceId);

    const tree = collector.getTrace(traceId);
    expect(tree!.spans).toHaveLength(1);
    expect(tree!.spans[0].name).toBe('llm-call');
    expect(tree!.spans[0].tokens).toBe(150);
    expect(tree!.spans[0].cost).toBe(0.005);
    expect(tree!.spans[0].status).toBe('completed');
    expect(tree!.trace.spanCount).toBe(1);
    expect(tree!.trace.totalTokens).toBe(150);
  });

  it('supports nested spans (parent-child)', () => {
    const traceId = collector.startTrace('nested');
    const parentSpan = collector.startSpan(traceId, 'research-step');
    const childSpan = collector.startSpan(traceId, 'llm-call', { parentSpanId: parentSpan });
    collector.endSpan(childSpan, { tokens: 100 });
    collector.endSpan(parentSpan);
    collector.endTrace(traceId);

    const tree = collector.getTrace(traceId);
    expect(tree!.spans).toHaveLength(2);
    expect(tree!.spans[1].parentSpanId).toBe(parentSpan);
  });

  it('marks span as error', () => {
    const traceId = collector.startTrace('span-error');
    const spanId = collector.startSpan(traceId, 'failing-call');
    collector.endSpan(spanId, { error: 'API timeout' });
    collector.endTrace(traceId);

    const tree = collector.getTrace(traceId);
    expect(tree!.spans[0].status).toBe('error');
    expect(tree!.spans[0].error).toBe('API timeout');
  });

  // ── Queries ─────────────────────────────────────────

  it('lists traces', () => {
    collector.startTrace('a');
    collector.startTrace('b');
    collector.startTrace('c');

    const list = collector.listTraces();
    expect(list).toHaveLength(3);
  });

  it('filters traces by name', () => {
    const id1 = collector.startTrace('research');
    const id2 = collector.startTrace('mission');
    const id3 = collector.startTrace('research');
    collector.endTrace(id1);
    collector.endTrace(id2);
    collector.endTrace(id3);

    const list = collector.listTraces({ name: 'research' });
    expect(list).toHaveLength(2);
  });

  it('filters traces by status', () => {
    const id1 = collector.startTrace('done');
    collector.endTrace(id1);
    collector.startTrace('still-running');

    const completed = collector.listTraces({ status: 'completed' });
    expect(completed).toHaveLength(1);

    const running = collector.listTraces({ status: 'running' });
    expect(running).toHaveLength(1);
  });

  it('paginates with limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      collector.startTrace(`trace-${i}`);
    }
    const page = collector.listTraces({ limit: 3, offset: 0 });
    expect(page).toHaveLength(3);

    const page2 = collector.listTraces({ limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
  });

  it('returns null for non-existent trace', () => {
    expect(collector.getTrace('does-not-exist')).toBeNull();
  });

  // ── Stats ───────────────────────────────────────────

  it('calculates aggregate statistics', () => {
    const id1 = collector.startTrace('cycle');
    const s1 = collector.startSpan(id1, 'llm');
    collector.endSpan(s1, { tokens: 200, cost: 0.01 });
    collector.endTrace(id1);

    const id2 = collector.startTrace('cycle');
    const s2 = collector.startSpan(id2, 'llm');
    collector.endSpan(s2, { tokens: 300, cost: 0.02 });
    collector.endTrace(id2);

    const stats = collector.getStats();
    expect(stats.totalTraces).toBe(2);
    expect(stats.totalSpans).toBe(2);
    expect(stats.totalTokens).toBe(500);
    expect(stats.totalCost).toBeCloseTo(0.03, 4);
    expect(stats.tracesByName['cycle']).toBe(2);
    expect(stats.activeTraces).toBe(0);
    expect(stats.p50DurationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts active traces', () => {
    collector.startTrace('running-1');
    collector.startTrace('running-2');
    const done = collector.startTrace('done');
    collector.endTrace(done);

    const stats = collector.getStats();
    expect(stats.activeTraces).toBe(2);
  });

  // ── Status ──────────────────────────────────────────

  it('returns lightweight status', () => {
    const id = collector.startTrace('test');
    const span = collector.startSpan(id, 's');
    collector.endSpan(span, { tokens: 50, cost: 0.001 });
    collector.endTrace(id);

    const status = collector.getStatus();
    expect(status.totalTraces).toBe(1);
    expect(status.activeTraces).toBe(0);
    expect(status.totalSpans).toBe(1);
    expect(status.totalTokens).toBe(50);
  });

  // ── Prune ───────────────────────────────────────────

  it('prunes old traces', () => {
    // Insert a trace with old timestamp
    const id = collector.startTrace('old');
    collector.endTrace(id);
    // Manually backdate it
    db.prepare('UPDATE workflow_traces SET started_at = ? WHERE id = ?').run(
      Date.now() - 100 * 86_400_000, // 100 days ago
      id,
    );

    const freshId = collector.startTrace('fresh');
    collector.endTrace(freshId);

    const pruned = collector.prune(30);
    expect(pruned).toBe(1);

    const remaining = collector.listTraces();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('fresh');
  });

  it('does not prune running traces', () => {
    const id = collector.startTrace('running-old');
    // Backdate but keep running
    db.prepare('UPDATE workflow_traces SET started_at = ? WHERE id = ?').run(
      Date.now() - 100 * 86_400_000,
      id,
    );

    const pruned = collector.prune(30);
    expect(pruned).toBe(0);
  });
});
