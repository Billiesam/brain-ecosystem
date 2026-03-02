import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DreamEngine, runDreamMigration } from '../../../src/dream/dream-engine.js';

describe('DreamEngine — Retrospective Analysis', () => {
  let db: Database.Database;
  let engine: DreamEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    // DreamEngine constructor calls runDreamMigration, which creates dream_history, dream_state, dream_retrospective
    // The DreamConsolidator needs synapses + memories tables for consolidation,
    // but for retrospective-only tests we only need the retrospective table.
    engine = new DreamEngine(db, { brainName: 'test-brain' });
  });

  it('should create dream_retrospective table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'dream_retrospective'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('should store pruned items via recordPrunedItems()', () => {
    const items = [
      { synapseId: 1, weight: 0.1 },
      { synapseId: 2, weight: 0.12 },
      { synapseId: 3, weight: 0.08 },
    ];
    engine.recordPrunedItems('dream-test-1', items);

    const rows = db.prepare('SELECT * FROM dream_retrospective').all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].dream_cycle_id).toBe('dream-test-1');

    const storedItems = JSON.parse(rows[0].pruned_items as string);
    expect(storedItems.length).toBe(3);
    expect(storedItems[0].synapseId).toBe(1);
    expect(storedItems[0].weight).toBe(0.1);
  });

  it('should not insert when items array is empty', () => {
    engine.recordPrunedItems('dream-test-empty', []);

    const rows = db.prepare('SELECT * FROM dream_retrospective').all() as Record<string, unknown>[];
    expect(rows.length).toBe(0);
  });

  it('should return empty array from analyzeRetrospective() on fresh DB', () => {
    const results = engine.analyzeRetrospective(5);
    expect(results).toEqual([]);
  });

  it('should analyze retrospective and return results for recorded items', () => {
    // Record some pruned items
    engine.recordPrunedItems('dream-cycle-1', [
      { synapseId: 10, weight: 0.12 },
      { synapseId: 11, weight: 0.09 },
    ]);
    engine.recordPrunedItems('dream-cycle-2', [
      { synapseId: 20, weight: 0.14 },
    ]);

    const results = engine.analyzeRetrospective(5);
    expect(results.length).toBe(2);

    for (const r of results) {
      expect(r.dreamCycleId).toBeDefined();
      expect(r.prunedItems.length).toBeGreaterThan(0);
      expect(typeof r.reappearedCount).toBe('number');
      expect(typeof r.regretScore).toBe('number');
      expect(r.regretScore).toBeGreaterThanOrEqual(0);
      expect(r.regretScore).toBeLessThanOrEqual(1);
      expect(typeof r.lesson).toBe('string');
    }
  });

  it('should return correct limit from getRetrospective()', () => {
    for (let i = 0; i < 5; i++) {
      engine.recordPrunedItems(`dream-cycle-${i}`, [{ synapseId: i, weight: 0.1 }]);
    }

    const all = engine.getRetrospective(10);
    expect(all.length).toBe(5);

    const limited = engine.getRetrospective(2);
    expect(limited.length).toBe(2);
  });

  it('should compute pruning efficiency', () => {
    // Record items and analyze to populate regret scores
    engine.recordPrunedItems('cycle-1', [
      { synapseId: 1, weight: 0.1 },
      { synapseId: 2, weight: 0.12 },
    ]);

    // Analyze to set regret scores (without synapses table, regretScore = 0)
    engine.analyzeRetrospective(5);

    const efficiency = engine.getPruningEfficiency();
    expect(typeof efficiency.totalPruned).toBe('number');
    expect(typeof efficiency.totalReappeared).toBe('number');
    expect(typeof efficiency.avgRegretScore).toBe('number');
    expect(typeof efficiency.efficiencyRate).toBe('number');
    expect(efficiency.efficiencyRate).toBeLessThanOrEqual(1);
    expect(efficiency.efficiencyRate).toBeGreaterThanOrEqual(0);
  });

  it('should return default efficiency on fresh DB', () => {
    const efficiency = engine.getPruningEfficiency();
    expect(efficiency.totalPruned).toBe(0);
    expect(efficiency.totalReappeared).toBe(0);
    expect(efficiency.avgRegretScore).toBe(0);
    expect(efficiency.efficiencyRate).toBe(1);
  });

  it('should still return correct dream status', () => {
    const status = engine.getStatus();
    expect(status.running).toBe(false);
    expect(status.totalCycles).toBe(0);
    expect(status.lastDreamAt).toBeNull();
    expect(status.totals.memoriesConsolidated).toBe(0);
    expect(status.totals.synapsesPruned).toBe(0);
    expect(status.totals.memoriesArchived).toBe(0);
  });
});
