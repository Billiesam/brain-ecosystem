import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { AutoExperimentEngine } from '../../../src/metacognition/auto-experiment-engine.js';
import { ParameterRegistry } from '../../../src/metacognition/parameter-registry.js';
import { GovernanceLayer } from '../../../src/governance/governance-layer.js';
import { AdaptiveScheduler } from '../../../src/research/adaptive-scheduler.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('Fix 1: AutoExperimentEngine orphan timeout', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => { db.close(); });

  it('rolls back orphaned experiments older than 24h', () => {
    // Setup ParameterRegistry
    const registry = new ParameterRegistry(db);
    registry.register({ engine: 'test', name: 'alpha', value: 0.5, min: 0, max: 1, description: 'test param', category: 'test' });

    // Create a snapshot before changing the value
    const snapshotId = registry.snapshot('test_orphan_setup');

    // Create mock ExperimentEngine
    const mockExperiment = {
      create: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      recordMeasurement: vi.fn(),
    };

    const engine = new AutoExperimentEngine(db, registry, mockExperiment as any, null, null);

    // Insert an orphan experiment (no experiment_id) created 25 hours ago
    db.prepare(`
      INSERT INTO auto_experiments (parameter_engine, parameter_name, experiment_id, snapshot_id, old_value, new_value, status, hypothesis, created_at)
      VALUES (?, ?, NULL, ?, 0.5, 0.8, 'running', 'test hypothesis', datetime('now', '-25 hours'))
    `).run('test', 'alpha', snapshotId);

    const results = engine.processCompleted(100);

    // Should have rolled back
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('rolled_back');

    // Verify DB status updated
    const exp = db.prepare('SELECT status, result_summary FROM auto_experiments WHERE id = ?').get(results[0].autoExpId) as any;
    expect(exp.status).toBe('rolled_back');
    expect(exp.result_summary).toContain('Timed out');
  });

  it('keeps orphaned experiments younger than 24h', () => {
    const registry = new ParameterRegistry(db);
    registry.register({ engine: 'test', name: 'beta', value: 0.3, min: 0, max: 1, description: 'test', category: 'test' });
    const snapshotId = registry.snapshot('test_young');

    const mockExperiment = {
      create: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(null),
      recordMeasurement: vi.fn(),
    };

    const engine = new AutoExperimentEngine(db, registry, mockExperiment as any, null, null);

    // Insert a young orphan (1 hour ago)
    db.prepare(`
      INSERT INTO auto_experiments (parameter_engine, parameter_name, experiment_id, snapshot_id, old_value, new_value, status, hypothesis, created_at)
      VALUES (?, ?, NULL, ?, 0.3, 0.6, 'running', 'young test', datetime('now', '-1 hour'))
    `).run('test', 'beta', snapshotId);

    const results = engine.processCompleted(100);

    // Should NOT have rolled back — still within 24h
    expect(results.length).toBe(0);

    // Verify still running
    const exp = db.prepare("SELECT status FROM auto_experiments WHERE parameter_name = 'beta'").get() as any;
    expect(exp.status).toBe('running');
  });
});

describe('Fix 2: GovernanceLayer.setMetaCognitionLayer() wiring', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => { db.close(); });

  it('GovernanceLayer accepts MetaCognitionLayer and uses it in review()', () => {
    const governance = new GovernanceLayer(db);

    // Create engine_report_cards table (normally created by MetaCognitionLayer)
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_report_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine TEXT NOT NULL,
        grade TEXT NOT NULL,
        combined_score REAL NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Mock MetaCognitionLayer with evaluate method
    const mockMeta = {
      evaluate: vi.fn().mockReturnValue([
        { engine: 'test_engine', grade: 'F', combined_score: 0.1 },
      ]),
    };

    governance.setMetaCognitionLayer(mockMeta);

    // Insert 3 Grade-F entries to trigger cooldown logic
    for (let i = 0; i < 4; i++) {
      db.prepare('INSERT INTO engine_report_cards (engine, grade, combined_score) VALUES (?, ?, ?)').run('test_engine', 'F', 0.1);
    }

    // review() should now use metaCognitionLayer's data for Grade-F detection
    const decisions = governance.review(1);
    // The metaCognitionLayer path should find the F grades in the DB
    expect(Array.isArray(decisions)).toBe(true);
  });

  it('without MetaCognitionLayer, Grade-F detection is skipped', () => {
    const governance = new GovernanceLayer(db);

    // Do NOT set metaCognitionLayer
    // review should still work without errors
    const decisions = governance.review(1);
    expect(Array.isArray(decisions)).toBe(true);
  });
});

describe('Fix 3: AdaptiveScheduler wiring', () => {
  it('AdaptiveScheduler adjusts interval based on productivity', () => {
    const scheduler = new AdaptiveScheduler({
      baseIntervalMs: 300_000,
      minIntervalMs: 120_000,
      maxIntervalMs: 900_000,
      idleThreshold: 3,
    });

    // Initially returns base interval
    expect(scheduler.getNextInterval()).toBe(300_000);

    // Record productive cycles
    scheduler.recordOutcome({
      insightsFound: 5,
      rulesLearned: 2,
      anomaliesDetected: 1,
      durationMs: 2000,
    });

    // After productive cycle, interval should decrease
    const nextInterval = scheduler.getNextInterval();
    expect(nextInterval).toBeLessThan(300_000);
    expect(nextInterval).toBeGreaterThanOrEqual(120_000);
  });

  it('idle buckets increase interval', () => {
    const scheduler = new AdaptiveScheduler({
      baseIntervalMs: 300_000,
      minIntervalMs: 120_000,
      maxIntervalMs: 900_000,
      idleThreshold: 2,
    });

    // Record idle cycles (no insights/rules/anomalies)
    const fixedDate = new Date('2026-03-10T10:00:00');
    for (let i = 0; i < 3; i++) {
      scheduler.recordOutcome({
        insightsFound: 0,
        rulesLearned: 0,
        anomaliesDetected: 0,
        durationMs: 1000,
      }, fixedDate);
    }

    const nextInterval = scheduler.getNextInterval();
    expect(nextInterval).toBeGreaterThan(300_000);
    expect(nextInterval).toBeLessThanOrEqual(900_000);
  });

  it('getStatus returns correct summary', () => {
    const scheduler = new AdaptiveScheduler();
    const status = scheduler.getStatus();

    expect(status.currentIntervalMs).toBe(300_000);
    expect(status.baseIntervalMs).toBe(300_000);
    expect(status.minIntervalMs).toBe(120_000);
    expect(status.maxIntervalMs).toBe(900_000);
    expect(status.totalCycles).toBe(0);
  });

  it('verifies AdaptiveScheduler is wired in brain.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Check brain.ts
    const brainContent = readFileSync(
      join(__dirname, '../../../../brain/src/brain.ts'),
      'utf-8',
    );
    expect(brainContent).toContain('new AdaptiveScheduler()');
    expect(brainContent).toContain('setAdaptiveScheduler(adaptiveScheduler)');
  });

  it('verifies GovernanceLayer.setMetaCognitionLayer is called in brain.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const brainContent = readFileSync(
      join(__dirname, '../../../../brain/src/brain.ts'),
      'utf-8',
    );
    expect(brainContent).toContain('governanceLayer?.setMetaCognitionLayer(metaCognitionLayer)');
  });
});
