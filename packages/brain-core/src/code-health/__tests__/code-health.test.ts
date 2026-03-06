import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CodeHealthMonitor, runCodeHealthMigration } from '../health-monitor.js';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CodeHealthMonitor', () => {
  let db: Database.Database;
  let monitor: CodeHealthMonitor;

  beforeEach(() => {
    db = new Database(':memory:');
    monitor = new CodeHealthMonitor(db, { brainName: 'brain' });
  });

  afterEach(() => {
    db.close();
  });

  it('migration is idempotent', () => {
    // Migration already ran in constructor, run again — should not throw
    runCodeHealthMigration(db);
    runCodeHealthMigration(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='code_health_scans'")
      .all();
    expect(tables.length).toBe(1);
  });

  it('scan stores result in DB', () => {
    const result = monitor.scan('/test/project');
    expect(result.id).toBeDefined();
    expect(result.projectPath).toBe('/test/project');
    expect(typeof result.complexityScore).toBe('number');
    expect(typeof result.duplicationScore).toBe('number');
    expect(typeof result.depHealthScore).toBe('number');
    expect(typeof result.testRatio).toBe('number');
    expect(typeof result.techDebtScore).toBe('number');
    expect(typeof result.fileCount).toBe('number');

    // Verify persisted
    const row = db.prepare('SELECT * FROM code_health_scans WHERE id = ?').get(result.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.project_path).toBe('/test/project');
  });

  it('scan returns defaults with proper scores', () => {
    const result = monitor.scan('/my/app');
    expect(result.complexityScore).toBeGreaterThanOrEqual(0);
    expect(result.complexityScore).toBeLessThanOrEqual(100);
    expect(result.duplicationScore).toBe(0); // placeholder
    expect(result.depHealthScore).toBeGreaterThanOrEqual(0);
    expect(result.depHealthScore).toBeLessThanOrEqual(1);
    expect(result.testRatio).toBeGreaterThanOrEqual(0);
    expect(result.testRatio).toBeLessThanOrEqual(1);
    expect(result.fileCount).toBeGreaterThan(0);
  });

  it('trends returns scan history', () => {
    monitor.scan('/project/a');
    monitor.scan('/project/a');
    monitor.scan('/project/a');

    const trendData = monitor.trends('/project/a');
    expect(trendData.length).toBe(3);
    // Most recent first
    expect(trendData[0].scan.id).toBeGreaterThan(trendData[1].scan.id!);
  });

  it('trends computes deltas between scans', () => {
    monitor.scan('/project/a');
    monitor.scan('/project/a');

    const trendData = monitor.trends('/project/a');
    expect(trendData.length).toBe(2);

    // First entry (newest) should have deltas
    expect(trendData[0].deltas).not.toBeNull();
    expect(typeof trendData[0].deltas!.complexityScore).toBe('number');
    expect(typeof trendData[0].deltas!.techDebtScore).toBe('number');
    expect(typeof trendData[0].deltas!.fileCount).toBe('number');

    // Last entry (oldest) has no previous, so deltas = null
    expect(trendData[1].deltas).toBeNull();
  });

  it('getStatus returns empty state', () => {
    const status = monitor.getStatus();
    expect(status.totalScans).toBe(0);
    expect(status.lastScan).toBeNull();
    expect(status.avgTechDebt).toBe(0);
  });

  it('getStatus with data returns correct values', () => {
    monitor.scan('/project/x');
    monitor.scan('/project/y');

    const status = monitor.getStatus();
    expect(status.totalScans).toBe(2);
    expect(status.lastScan).not.toBeNull();
    expect(status.lastScan!.projectPath).toBe('/project/y');
    expect(status.avgTechDebt).toBeGreaterThan(0);
  });

  it('tech debt calculation is weighted composite', () => {
    const result = monitor.scan('/project/test');
    // techDebt = complexity*0.3 + duplication*0.3 + (1-testRatio)*100*0.2 + (1-depHealth)*100*0.2
    const expected =
      result.complexityScore * 0.3 +
      result.duplicationScore * 0.3 +
      (1 - result.testRatio) * 100 * 0.2 +
      (1 - result.depHealthScore) * 100 * 0.2;

    expect(result.techDebtScore).toBeCloseTo(expected, 5);
  });

  it('dep health scoring considers deps ratio', () => {
    // Different project paths produce different estimated dep counts
    const result1 = monitor.scan('/a');
    const result2 = monitor.scan('/very-long-project-name-for-different-stats');

    // Both should be valid scores
    expect(result1.depHealthScore).toBeGreaterThanOrEqual(0);
    expect(result1.depHealthScore).toBeLessThanOrEqual(1);
    expect(result2.depHealthScore).toBeGreaterThanOrEqual(0);
    expect(result2.depHealthScore).toBeLessThanOrEqual(1);
  });

  it('scan multiple projects keeps separate histories', () => {
    monitor.scan('/project/alpha');
    monitor.scan('/project/alpha');
    monitor.scan('/project/beta');

    const alphaHistory = monitor.trends('/project/alpha');
    const betaHistory = monitor.trends('/project/beta');

    expect(alphaHistory.length).toBe(2);
    expect(betaHistory.length).toBe(1);
  });
});
