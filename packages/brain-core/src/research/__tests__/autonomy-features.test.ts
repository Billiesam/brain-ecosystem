import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { DataScout } from '../data-scout.js';
import { ResearchOrchestrator } from '../research-orchestrator.js';
import { ResearchMissionEngine, runMissionMigration } from '../../missions/mission-engine.js';
import { SelfModificationEngine, runSelfModificationMigration } from '../../self-modification/self-modification-engine.js';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── DataScout.startPeriodicScan ─────────────────────────

describe('DataScout.startPeriodicScan', () => {
  let db: Database.Database;
  let scout: DataScout;

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Database(':memory:');
    scout = new DataScout(db);
  });

  afterEach(() => {
    scout.stopPeriodicScan();
    vi.useRealTimers();
    db.close();
  });

  it('should start periodic scan without crashing', () => {
    expect(() => scout.startPeriodicScan(60_000)).not.toThrow();
  });

  it('should be idempotent — calling twice does not create duplicate timers', () => {
    scout.startPeriodicScan(60_000);
    // Access the private scanTimer to verify it is set
    const timerAfterFirst = (scout as unknown as { scanTimer: unknown }).scanTimer;
    expect(timerAfterFirst).not.toBeNull();

    // Call again — should be a no-op
    scout.startPeriodicScan(60_000);
    const timerAfterSecond = (scout as unknown as { scanTimer: unknown }).scanTimer;

    // The timer reference should be the same (not replaced)
    expect(timerAfterSecond).toBe(timerAfterFirst);
  });

  it('should clean up timer on stopPeriodicScan', () => {
    scout.startPeriodicScan(60_000);
    expect((scout as unknown as { scanTimer: unknown }).scanTimer).not.toBeNull();

    scout.stopPeriodicScan();
    expect((scout as unknown as { scanTimer: unknown }).scanTimer).toBeNull();
  });

  it('should call scout() after initial delay fires', async () => {
    const mockAdapter = {
      name: 'test-adapter',
      scout: vi.fn().mockResolvedValue([]),
      isEnabled: () => true,
    };
    scout.addAdapter(mockAdapter);

    scout.startPeriodicScan(60_000);

    // Before 120s delay, scout should not have been called
    expect(mockAdapter.scout).not.toHaveBeenCalled();

    // Advance past the 120s initial delay
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockAdapter.scout).toHaveBeenCalledTimes(1);

    // Advance one interval — should trigger the interval callback
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockAdapter.scout).toHaveBeenCalledTimes(2);
  });

  it('should not call scout() if stopped before initial delay', async () => {
    const mockAdapter = {
      name: 'test-adapter',
      scout: vi.fn().mockResolvedValue([]),
      isEnabled: () => true,
    };
    scout.addAdapter(mockAdapter);

    scout.startPeriodicScan(60_000);
    scout.stopPeriodicScan();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(mockAdapter.scout).not.toHaveBeenCalled();
  });
});

// ── ResearchOrchestrator.setMissionEngine ────────────────

describe('ResearchOrchestrator.setMissionEngine', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should accept a ResearchMissionEngine without crashing', () => {
    const orchestrator = new ResearchOrchestrator(db, { brainName: 'test' });
    runMissionMigration(db);
    const missionEngine = new ResearchMissionEngine(db, { brainName: 'test' });

    expect(() => orchestrator.setMissionEngine(missionEngine)).not.toThrow();
  });

  it('should accept setMissionEngine being called multiple times', () => {
    const orchestrator = new ResearchOrchestrator(db, { brainName: 'test' });
    runMissionMigration(db);
    const engine1 = new ResearchMissionEngine(db, { brainName: 'test' });
    const engine2 = new ResearchMissionEngine(db, { brainName: 'test' });

    expect(() => {
      orchestrator.setMissionEngine(engine1);
      orchestrator.setMissionEngine(engine2);
    }).not.toThrow();
  });
});

// ── SelfModificationEngine.applyModification (git backup) ─

describe('SelfModificationEngine.applyModification', () => {
  let db: Database.Database;
  let engine: SelfModificationEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new SelfModificationEngine(db, {
      brainName: 'test',
      apiKey: 'test-key',
      projectRoot: '',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should have applyModification as a callable method', () => {
    expect(typeof engine.applyModification).toBe('function');
  });

  it('should throw when modification does not exist', () => {
    expect(() => engine.applyModification(999)).toThrow(/not found/);
  });

  it('should throw when modification is not approved or ready', () => {
    // Create a proposed modification (status = 'proposed')
    const mod = engine.proposeModification(
      'Test mod',
      'Fix something',
      ['packages/brain-core/src/research/data-scout.ts'],
      'test-engine',
    );
    expect(() => engine.applyModification(mod.id)).toThrow(/not approved or ready/);
  });

  it('should throw when projectRoot is not configured', () => {
    // Engine created with empty projectRoot — applyModification needs it
    // First, we need a modification in approved state with a diff
    const mod = engine.proposeModification(
      'Test mod',
      'Fix something',
      ['packages/brain-core/src/research/data-scout.ts'],
      'test-engine',
    );

    // Manually set status to 'approved' and provide a diff
    db.prepare('UPDATE self_modifications SET status = ?, generated_diff = ? WHERE id = ?').run(
      'approved',
      JSON.stringify([{ filePath: 'packages/brain-core/src/research/data-scout.ts', oldContent: '', newContent: '// test' }]),
      mod.id,
    );

    expect(() => engine.applyModification(mod.id)).toThrow(/projectRoot not configured/);
  });

  it('should construct without crashing (migration runs)', () => {
    // Verifies the constructor + runSelfModificationMigration work
    expect(engine).toBeDefined();
    const status = engine.getStatus();
    expect(status.brainName).toBe('test');
    expect(status.totalModifications).toBe(0);
  });

  it('should propose and retrieve a modification', () => {
    const mod = engine.proposeModification(
      'Improve data-scout',
      'Add retry logic',
      ['packages/brain-core/src/research/data-scout.ts'],
    );
    expect(mod.id).toBeGreaterThan(0);
    expect(mod.status).toBe('proposed');

    const retrieved = engine.getModification(mod.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Improve data-scout');
  });
});
