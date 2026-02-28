import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ABTestRepository } from '../../../src/db/repositories/ab-test.repository.js';
import { ABTestService } from '../../../src/services/ab-test.service.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ab_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      variant_a TEXT NOT NULL,
      variant_b TEXT NOT NULL,
      metric TEXT NOT NULL DEFAULT 'engagement',
      status TEXT NOT NULL DEFAULT 'running',
      winner TEXT,
      a_samples INTEGER NOT NULL DEFAULT 0,
      b_samples INTEGER NOT NULL DEFAULT 0,
      a_metric_sum REAL NOT NULL DEFAULT 0,
      b_metric_sum REAL NOT NULL DEFAULT 0,
      significance REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE ab_test_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id INTEGER NOT NULL,
      variant TEXT NOT NULL,
      metric_value REAL NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (test_id) REFERENCES ab_tests(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_ab_tests_status ON ab_tests(status);
    CREATE INDEX idx_ab_test_data_test ON ab_test_data(test_id);
    CREATE INDEX idx_ab_test_data_variant ON ab_test_data(test_id, variant);
  `);
  return db;
}

describe('ABTestService', () => {
  let db: Database.Database;
  let repo: ABTestRepository;
  let service: ABTestService;

  beforeEach(() => {
    db = createDb();
    repo = new ABTestRepository(db);
    service = new ABTestService(repo);
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. create() creates a test and returns it ──

  it('create() creates a test and returns it', () => {
    const test = service.create({
      name: 'Headline test',
      variant_a: 'Short headline',
      variant_b: 'Long descriptive headline',
    });

    expect(test).toBeDefined();
    expect(test.id).toBeGreaterThanOrEqual(1);
    expect(test.name).toBe('Headline test');
    expect(test.variant_a).toBe('Short headline');
    expect(test.variant_b).toBe('Long descriptive headline');
    expect(test.metric).toBe('engagement');
    expect(test.status).toBe('running');
    expect(test.a_samples).toBe(0);
    expect(test.b_samples).toBe(0);
  });

  // ── 2. recordDataPoint() updates samples and sums ──

  it('recordDataPoint() updates samples and sums', () => {
    const test = service.create({ name: 'Test', variant_a: 'A', variant_b: 'B' });

    const result = service.recordDataPoint(test.id, 'a', 42);
    expect(result.test.a_samples).toBe(1);
    expect(result.test.a_metric_sum).toBe(42);
    expect(result.a_avg).toBe(42);

    const result2 = service.recordDataPoint(test.id, 'b', 30);
    expect(result2.test.b_samples).toBe(1);
    expect(result2.test.b_metric_sum).toBe(30);
    expect(result2.b_avg).toBe(30);
  });

  // ── 3. recordDataPoint() throws for non-existent test ──

  it('recordDataPoint() throws for non-existent test', () => {
    expect(() => service.recordDataPoint(999, 'a', 10)).toThrow('A/B test #999 not found');
  });

  // ── 4. recordDataPoint() throws for completed test ──

  it('recordDataPoint() throws for completed test', () => {
    const test = service.create({ name: 'Test', variant_a: 'A', variant_b: 'B' });
    // Manually mark as completed
    repo.update(test.id, { status: 'completed', completed_at: new Date().toISOString() });

    expect(() => service.recordDataPoint(test.id, 'a', 10))
      .toThrow(/not running/);
  });

  // ── 5. Significance is 0 when fewer than 2 samples per variant ──

  it('significance is 0 when fewer than 2 samples per variant', () => {
    const test = service.create({ name: 'Test', variant_a: 'A', variant_b: 'B' });

    const r1 = service.recordDataPoint(test.id, 'a', 100);
    expect(r1.significance).toBe(0);

    const r2 = service.recordDataPoint(test.id, 'b', 50);
    expect(r2.significance).toBe(0);
  });

  // ── 6. Significance increases with more data and clear winner ──

  it('significance increases with more data and clear winner', () => {
    const test = service.create({ name: 'Test', variant_a: 'A', variant_b: 'B' });

    // Record a few data points to get past the minimum threshold
    service.recordDataPoint(test.id, 'a', 100);
    service.recordDataPoint(test.id, 'a', 110);
    service.recordDataPoint(test.id, 'b', 10);
    const r1 = service.recordDataPoint(test.id, 'b', 15);
    const sig1 = r1.significance;

    // More data points should increase significance
    service.recordDataPoint(test.id, 'a', 105);
    service.recordDataPoint(test.id, 'a', 95);
    service.recordDataPoint(test.id, 'b', 12);
    const r2 = service.recordDataPoint(test.id, 'b', 8);
    const sig2 = r2.significance;

    expect(sig2).toBeGreaterThanOrEqual(sig1);
    expect(sig2).toBeGreaterThan(0);
  });

  // ── 7. Auto-completes when significance >= 0.95 and 10+ samples each ──

  it('auto-completes when significance >= 0.95 and 10+ samples each', () => {
    const test = service.create({ name: 'Auto-complete', variant_a: 'A', variant_b: 'B' });

    // Interleave A and B data points so both variants grow together.
    // A values around 100, B values around 10 — very different distributions.
    let lastResult;
    for (let i = 0; i < 15; i++) {
      const aVal = 95 + (i % 3) * 5; // 95, 100, 105
      const bVal = 8 + (i % 3) * 2;  // 8, 10, 12

      // Once the test auto-completes, further recording will throw.
      // Catch that and break out.
      try {
        service.recordDataPoint(test.id, 'a', aVal);
      } catch {
        break;
      }
      try {
        lastResult = service.recordDataPoint(test.id, 'b', bVal);
      } catch {
        break;
      }
    }

    // The test should have been auto-completed at some point
    const status = service.getStatus(test.id);
    expect(status.test.status).toBe('completed');
    expect(status.isSignificant).toBe(true);
    expect(status.significance).toBeGreaterThanOrEqual(0.95);
    expect(status.winner).toBe('a');
  });

  // ── 8. getStatus() returns current state ──

  it('getStatus() returns current state', () => {
    const test = service.create({ name: 'Status test', variant_a: 'A', variant_b: 'B' });
    service.recordDataPoint(test.id, 'a', 50);
    service.recordDataPoint(test.id, 'b', 30);

    const status = service.getStatus(test.id);

    expect(status.test.id).toBe(test.id);
    expect(status.test.name).toBe('Status test');
    expect(status.a_avg).toBe(50);
    expect(status.b_avg).toBe(30);
    expect(status.winner).toBe('a');
    expect(typeof status.significance).toBe('number');
    expect(typeof status.isSignificant).toBe('boolean');
  });

  // ── 9. listAll() returns all tests ──

  it('listAll() returns all tests', () => {
    service.create({ name: 'Test 1', variant_a: 'A1', variant_b: 'B1' });
    service.create({ name: 'Test 2', variant_a: 'A2', variant_b: 'B2' });
    service.create({ name: 'Test 3', variant_a: 'A3', variant_b: 'B3' });

    const all = service.listAll();
    expect(all).toHaveLength(3);
  });

  // ── 10. listByStatus() filters by status ──

  it('listByStatus() filters by status', () => {
    const t1 = service.create({ name: 'Running', variant_a: 'A', variant_b: 'B' });
    service.create({ name: 'Also running', variant_a: 'A', variant_b: 'B' });
    const t3 = service.create({ name: 'Will complete', variant_a: 'A', variant_b: 'B' });

    // Mark t3 as completed
    repo.update(t3.id, { status: 'completed', completed_at: new Date().toISOString() });

    const running = service.listByStatus('running');
    expect(running).toHaveLength(2);
    expect(running.every(t => t.status === 'running')).toBe(true);

    const completed = service.listByStatus('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.name).toBe('Will complete');
  });

  // ── 11. Zero variance case: all same values ──

  it('handles zero variance: all same values for both variants', () => {
    const test = service.create({ name: 'Zero var', variant_a: 'A', variant_b: 'B' });

    // All A values are 50, all B values are 50 — no difference
    for (let i = 0; i < 5; i++) {
      service.recordDataPoint(test.id, 'a', 50);
    }
    let result;
    for (let i = 0; i < 5; i++) {
      result = service.recordDataPoint(test.id, 'b', 50);
    }

    // When both sides are identical, significance should be 0 (se === 0, means are equal)
    expect(result!.significance).toBe(0);
    expect(result!.winner).toBe('tie');
  });

  it('handles zero variance with different means', () => {
    const test = service.create({ name: 'Zero var diff', variant_a: 'A', variant_b: 'B' });

    // All A = 100, All B = 50 — zero variance but different means
    for (let i = 0; i < 5; i++) {
      service.recordDataPoint(test.id, 'a', 100);
    }
    let result;
    for (let i = 0; i < 5; i++) {
      result = service.recordDataPoint(test.id, 'b', 50);
    }

    // se === 0 and means differ → significance should be 1
    expect(result!.significance).toBe(1);
    expect(result!.winner).toBe('a');
  });

  // ── 12. Welch's z-test produces reasonable values ──

  it('Welch z-test produces reasonable significance for clearly different distributions', () => {
    const test = service.create({ name: 'Welch test', variant_a: 'A', variant_b: 'B' });

    // A: values around 100 with some variance
    const aValues = [95, 100, 105, 98, 103, 97, 102, 101, 99, 104, 96, 100, 98, 102, 101];
    // B: values around 50 with some variance
    const bValues = [48, 52, 50, 47, 53, 49, 51, 50, 48, 52, 51, 49, 50, 48, 53];

    // Interleave to avoid auto-complete before all data is recorded
    let lastResult;
    for (let i = 0; i < Math.max(aValues.length, bValues.length); i++) {
      try {
        if (i < aValues.length) service.recordDataPoint(test.id, 'a', aValues[i]!);
      } catch {
        break;
      }
      try {
        if (i < bValues.length) lastResult = service.recordDataPoint(test.id, 'b', bValues[i]!);
      } catch {
        break;
      }
    }

    // With mean ~100 vs ~50 and many samples, significance should be very high
    const status = service.getStatus(test.id);
    expect(status.significance).toBeGreaterThan(0.99);
    expect(status.winner).toBe('a');
    expect(status.a_avg).toBeGreaterThan(90);
    expect(status.b_avg).toBeLessThan(55);
  });
});
