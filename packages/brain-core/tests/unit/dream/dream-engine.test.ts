import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { DreamEngine, runDreamMigration } from '../../../src/dream/dream-engine.js';
import { ResearchJournal } from '../../../src/research/journal.js';

// ── Setup ───────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create minimal schema for testing
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      importance REAL NOT NULL DEFAULT 5,
      active INTEGER NOT NULL DEFAULT 1,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS synapses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      synapse_type TEXT NOT NULL DEFAULT 'co_occurs',
      weight REAL NOT NULL DEFAULT 0.5,
      last_activated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ── Tests ───────────────────────────────────────────────

describe('DreamEngine', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Migration ──────────────────────────────────────────

  describe('runDreamMigration', () => {
    it('should create dream_history and dream_state tables', () => {
      runDreamMigration(db);

      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dream%'`).all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('dream_history');
      expect(tableNames).toContain('dream_state');
    });

    it('should initialize dream_state with id=1', () => {
      runDreamMigration(db);

      const state = db.prepare(`SELECT * FROM dream_state WHERE id = 1`).get() as Record<string, unknown>;
      expect(state).toBeDefined();
      expect(state.total_cycles).toBe(0);
    });

    it('should be idempotent', () => {
      runDreamMigration(db);
      runDreamMigration(db);

      const count = (db.prepare(`SELECT COUNT(*) as c FROM dream_state`).get() as { c: number }).c;
      expect(count).toBe(1);
    });
  });

  // ── Constructor ────────────────────────────────────────

  describe('constructor', () => {
    it('should create engine with default config', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      const status = engine.getStatus();
      expect(status.running).toBe(false);
      expect(status.totalCycles).toBe(0);
      expect(status.lastDreamAt).toBeNull();
    });

    it('should accept custom config', () => {
      const engine = new DreamEngine(db, {
        brainName: 'test',
        replayBatchSize: 10,
        dreamPruneThreshold: 0.2,
      });
      expect(engine).toBeDefined();
    });
  });

  // ── start/stop lifecycle ───────────────────────────────

  describe('start/stop', () => {
    it('should start and stop the timer', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      engine.start();
      expect(engine.getStatus().running).toBe(true);
      engine.stop();
      expect(engine.getStatus().running).toBe(false);
    });

    it('should not start twice', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      engine.start();
      engine.start();
      expect(engine.getStatus().running).toBe(true);
      engine.stop();
    });

    it('should auto-consolidate when idle', () => {
      const engine = new DreamEngine(db, {
        brainName: 'test',
        intervalMs: 1000,
        idleThresholdMs: 500,
      });

      engine.start();

      // Advance time past idle threshold + interval
      vi.advanceTimersByTime(1500);

      const status = engine.getStatus();
      expect(status.totalCycles).toBe(1);

      engine.stop();
    });

    it('should skip dream when brain is active', () => {
      const engine = new DreamEngine(db, {
        brainName: 'test',
        intervalMs: 1000,
        idleThresholdMs: 500,
      });

      engine.start();

      // Keep recording activity
      vi.advanceTimersByTime(400);
      engine.recordActivity();
      vi.advanceTimersByTime(400);
      engine.recordActivity();
      vi.advanceTimersByTime(300);

      const status = engine.getStatus();
      expect(status.totalCycles).toBe(0);

      engine.stop();
    });
  });

  // ── consolidate ────────────────────────────────────────

  describe('consolidate', () => {
    it('should run consolidation on empty DB without errors', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      const report = engine.consolidate('manual');

      expect(report.trigger).toBe('manual');
      expect(report.replay.memoriesReplayed).toBe(0);
      expect(report.pruning.synapsesPruned).toBe(0);
      expect(report.compression.memoriesConsolidated).toBe(0);
      expect(report.decay.memoriesDecayed).toBe(0);
      expect(report.cycleId).toContain('dream-test-');
    });

    it('should consolidate with data', () => {
      // Add some memories and synapses
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('test memory', 10);
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('memory', '1', 'error', '1', 0.05);

      const engine = new DreamEngine(db, { brainName: 'test' });
      const report = engine.consolidate('manual');

      expect(report.replay.memoriesReplayed).toBe(1);
      expect(report.pruning.synapsesPruned).toBe(1); // 0.05 < 0.15 threshold
    });

    it('should persist cycle to dream_history', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      engine.consolidate('manual');

      const history = engine.getHistory();
      expect(history.length).toBe(1);
      expect(history[0]!.trigger).toBe('manual');
    });

    it('should update dream_state totals', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      engine.consolidate('manual');
      engine.consolidate('manual');

      const status = engine.getStatus();
      expect(status.totalCycles).toBe(2);
    });
  });

  // ── getStatus / getHistory ─────────────────────────────

  describe('getStatus', () => {
    it('should return initial status', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      const status = engine.getStatus();
      expect(status.running).toBe(false);
      expect(status.totalCycles).toBe(0);
      expect(status.lastDreamAt).toBeNull();
      expect(status.totals.memoriesConsolidated).toBe(0);
      expect(status.totals.synapsesPruned).toBe(0);
      expect(status.totals.memoriesArchived).toBe(0);
    });

    it('should reflect running state after start', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      engine.start();
      expect(engine.getStatus().running).toBe(true);
      engine.stop();
    });
  });

  describe('getHistory', () => {
    it('should return empty array initially', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      expect(engine.getHistory()).toEqual([]);
    });

    it('should respect limit', () => {
      const engine = new DreamEngine(db, { brainName: 'test' });
      for (let i = 0; i < 5; i++) {
        engine.consolidate('manual');
      }
      const history = engine.getHistory(2);
      expect(history.length).toBe(2);
    });
  });

  // ── Journal Integration ────────────────────────────────

  describe('journal integration', () => {
    it('should write journal entry during consolidation', () => {
      const journal = new ResearchJournal(db, { brainName: 'test' });
      const engine = new DreamEngine(db, { brainName: 'test' });
      engine.setJournal(journal);

      const report = engine.consolidate('manual');
      expect(report.journalEntryId).not.toBeNull();

      // Verify the journal entry exists
      const entries = journal.getEntries('reflection', 10);
      const dreamEntry = entries.find(e => e.title.includes('Dream #'));
      expect(dreamEntry).toBeDefined();
      expect(dreamEntry!.tags).toContain('dream');
    });
  });

  // ── Error Handling ─────────────────────────────────────

  describe('error handling', () => {
    it('should handle missing memories table gracefully', () => {
      const freshDb = new Database(':memory:');
      runDreamMigration(freshDb);
      // Don't create memories/synapses tables

      const engine = new DreamEngine(freshDb, { brainName: 'test' });
      const report = engine.consolidate('manual');

      // Should complete without throwing
      expect(report.replay.memoriesReplayed).toBe(0);
      expect(report.pruning.synapsesPruned).toBe(0);
    });

    it('should handle timer callback errors gracefully', () => {
      const engine = new DreamEngine(db, {
        brainName: 'test',
        intervalMs: 1000,
        idleThresholdMs: 100,
      });

      engine.start();

      // Close DB to cause errors
      db.close();

      // Should not throw
      expect(() => vi.advanceTimersByTime(1500)).not.toThrow();

      engine.stop();
    });
  });

  // ── recordActivity ─────────────────────────────────────

  describe('recordActivity', () => {
    it('should prevent dreaming when activity is recorded', () => {
      const engine = new DreamEngine(db, {
        brainName: 'test',
        intervalMs: 1000,
        idleThresholdMs: 2000,
      });

      engine.start();
      engine.recordActivity();

      vi.advanceTimersByTime(1500);

      const status = engine.getStatus();
      expect(status.totalCycles).toBe(0);

      engine.stop();
    });
  });
});
