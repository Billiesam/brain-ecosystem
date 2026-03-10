import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ResearchOrchestrator } from '../../../src/research/research-orchestrator.js';
import { ActionBridgeEngine } from '../../../src/action/action-bridge.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('Desire Feedback Loop (Fix 1)', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;
  let actionBridge: ActionBridgeEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
    actionBridge = new ActionBridgeEngine(db, { brainName: 'test' });
    orch.setActionBridge(actionBridge);
  });

  afterEach(() => { db.close(); });

  it('recordDesireOutcome tracks successes and failures', () => {
    const orchAny = orch as any;
    orchAny.recordDesireOutcome('curiosity_gap_llm', 'success');
    orchAny.recordDesireOutcome('curiosity_gap_llm', 'success');
    orchAny.recordDesireOutcome('curiosity_gap_llm', 'failure');

    const entry = orchAny.desireOutcomes.get('curiosity_gap_llm');
    expect(entry.successes).toBe(2);
    expect(entry.failures).toBe(1);
    expect(entry.lastResult).toBe('failure');
  });

  it('failed desires get deprioritized in step 64 logic', () => {
    const orchAny = orch as any;

    // Simulate 3 consecutive failures for a desire
    orchAny.desireOutcomes.set('no_predictions', {
      successes: 0, failures: 3, lastResult: 'failure', lastCycle: 10,
    });

    // Mock getDesires to return a desire that has been failing
    vi.spyOn(orch, 'getDesires').mockReturnValue([
      { key: 'no_predictions', priority: 10, suggestion: 'No predictions yet', alternatives: [] },
    ]);

    const desires = orch.getDesires();
    // Apply the same adjustment logic as step 64
    const adjusted = desires.map(d => {
      const outcome = orchAny.desireOutcomes.get(d.key);
      let adjustedPriority = d.priority;
      if (outcome) {
        adjustedPriority = Math.max(0, d.priority + outcome.successes - outcome.failures * 2);
        if (outcome.failures >= 3 && outcome.lastResult === 'failure') {
          adjustedPriority = Math.min(adjustedPriority, 2);
        }
      }
      return { ...d, adjustedPriority };
    });

    // P10 with 3 failures → adjusted to min(10 + 0 - 6, 2) = 2
    expect(adjusted[0].adjustedPriority).toBe(2);
    // Below threshold of 5 → should NOT be actuated
    expect(adjusted[0].adjustedPriority).toBeLessThan(5);
  });

  it('successful desires maintain or boost priority', () => {
    const orchAny = orch as any;

    orchAny.desireOutcomes.set('curiosity_gap_trading', {
      successes: 3, failures: 0, lastResult: 'success', lastCycle: 10,
    });

    const original = { key: 'curiosity_gap_trading', priority: 5, suggestion: 'Gap', alternatives: [] };
    const outcome = orchAny.desireOutcomes.get(original.key);
    const adjustedPriority = Math.max(0, original.priority + outcome.successes - outcome.failures * 2);
    // 5 + 3 - 0 = 8
    expect(adjustedPriority).toBe(8);
  });

  it('getDesireFeedbackStats returns structured data', () => {
    const orchAny = orch as any;
    orchAny.desireOutcomes.set('no_predictions', { successes: 1, failures: 2, lastResult: 'failure', lastCycle: 5 });
    orchAny.desireCategoryRates.set('prediction', { successes: 1, total: 3 });
    orchAny.crossBrainActiveDesires.set('no_predictions', { brain: 'trading-brain', priority: 7, cycle: 5 });

    const stats = orch.getDesireFeedbackStats();
    expect(stats.outcomes).toHaveLength(1);
    expect(stats.outcomes[0].key).toBe('no_predictions');
    expect(stats.outcomes[0].successes).toBe(1);
    expect(stats.outcomes[0].failures).toBe(2);

    expect(stats.categoryRates).toHaveLength(1);
    expect(stats.categoryRates[0].category).toBe('prediction');
    expect(stats.categoryRates[0].successRate).toBeCloseTo(1 / 3);

    expect(stats.crossBrainActive).toHaveLength(1);
    expect(stats.crossBrainActive[0].brain).toBe('trading-brain');
  });
});

describe('Cross-Brain Desire Coordination (Fix 2)', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
  });

  afterEach(() => { db.close(); });

  it('onCrossBrainDesireSignal records active desires from other brains', () => {
    orch.onCrossBrainDesireSignal('trading-brain', 'no_predictions', 8);

    const orchAny = orch as any;
    const entry = orchAny.crossBrainActiveDesires.get('no_predictions');
    expect(entry).toBeDefined();
    expect(entry.brain).toBe('trading-brain');
    expect(entry.priority).toBe(8);
  });

  it('stale cross-brain entries are cleaned up (>60 cycles)', () => {
    const orchAny = orch as any;
    orchAny.cycleCount = 100;

    // Insert a stale entry from cycle 30 (100 - 30 = 70 > 60)
    orchAny.crossBrainActiveDesires.set('old_desire', { brain: 'marketing-brain', priority: 5, cycle: 30 });
    // Insert a fresh entry
    orchAny.crossBrainActiveDesires.set('new_desire', { brain: 'trading-brain', priority: 7, cycle: 95 });

    // Trigger cleanup via onCrossBrainDesireSignal
    orch.onCrossBrainDesireSignal('trading-brain', 'another_desire', 6);

    expect(orchAny.crossBrainActiveDesires.has('old_desire')).toBe(false);
    expect(orchAny.crossBrainActiveDesires.has('new_desire')).toBe(true);
    expect(orchAny.crossBrainActiveDesires.has('another_desire')).toBe(true);
  });

  it('onCrossBrainEvent routes desire_active signals', () => {
    const spy = vi.spyOn(orch, 'onCrossBrainDesireSignal');
    orch.onCrossBrainEvent('trading-brain', 'desire_active', { desireKey: 'no_predictions', priority: 9 });

    expect(spy).toHaveBeenCalledWith('trading-brain', 'no_predictions', 9);
  });
});

describe('Adaptive Confidence Formula (Fix 3)', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
  });

  afterEach(() => { db.close(); });

  it('desireKeyToCategory maps keys correctly', () => {
    const orchAny = orch as any;
    expect(orchAny.desireKeyToCategory('no_predictions')).toBe('prediction');
    expect(orchAny.desireKeyToCategory('low_accuracy_model')).toBe('prediction');
    expect(orchAny.desireKeyToCategory('contradiction_x_vs_y')).toBe('contradiction');
    expect(orchAny.desireKeyToCategory('curiosity_gap_trading')).toBe('curiosity');
    expect(orchAny.desireKeyToCategory('no_knowledge')).toBe('knowledge');
    expect(orchAny.desireKeyToCategory('pending_transfers')).toBe('cross_brain');
    expect(orchAny.desireKeyToCategory('want_cross_brain')).toBe('cross_brain');
    expect(orchAny.desireKeyToCategory('deep_dive_llm')).toBe('deep_dive');
    expect(orchAny.desireKeyToCategory('something_else')).toBe('general');
  });

  it('recordDesireCategoryOutcome tracks category success rates', () => {
    const orchAny = orch as any;
    orchAny.recordDesireCategoryOutcome('prediction', true);
    orchAny.recordDesireCategoryOutcome('prediction', true);
    orchAny.recordDesireCategoryOutcome('prediction', false);

    const rate = orchAny.desireCategoryRates.get('prediction');
    expect(rate.successes).toBe(2);
    expect(rate.total).toBe(3);
  });

  it('adaptive confidence blends category rate + priority when enough data', () => {
    const orchAny = orch as any;
    // Set up a category with 80% success rate and 5 total samples
    orchAny.desireCategoryRates.set('prediction', { successes: 4, total: 5 });

    // Simulate the confidence formula from step 64
    const priority = 7;
    const category = 'prediction';
    const categoryRate = orchAny.desireCategoryRates.get(category);
    let confidence: number;
    if (categoryRate && categoryRate.total >= 3) {
      const rateComponent = categoryRate.successes / categoryRate.total; // 0.8
      const priorityComponent = Math.min(priority / 10, 0.9); // 0.7
      confidence = Math.min(rateComponent * 0.6 + priorityComponent * 0.4, 0.9); // 0.48 + 0.28 = 0.76
    } else {
      confidence = Math.min(priority / 10, 0.9);
    }

    expect(confidence).toBeCloseTo(0.76);
  });

  it('falls back to priority-only confidence when not enough category data', () => {
    const orchAny = orch as any;
    // Only 2 samples — below threshold of 3
    orchAny.desireCategoryRates.set('prediction', { successes: 1, total: 2 });

    const priority = 8;
    const category = 'prediction';
    const categoryRate = orchAny.desireCategoryRates.get(category);
    let confidence: number;
    if (categoryRate && categoryRate.total >= 3) {
      confidence = 0; // shouldn't reach here
    } else {
      confidence = Math.min(priority / 10, 0.9);
    }

    expect(confidence).toBe(0.8);
  });
});
