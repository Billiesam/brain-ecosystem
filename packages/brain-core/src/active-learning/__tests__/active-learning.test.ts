import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ActiveLearner, runActiveLearningMigration } from '../active-learner.js';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('ActiveLearner', () => {
  let db: Database.Database;
  let learner: ActiveLearner;

  beforeEach(() => {
    db = new Database(':memory:');
    learner = new ActiveLearner(db, { brainName: 'brain' });
  });

  afterEach(() => {
    db.close();
  });

  it('addGap creates a learning gap', () => {
    const gap = learner.addGap('knowledge_void', 'quantum computing', 'No data on quantum algorithms', 0.8, 0.3);

    expect(gap.id).toBeDefined();
    expect(gap.gapType).toBe('knowledge_void');
    expect(gap.topic).toBe('quantum computing');
    expect(gap.description).toBe('No data on quantum algorithms');
    expect(gap.impact).toBe(0.8);
    expect(gap.ease).toBe(0.3);
    expect(gap.status).toBe('open');
  });

  it('getOpenGaps returns gaps sorted by priority', () => {
    learner.addGap('knowledge_void', 'topic-a', undefined, 0.9, 0.9); // priority = 0.81
    learner.addGap('low_confidence', 'topic-b', undefined, 0.5, 0.5); // priority = 0.25
    learner.addGap('unanswered', 'topic-c', undefined, 0.8, 0.7); // priority = 0.56

    const gaps = learner.getOpenGaps();
    expect(gaps.length).toBe(3);
    // Sorted by impact * ease descending
    expect(gaps[0].topic).toBe('topic-a');
    expect(gaps[1].topic).toBe('topic-c');
    expect(gaps[2].topic).toBe('topic-b');
  });

  it('planLearning selects strategy based on gap type', () => {
    const voidGap = learner.addGap('knowledge_void', 'void-topic');
    const lowConf = learner.addGap('low_confidence', 'low-conf-topic');
    const unanswered = learner.addGap('unanswered', 'unanswered-topic');
    const crossBrain = learner.addGap('cross_brain', 'cross-topic');

    expect(learner.planLearning(voidGap.id!)!.strategy).toBe('research_mission');
    expect(learner.planLearning(lowConf.id!)!.strategy).toBe('experiment');
    expect(learner.planLearning(unanswered.id!)!.strategy).toBe('ask_user');
    expect(learner.planLearning(crossBrain.id!)!.strategy).toBe('teach_request');
  });

  it('prioritize sorts gaps by impact * ease descending', () => {
    const gaps = [
      { gapType: 'knowledge_void' as const, topic: 'a', impact: 0.3, ease: 0.3, status: 'open' as const },
      { gapType: 'low_confidence' as const, topic: 'b', impact: 0.9, ease: 0.9, status: 'open' as const },
      { gapType: 'unanswered' as const, topic: 'c', impact: 0.5, ease: 0.8, status: 'open' as const },
    ];

    const sorted = learner.prioritize(gaps);
    expect(sorted[0].topic).toBe('b'); // 0.81
    expect(sorted[1].topic).toBe('c'); // 0.40
    expect(sorted[2].topic).toBe('a'); // 0.09
  });

  it('closeGap records outcome and marks closed', () => {
    const gap = learner.addGap('knowledge_void', 'test-close');
    learner.planLearning(gap.id!);

    const closed = learner.closeGap(gap.id!, 'success');
    expect(closed).toBe(true);

    // Verify it's no longer in open gaps
    const openGaps = learner.getOpenGaps();
    const found = openGaps.find(g => g.id === gap.id);
    expect(found).toBeUndefined();
  });

  it('strategy success tracking in getStatus', () => {
    const g1 = learner.addGap('knowledge_void', 'g1');
    const g2 = learner.addGap('low_confidence', 'g2');
    const g3 = learner.addGap('unanswered', 'g3');

    learner.planLearning(g1.id!);
    learner.planLearning(g2.id!);
    learner.planLearning(g3.id!);

    learner.closeGap(g1.id!, 'success');
    learner.closeGap(g2.id!, 'failure');
    learner.closeGap(g3.id!, 'success');

    const status = learner.getStatus();
    // 3 plan strategies (pending) + 3 close strategies = 6 total
    // 2 success out of 6
    expect(status.strategySuccessRate).toBeCloseTo(2 / 6, 2);
  });

  it('identifyGaps returns empty for no sources', () => {
    const gaps = learner.identifyGaps();
    expect(gaps).toEqual([]);
  });

  it('identifyGaps finds gaps from sources', () => {
    const gaps = learner.identifyGaps({
      knowledgeVoids: [{ topic: 'blockchain', description: 'No data' }],
      lowConfidenceFacts: [{ topic: 'AI safety', confidence: 0.1 }],
      ragMisses: [{ query: 'quantum entanglement' }],
    });

    expect(gaps.length).toBe(3);
    expect(gaps[0].gapType).toBe('knowledge_void');
    expect(gaps[1].gapType).toBe('low_confidence');
    expect(gaps[2].gapType).toBe('unanswered');
  });

  it('gap limit enforcement', () => {
    const smallLearner = new ActiveLearner(db, { brainName: 'brain', maxOpenGaps: 3 });

    smallLearner.addGap('knowledge_void', 'g1');
    smallLearner.addGap('knowledge_void', 'g2');
    smallLearner.addGap('knowledge_void', 'g3');

    expect(() => smallLearner.addGap('knowledge_void', 'g4'))
      .toThrow(/Maximum open gaps/);
  });

  it('migration is idempotent', () => {
    runActiveLearningMigration(db);
    runActiveLearningMigration(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'learning%'")
      .all();
    expect(tables.length).toBe(2); // learning_gaps + learning_strategies
  });

  it('getStatus returns correct summary', () => {
    learner.addGap('knowledge_void', 'open-gap');
    const g2 = learner.addGap('low_confidence', 'to-close');
    learner.planLearning(g2.id!);
    learner.closeGap(g2.id!, 'success');

    const status = learner.getStatus();
    expect(status.totalGaps).toBe(2);
    expect(status.openGaps).toBe(1);
    expect(status.closedGaps).toBe(1);
    expect(status.strategySuccessRate).toBeGreaterThan(0);
  });
});
