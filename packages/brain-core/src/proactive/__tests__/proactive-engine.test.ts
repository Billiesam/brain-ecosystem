import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { ProactiveEngine, runProactiveMigration } from '../proactive-engine.js';

function createDb(): Database.Database {
  return new Database(':memory:');
}

describe('ProactiveEngine', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates a suggestion and retrieves it', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    const ok = engine.createSuggestion('info', 'Test Suggestion', 'A description', 'Do something', 0.7);
    expect(ok).toBe(true);

    const suggestions = engine.getSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.title).toBe('Test Suggestion');
    expect(suggestions[0]!.priority).toBe(0.7);
    expect(suggestions[0]!.type).toBe('info');
  });

  it('returns suggestions sorted by priority descending', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    engine.createSuggestion('low', 'Low Priority', undefined, undefined, 0.2);
    engine.createSuggestion('high', 'High Priority', undefined, undefined, 0.9);
    engine.createSuggestion('mid', 'Mid Priority', undefined, undefined, 0.5);

    const suggestions = engine.getSuggestions();
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]!.title).toBe('High Priority');
    expect(suggestions[1]!.title).toBe('Mid Priority');
    expect(suggestions[2]!.title).toBe('Low Priority');
  });

  it('dismisses a suggestion', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    engine.createSuggestion('info', 'To Dismiss', 'desc');

    const before = engine.getSuggestions();
    expect(before).toHaveLength(1);

    engine.dismiss(before[0]!.id!);

    const after = engine.getSuggestions();
    expect(after).toHaveLength(0);
  });

  it('respects rate limiting (max per hour)', () => {
    const engine = new ProactiveEngine(db, {
      brainName: 'test',
      maxSuggestionsPerHour: 2,
    });

    expect(engine.createSuggestion('a', 'First')).toBe(true);
    expect(engine.createSuggestion('b', 'Second')).toBe(true);
    expect(engine.createSuggestion('c', 'Third')).toBe(false); // Rate limited
  });

  it('checks recurring errors trigger', () => {
    const engine = new ProactiveEngine(db, {
      brainName: 'test',
      recurringThreshold: 3,
    });

    // Create error_memory table and populate
    db.exec(`
      CREATE TABLE error_memory (
        id INTEGER PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        message TEXT NOT NULL
      )
    `);
    // Insert 3 errors with same fingerprint
    const insert = db.prepare('INSERT INTO error_memory (fingerprint, message) VALUES (?, ?)');
    insert.run('null-ref-001', 'Cannot read property of null');
    insert.run('null-ref-001', 'Cannot read property of null');
    insert.run('null-ref-001', 'Cannot read property of null');

    const created = engine.analyze({ db });
    expect(created).toBeGreaterThanOrEqual(1);

    const suggestions = engine.getSuggestions();
    const errorSuggestion = suggestions.find(s => s.type === 'recurring_error');
    expect(errorSuggestion).toBeDefined();
    expect(errorSuggestion!.title).toContain('null-ref-001');
  });

  it('checks stale knowledge trigger', () => {
    const engine = new ProactiveEngine(db, {
      brainName: 'test',
      staleDays: 30,
    });

    // Create insights table with old high-confidence insight
    db.exec(`
      CREATE TABLE insights (
        id INTEGER PRIMARY KEY,
        topic TEXT NOT NULL,
        created_at TEXT NOT NULL,
        confidence REAL NOT NULL
      )
    `);
    db.prepare(`
      INSERT INTO insights (topic, created_at, confidence)
      VALUES (?, datetime('now', '-60 days'), 0.9)
    `).run('old-topic');

    const created = engine.analyze({ db });
    expect(created).toBeGreaterThanOrEqual(1);

    const suggestions = engine.getSuggestions();
    const staleSuggestion = suggestions.find(s => s.type === 'stale_knowledge');
    expect(staleSuggestion).toBeDefined();
    expect(staleSuggestion!.title).toContain('old-topic');
  });

  it('getStatus returns correct counts', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    engine.createSuggestion('a', 'Active 1');
    engine.createSuggestion('b', 'Active 2');

    const suggestions = engine.getSuggestions();
    engine.dismiss(suggestions[0]!.id!);

    const status = engine.getStatus();
    expect(status.totalSuggestions).toBe(2);
    expect(status.activeSuggestions).toBe(1);
    expect(status.dismissedCount).toBe(1);
    expect(status.lastAnalysis).toBeNull(); // No analyze() called
  });

  it('migration is idempotent', () => {
    const engine1 = new ProactiveEngine(db, { brainName: 'test' });
    engine1.createSuggestion('test', 'Survives Migration');

    // Run migration again
    runProactiveMigration(db);
    const engine2 = new ProactiveEngine(db, { brainName: 'test' });

    const suggestions = engine2.getSuggestions();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.title).toBe('Survives Migration');
  });

  it('returns zero suggestions from empty analysis', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    // No error_memory, insights, or tool_usage tables exist
    const created = engine.analyze({ db });
    expect(created).toBe(0);
  });

  it('dismissed suggestions not returned by default', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    engine.createSuggestion('a', 'Visible');
    engine.createSuggestion('b', 'Hidden');

    const all = engine.getSuggestions();
    engine.dismiss(all.find(s => s.title === 'Hidden')!.id!);

    const active = engine.getSuggestions();
    expect(active).toHaveLength(1);
    expect(active[0]!.title).toBe('Visible');

    const withDismissed = engine.getSuggestions(20, true);
    expect(withDismissed).toHaveLength(2);
  });

  it('deduplicates suggestions with same title', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });
    expect(engine.createSuggestion('a', 'Same Title')).toBe(true);
    expect(engine.createSuggestion('b', 'Same Title')).toBe(false); // Duplicate

    const suggestions = engine.getSuggestions();
    expect(suggestions).toHaveLength(1);
  });

  it('checks quick wins trigger (tool_usage table)', () => {
    const engine = new ProactiveEngine(db, { brainName: 'test' });

    // Create tool_usage table
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_usage (
        id INTEGER PRIMARY KEY,
        tool_name TEXT NOT NULL,
        context TEXT,
        duration_ms INTEGER,
        outcome TEXT DEFAULT 'success',
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Insert a tool with high success rate but low usage
    const insert = db.prepare('INSERT INTO tool_usage (tool_name, outcome) VALUES (?, ?)');
    insert.run('rare-but-good', 'success');
    insert.run('rare-but-good', 'success');
    insert.run('rare-but-good', 'success');

    const created = engine.analyze({ db });
    expect(created).toBeGreaterThanOrEqual(1);

    const suggestions = engine.getSuggestions();
    const quickWin = suggestions.find(s => s.type === 'quick_win');
    expect(quickWin).toBeDefined();
    expect(quickWin!.title).toContain('rare-but-good');
  });
});
