import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { ToolTracker, runToolTrackerMigration } from '../tool-tracker.js';
import { ToolPatternAnalyzer } from '../tool-patterns.js';

function createDb(): Database.Database {
  return new Database(':memory:');
}

describe('ToolTracker', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('records usage and retrieves it', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    tracker.recordUsage('mcp.search', 'searching docs', 150, 'success');

    const stats = tracker.getToolStats('mcp.search');
    expect(stats).toEqual(expect.objectContaining({
      tool: 'mcp.search',
      totalUses: 1,
      successRate: 1,
    }));
  });

  it('returns stats for a single tool', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    tracker.recordUsage('mcp.search', 'ctx', 100, 'success');
    tracker.recordUsage('mcp.search', 'ctx', 200, 'failure');

    const stats = tracker.getToolStats('mcp.search');
    expect(stats).toEqual(expect.objectContaining({
      tool: 'mcp.search',
      totalUses: 2,
      successRate: 0.5,
      avgDuration: 150,
    }));
  });

  it('returns stats for all tools', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    tracker.recordUsage('tool-a', 'ctx', 100, 'success');
    tracker.recordUsage('tool-b', 'ctx', 200, 'success');
    tracker.recordUsage('tool-a', 'ctx', 300, 'success');

    const stats = tracker.getToolStats();
    expect(Array.isArray(stats)).toBe(true);
    expect((stats as Array<unknown>).length).toBe(2);
    // tool-a should be first (more uses)
    expect((stats as Array<{ tool: string }>)[0]!.tool).toBe('tool-a');
  });

  it('recommends tools sorted by success rate * frequency', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    // tool-a: 3 successes in 'debug' context
    tracker.recordUsage('tool-a', 'debug error', 100, 'success');
    tracker.recordUsage('tool-a', 'debug crash', 100, 'success');
    tracker.recordUsage('tool-a', 'debug log', 100, 'success');
    // tool-b: 1 success in 'debug' context
    tracker.recordUsage('tool-b', 'debug issue', 200, 'success');
    // tool-c: no 'debug' context
    tracker.recordUsage('tool-c', 'build project', 50, 'success');

    const recs = tracker.recommend('debug');
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(recs[0]!.tool).toBe('tool-a');
    // tool-c should not appear (no debug context)
    expect(recs.find(r => r.tool === 'tool-c')).toBeUndefined();
  });

  it('records usage with different outcomes', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    tracker.recordUsage('tool-x', 'ctx', 100, 'success');
    tracker.recordUsage('tool-x', 'ctx', 100, 'failure');
    tracker.recordUsage('tool-x', 'ctx', 100, 'partial');

    const stats = tracker.getToolStats('tool-x');
    expect(stats).toEqual(expect.objectContaining({
      totalUses: 3,
    }));
    // 1 success out of 3 = 0.333...
    expect((stats as { successRate: number }).successRate).toBeCloseTo(1 / 3, 5);
  });

  it('returns empty stats for unknown tool', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    const stats = tracker.getToolStats('nonexistent');
    expect(stats).toEqual(expect.objectContaining({
      tool: 'nonexistent',
      totalUses: 0,
      successRate: 0,
    }));
  });

  it('getStatus returns correct counts', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    tracker.recordUsage('tool-a', null, null, 'success');
    tracker.recordUsage('tool-b', null, null, 'failure');
    tracker.recordUsage('tool-a', null, null, 'success');

    const status = tracker.getStatus();
    expect(status.totalTracked).toBe(3);
    expect(status.uniqueTools).toBe(2);
    // 2 successes out of 3
    expect(status.avgSuccessRate).toBeCloseTo(2 / 3, 5);
  });

  it('migration is idempotent', () => {
    const tracker1 = new ToolTracker(db, { brainName: 'test' });
    tracker1.recordUsage('tool-a', 'ctx', 100, 'success');

    // Run migration again — should not throw or lose data
    runToolTrackerMigration(db);
    const tracker2 = new ToolTracker(db, { brainName: 'test' });

    const stats = tracker2.getToolStats('tool-a');
    expect(stats).toEqual(expect.objectContaining({ totalUses: 1 }));
  });

  it('getStatus returns zeros when empty', () => {
    const tracker = new ToolTracker(db, { brainName: 'test' });
    const status = tracker.getStatus();
    expect(status.totalTracked).toBe(0);
    expect(status.uniqueTools).toBe(0);
    expect(status.avgSuccessRate).toBe(0);
  });
});

describe('ToolPatternAnalyzer', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    // ToolTracker migration creates the table
    runToolTrackerMigration(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertUsage(tool: string, createdAt: string): void {
    db.prepare(`
      INSERT INTO tool_usage (tool_name, context, outcome, created_at)
      VALUES (?, 'test', 'success', ?)
    `).run(tool, createdAt);
  }

  it('builds transitions correctly', () => {
    insertUsage('search', '2026-03-06 10:00:00');
    insertUsage('read',   '2026-03-06 10:01:00');
    insertUsage('edit',   '2026-03-06 10:02:00');
    insertUsage('search', '2026-03-06 10:03:00');
    insertUsage('read',   '2026-03-06 10:04:00');

    const analyzer = new ToolPatternAnalyzer(db);
    const transitions = analyzer.getTransitions();

    expect(transitions.get('search')?.get('read')).toBe(2);
    expect(transitions.get('read')?.get('edit')).toBe(1);
    expect(transitions.get('edit')?.get('search')).toBe(1);
  });

  it('predicts next tool based on transitions', () => {
    insertUsage('search', '2026-03-06 10:00:00');
    insertUsage('read',   '2026-03-06 10:01:00');
    insertUsage('search', '2026-03-06 10:02:00');
    insertUsage('read',   '2026-03-06 10:03:00');
    insertUsage('search', '2026-03-06 10:04:00');
    insertUsage('edit',   '2026-03-06 10:05:00');

    const analyzer = new ToolPatternAnalyzer(db);
    const predictions = analyzer.predictNext('search');

    expect(predictions.length).toBeGreaterThanOrEqual(1);
    // 'read' follows 'search' 2 out of 3 times
    expect(predictions[0]!.tool).toBe('read');
    expect(predictions[0]!.probability).toBeCloseTo(2 / 3, 5);
  });

  it('finds frequent pairs within 5-minute windows', () => {
    // All within 5 minutes of each other
    insertUsage('search', '2026-03-06 10:00:00');
    insertUsage('read',   '2026-03-06 10:01:00');
    insertUsage('search', '2026-03-06 10:02:00');
    insertUsage('read',   '2026-03-06 10:03:00');

    const analyzer = new ToolPatternAnalyzer(db);
    const pairs = analyzer.getFrequentPairs();

    expect(pairs.length).toBeGreaterThanOrEqual(1);
    const searchRead = pairs.find(
      p => (p.toolA === 'read' && p.toolB === 'search') ||
           (p.toolA === 'search' && p.toolB === 'read')
    );
    expect(searchRead).toBeDefined();
    expect(searchRead!.count).toBeGreaterThanOrEqual(2);
  });

  it('returns empty predictions for unknown tool', () => {
    const analyzer = new ToolPatternAnalyzer(db);
    const predictions = analyzer.predictNext('nonexistent');
    expect(predictions).toEqual([]);
  });

  it('returns empty sequences when not enough data', () => {
    insertUsage('search', '2026-03-06 10:00:00');

    const analyzer = new ToolPatternAnalyzer(db);
    const sequences = analyzer.getSequences(3);
    expect(sequences).toEqual([]);
  });
});
