import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { EngineTokenBudgetTracker, DEFAULT_ENGINE_BUDGETS } from '../engine-token-budget.js';
import { ParameterRegistry, runParameterRegistryMigration } from '../../metacognition/index.js';
import { runLLMServiceMigration } from '../../llm/llm-service.js';

function createTestDb(): Database.Database {
  const db = new BetterSqlite3(':memory:');
  runLLMServiceMigration(db);
  runParameterRegistryMigration(db);
  return db;
}

function insertUsage(db: Database.Database, engine: string, tokens: number, minutesAgo = 0): void {
  db.prepare(`
    INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached, provider, source_engine, created_at)
    VALUES ('hash', 'custom', 'test-model', ?, 0, ?, 100, 0, 'anthropic', ?, datetime('now', '-' || ? || ' minutes'))
  `).run(tokens, tokens, engine, minutesAgo);
}

describe('EngineTokenBudgetTracker', () => {
  let db: Database.Database;
  let registry: ParameterRegistry;
  let tracker: EngineTokenBudgetTracker;

  beforeEach(() => {
    db = createTestDb();
    registry = new ParameterRegistry(db);
    tracker = new EngineTokenBudgetTracker(db, registry);
  });

  afterEach(() => {
    db.close();
  });

  it('allows budget when no usage recorded', () => {
    tracker.registerDefaults();
    const result = tracker.checkBudget('hypothesis_engine');
    expect(result.allowed).toBe(true);
  });

  it('allows budget when under hourly limit', () => {
    tracker.registerDefaults();
    insertUsage(db, 'hypothesis_engine', 2000, 30);
    const result = tracker.checkBudget('hypothesis_engine');
    expect(result.allowed).toBe(true);
  });

  it('blocks when hourly budget exhausted', () => {
    tracker.registerDefaults();
    // hypothesis_engine has 5000/h limit
    insertUsage(db, 'hypothesis_engine', 3000, 10);
    insertUsage(db, 'hypothesis_engine', 2500, 20);
    const result = tracker.checkBudget('hypothesis_engine');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Hourly');
  });

  it('blocks when daily budget exhausted', () => {
    tracker.registerDefaults();
    // hypothesis_engine has 30000/day limit
    for (let i = 0; i < 12; i++) {
      insertUsage(db, 'hypothesis_engine', 2800, i * 120); // spread across 24h
    }
    const result = tracker.checkBudget('hypothesis_engine');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily');
  });

  it('allows unknown engines (no budget configured)', () => {
    const result = tracker.checkBudget('totally_unknown_engine');
    expect(result.allowed).toBe(true);
  });

  it('getStatus returns all tracked engines', () => {
    tracker.registerDefaults();
    const status = tracker.getStatus();
    expect(status.length).toBe(DEFAULT_ENGINE_BUDGETS.length);
    for (const s of status) {
      expect(s.engineId).toBeDefined();
      expect(s.hourlyLimit).toBeGreaterThan(0);
      expect(s.dailyLimit).toBeGreaterThan(0);
      expect(s.status).toBe('ok');
    }
  });

  it('getEngineStatus shows correct usage', () => {
    tracker.registerDefaults();
    insertUsage(db, 'debate_engine', 4000, 15);
    const status = tracker.getEngineStatus('debate_engine');
    expect(status).not.toBeNull();
    expect(status!.hourlyUsed).toBe(4000);
    expect(status!.hourlyPercent).toBe(80);
    expect(status!.status).toBe('warning');
  });

  it('marks engine as exhausted at 100%', () => {
    tracker.registerDefaults();
    insertUsage(db, 'semantic_compressor', 2100, 5); // limit is 2000
    const status = tracker.getEngineStatus('semantic_compressor');
    expect(status!.status).toBe('exhausted');
  });

  it('registerDefaults creates parameters in registry', () => {
    tracker.registerDefaults();
    const hourly = registry.get('hypothesis_engine', 'token_budget_hourly');
    const daily = registry.get('hypothesis_engine', 'token_budget_daily');
    expect(hourly).not.toBeUndefined();
    expect(hourly).toBe(5000);
    expect(daily).toBe(30000);
  });

  it('respects parameter changes from registry', () => {
    tracker.registerDefaults();
    // Increase budget
    registry.set('hypothesis_engine', 'token_budget_hourly', 50000, 'test', 'test budget increase');
    insertUsage(db, 'hypothesis_engine', 6000, 10);
    const result = tracker.checkBudget('hypothesis_engine');
    expect(result.allowed).toBe(true); // 6000 < 50000
  });

  it('old usage outside hourly window is not counted for hourly', () => {
    tracker.registerDefaults();
    insertUsage(db, 'rag_engine', 5000, 90); // 90 min ago = outside 1h window
    const result = tracker.checkBudget('rag_engine');
    expect(result.allowed).toBe(true);
  });

  it('DEFAULT_ENGINE_BUDGETS has 16 engines', () => {
    expect(DEFAULT_ENGINE_BUDGETS.length).toBe(16);
    const total = DEFAULT_ENGINE_BUDGETS.reduce((s, b) => s + b.hourly, 0);
    expect(total).toBe(68000);
  });

  it('getEngineStatus returns null for unknown engine', () => {
    const status = tracker.getEngineStatus('nonexistent_engine');
    expect(status).toBeNull();
  });

  // ── Reservation tests ─────────────────────────────────

  it('reserveTokens returns reservation ID when under budget', () => {
    tracker.registerDefaults();
    const id = tracker.reserveTokens('hypothesis_engine', 2000);
    expect(id).not.toBeNull();
    expect(id).toMatch(/^res_/);
  });

  it('reserveTokens returns null when budget would be exceeded', () => {
    tracker.registerDefaults();
    // hypothesis_engine has 5000/h — insert 3000 usage, then try to reserve 3000 more
    insertUsage(db, 'hypothesis_engine', 3000, 10);
    const id = tracker.reserveTokens('hypothesis_engine', 3000);
    expect(id).toBeNull();
  });

  it('reserveTokens accounts for in-flight reservations', () => {
    tracker.registerDefaults();
    // hypothesis_engine has 5000/h — reserve 3000, then try another 3000
    const id1 = tracker.reserveTokens('hypothesis_engine', 3000);
    expect(id1).not.toBeNull();
    const id2 = tracker.reserveTokens('hypothesis_engine', 3000);
    expect(id2).toBeNull(); // 3000 reserved + 3000 requested > 5000 limit
  });

  it('releaseReservation frees up budget for new reservations', () => {
    tracker.registerDefaults();
    const id1 = tracker.reserveTokens('hypothesis_engine', 3000)!;
    expect(id1).not.toBeNull();
    tracker.releaseReservation(id1);
    const id2 = tracker.reserveTokens('hypothesis_engine', 3000);
    expect(id2).not.toBeNull(); // should succeed after release
  });

  it('reserveTokens allows unknown engines (no budget configured)', () => {
    const id = tracker.reserveTokens('totally_unknown_engine', 999999);
    expect(id).not.toBeNull();
  });

  // ── Invariant tests (no drift) ────────────────────────

  it('invariant: successful call — reservation gone, usage recorded, budget consistent', () => {
    tracker.registerDefaults();
    // 1. Reserve tokens
    const resId = tracker.reserveTokens('debate_engine', 2000)!;
    expect(resId).not.toBeNull();
    // Budget should reflect reservation
    const statusDuring = tracker.getEngineStatus('debate_engine')!;
    expect(statusDuring.hourlyUsed).toBe(0); // DB usage is 0, reservation is separate

    // 2. Simulate successful call — record actual usage, release reservation
    insertUsage(db, 'debate_engine', 1500, 0); // actual < estimated
    tracker.releaseReservation(resId);

    // 3. After release: no phantom reservation, DB reflects actual
    const statusAfter = tracker.getEngineStatus('debate_engine')!;
    expect(statusAfter.hourlyUsed).toBe(1500);
    // Can reserve again up to limit
    const resId2 = tracker.reserveTokens('debate_engine', 3000);
    expect(resId2).not.toBeNull(); // 1500 + 3000 < 5000
  });

  it('invariant: failed call — reservation released, no phantom usage', () => {
    tracker.registerDefaults();
    // 1. Reserve tokens
    const resId = tracker.reserveTokens('creative_engine', 2000)!;
    expect(resId).not.toBeNull();

    // 2. Call fails — no usage inserted, just release reservation
    tracker.releaseReservation(resId);

    // 3. No phantom usage — budget should be fully available
    const status = tracker.getEngineStatus('creative_engine')!;
    expect(status.hourlyUsed).toBe(0);
    expect(status.dailyUsed).toBe(0);
    const check = tracker.checkBudget('creative_engine');
    expect(check.allowed).toBe(true);
  });

  it('invariant: long sequence of reserve/release has no drift', () => {
    tracker.registerDefaults();
    // Simulate 20 cycles: reserve → insert actual → release
    for (let i = 0; i < 20; i++) {
      const estimated = 200;
      const actual = 150 + Math.floor(i % 3) * 10; // 150, 160, 170, 150, ...
      const resId = tracker.reserveTokens('rag_engine', estimated);
      if (!resId) break; // budget exhausted — expected eventually
      insertUsage(db, 'rag_engine', actual, 0);
      tracker.releaseReservation(resId);
    }

    // Total actual usage should be the sum of inserted rows
    const totalActual = (db.prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) as t FROM llm_usage WHERE source_engine = 'rag_engine'`,
    ).get() as { t: number }).t;

    const status = tracker.getEngineStatus('rag_engine')!;
    // Tracker's hourlyUsed must equal actual DB sum (no drift from reservations)
    expect(status.hourlyUsed).toBe(totalActual);
    // rag_engine has 3000/h — 20 * ~157 avg ≈ 3140 → should eventually block
    expect(status.hourlyUsed).toBeGreaterThan(0);
  });
});
