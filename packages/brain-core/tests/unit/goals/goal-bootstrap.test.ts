import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GoalEngine } from '../../../src/goals/goal-engine.js';

describe('GoalEngine — Bootstrap, Direction & Ratcheting', () => {
  let db: Database.Database;
  let engine: GoalEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new GoalEngine(db, { brainName: 'test-brain' });
  });

  // ── Bootstrap ────────────────────────────────────────

  it('bootstrapDefaults creates 6 goals when table is empty', () => {
    const goals = engine.bootstrapDefaults(1);
    expect(goals).toHaveLength(6);

    const metrics = goals.map(g => g.metricName);
    expect(metrics).toContain('principleCount');
    expect(metrics).toContain('predictionAccuracy');
    expect(metrics).toContain('experimentCount');
    expect(metrics).toContain('knowledgeQuality');
    expect(metrics).toContain('activeGaps');
    expect(metrics).toContain('confirmationRate');

    // activeGaps should be lower_is_better
    const gapsGoal = goals.find(g => g.metricName === 'activeGaps')!;
    expect(gapsGoal.direction).toBe('lower_is_better');

    // All others should be higher_is_better
    const higherGoals = goals.filter(g => g.metricName !== 'activeGaps');
    for (const g of higherGoals) {
      expect(g.direction).toBe('higher_is_better');
    }
  });

  it('bootstrapDefaults is idempotent — skips when goals exist', () => {
    engine.createGoal('Existing', 'test', 1.0, 50);
    const goals = engine.bootstrapDefaults(1);
    expect(goals).toHaveLength(0);

    // Still just the one manual goal
    const all = engine.listGoals();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Existing');
  });

  // ── Direction: lower_is_better ────────────────────────

  it('lower_is_better goal is achieved when value <= target', () => {
    engine.createGoal('Close Gaps', 'activeGaps', 5, 100, {
      baselineValue: 20,
      currentCycle: 0,
      direction: 'lower_is_better',
    });
    engine.recordProgress(1, { activeGaps: 4 });
    const { achieved } = engine.checkGoals(1);

    expect(achieved).toHaveLength(1);
    expect(achieved[0].status).toBe('achieved');
  });

  it('lower_is_better goal is NOT achieved when value > target', () => {
    engine.createGoal('Close Gaps', 'activeGaps', 5, 100, {
      baselineValue: 20,
      currentCycle: 0,
      direction: 'lower_is_better',
    });
    engine.recordProgress(1, { activeGaps: 8 });
    const { achieved } = engine.checkGoals(1);

    expect(achieved).toHaveLength(0);
  });

  // ── Ratcheting ────────────────────────────────────────

  it('ratchetGoal creates harder successor goal (higher_is_better)', () => {
    const goal = engine.createGoal('Principles', 'principleCount', 10, 50, {
      baselineValue: 0,
      currentCycle: 0,
    });
    // Simulate achievement
    engine.recordProgress(5, { principleCount: 12 });
    const { achieved } = engine.checkGoals(5);
    expect(achieved).toHaveLength(1);

    const successor = engine.ratchetGoal(achieved[0], 5);
    expect(successor).not.toBeNull();
    expect(successor!.title).toBe('Principles (Level 2)');
    expect(successor!.baselineValue).toBe(12); // achieved value becomes baseline
    expect(successor!.targetValue).toBe(12 + (12 - 0) * 0.5); // 18
    expect(successor!.status).toBe('active');
  });

  it('ratchetGoal creates harder successor goal (lower_is_better)', () => {
    const goal = engine.createGoal('Close Gaps', 'activeGaps', 5, 100, {
      baselineValue: 20,
      currentCycle: 0,
      direction: 'lower_is_better',
    });
    engine.recordProgress(5, { activeGaps: 4 });
    const { achieved } = engine.checkGoals(5);
    expect(achieved).toHaveLength(1);

    const successor = engine.ratchetGoal(achieved[0], 5);
    expect(successor).not.toBeNull();
    expect(successor!.title).toBe('Close Gaps (Level 2)');
    expect(successor!.baselineValue).toBe(4);
    // improvement = 20 - 4 = 16, newTarget = max(1, 4 - 16*0.5) = max(1, -4) = 1
    expect(successor!.targetValue).toBe(1);
    expect(successor!.direction).toBe('lower_is_better');
  });

  it('ratchetGoal returns null when at max capacity', () => {
    // Create engine with maxActiveGoals=2
    const smallEngine = new GoalEngine(db, { brainName: 'test', maxActiveGoals: 2 });
    smallEngine.createGoal('G1', 'a', 10, 50);
    smallEngine.createGoal('G2', 'b', 10, 50);

    // Fake an achieved goal
    const fakeAchieved = smallEngine.listGoals('active')[0];

    const result = smallEngine.ratchetGoal(fakeAchieved, 1);
    expect(result).toBeNull();
  });

  // ── Progress & Forecast with direction ────────────────

  it('getProgress for lower_is_better shows correct progressPercent', () => {
    const goal = engine.createGoal('Close Gaps', 'activeGaps', 5, 100, {
      baselineValue: 20,
      currentCycle: 0,
      direction: 'lower_is_better',
    });
    // Move from 20 → 12 (halfway to 5, range=15, moved=8)
    engine.recordProgress(1, { activeGaps: 15 });
    engine.recordProgress(2, { activeGaps: 12 });

    const progress = engine.getProgress(goal.id!);
    expect(progress).not.toBeNull();
    // baseline=20, target=5, range=15, current from baseline=20-12=8
    // progressPercent = 8/15 * 100 ≈ 53.33
    expect(progress!.progressPercent).toBeCloseTo(53.33, 0);
    // deltas are negative (-5, -3), avg < -0.01 → improving for lower_is_better
    expect(progress!.trend).toBe('improving');
  });

  it('forecastCompletion for lower_is_better with negative slope', () => {
    const goal = engine.createGoal('Close Gaps', 'activeGaps', 2, 100, {
      baselineValue: 20,
      currentCycle: 0,
      direction: 'lower_is_better',
    });

    // Simulate decreasing values (negative slope is good)
    for (let cycle = 1; cycle <= 10; cycle++) {
      engine.recordProgress(cycle, { activeGaps: 20 - cycle * 1.5 });
    }

    const forecast = engine.forecastCompletion(goal.id!);
    expect(forecast).not.toBeNull();
    expect(forecast!.slope).toBeLessThan(0);
    expect(forecast!.estimatedCycle).not.toBeNull();
    expect(forecast!.willComplete).toBe(true);
  });
});
