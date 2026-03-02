import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CuriosityEngine } from '../../../src/curiosity/curiosity-engine.js';

describe('CuriosityEngine', () => {
  let db: Database.Database;
  let engine: CuriosityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new CuriosityEngine(db, { brainName: 'test-brain' });
  });

  it('should create tables on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'curiosity%'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('curiosity_gaps');
    expect(names).toContain('curiosity_questions');
    expect(names).toContain('curiosity_explorations');
  });

  it('should return empty gaps with no data sources', () => {
    const gaps = engine.detectGaps();
    expect(gaps).toEqual([]);
  });

  it('should return empty status initially', () => {
    const status = engine.getStatus();
    expect(status.totalGaps).toBe(0);
    expect(status.activeGaps).toBe(0);
    expect(status.totalQuestions).toBe(0);
    expect(status.unansweredQuestions).toBe(0);
    expect(status.totalExplorations).toBe(0);
    expect(status.explorationRate).toBe(0);
    expect(status.topGaps).toHaveLength(0);
    expect(status.topArms).toHaveLength(0);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should return null for selectTopic with no data', () => {
    const decision = engine.selectTopic();
    expect(decision).toBeNull();
  });

  it('should detect gaps when attention is high and knowledge is low', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'anomalies', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
        { topic: 'memory', score: 8, recency: 0.8, frequency: 3, impact: 1, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });

    // With no knowledge sources → knowledge score = 0 → dark_zone
    // gapScore = attention * (1 - 0) = attention
    const gaps = engine.detectGaps();
    expect(gaps.length).toBeGreaterThan(0);

    const topGap = gaps[0];
    expect(topGap.topic).toBe('anomalies');
    expect(topGap.gapType).toBe('dark_zone');
    expect(topGap.gapScore).toBeGreaterThan(0);
    expect(topGap.questions.length).toBeGreaterThan(0);
    expect(topGap.addressedAt).toBeNull();
  });

  it('should generate questions for detected gaps', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'errors', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps(); // Creates gaps + questions

    const questions = engine.getQuestions(20);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions[0].topic).toBe('errors');
    expect(questions[0].answered).toBe(false);
    expect(questions[0].answer).toBeNull();
  });

  it('should answer a question', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'crashes', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps();
    const questions = engine.getQuestions(20);
    expect(questions.length).toBeGreaterThan(0);

    const q = questions[0];
    const result = engine.answerQuestion(q.id!, 'Crashes happen due to memory leaks');
    expect(result).toBe(true);
  });

  it('should record outcomes and update bandit arms', () => {
    engine.recordOutcome('errors', 'explore', 0.8, 'test context');
    engine.recordOutcome('errors', 'explore', 0.6, 'test 2');
    engine.recordOutcome('trading', 'exploit', 0.9, 'test 3');

    const arms = engine.getArms();
    expect(arms.length).toBe(2);

    const errorsArm = arms.find(a => a.topic === 'errors');
    expect(errorsArm).toBeDefined();
    expect(errorsArm!.pulls).toBe(2);
    expect(errorsArm!.averageReward).toBeCloseTo(0.7, 1);

    const tradingArm = arms.find(a => a.topic === 'trading');
    expect(tradingArm).toBeDefined();
    expect(tradingArm!.pulls).toBe(1);
    expect(tradingArm!.averageReward).toBeCloseTo(0.9, 1);
  });

  it('should clamp reward between 0 and 1', () => {
    engine.recordOutcome('test', 'explore', 5.0, ''); // > 1
    engine.recordOutcome('test', 'explore', -2.0, ''); // < 0

    const arms = engine.getArms();
    const arm = arms.find(a => a.topic === 'test');
    expect(arm).toBeDefined();
    expect(arm!.averageReward).toBeCloseTo(0.5, 1); // (1.0 + 0.0) / 2
  });

  it('should select topic via UCB1 bandit', () => {
    // Record some outcomes to create arms
    engine.recordOutcome('errors', 'explore', 0.8, '');
    engine.recordOutcome('errors', 'explore', 0.7, '');
    engine.recordOutcome('trading', 'explore', 0.3, '');

    // Add a gap for a new topic
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'newTopic', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };
    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps();

    const decision = engine.selectTopic();
    expect(decision).not.toBeNull();
    expect(decision!.topic).toBeDefined();
    expect(decision!.action).toMatch(/^(explore|exploit)$/);
    expect(decision!.suggestedActions.length).toBeGreaterThan(0);
    expect(decision!.reason).toBeDefined();
  });

  it('should prefer unexplored topics (UCB1 = infinity)', () => {
    // Record an arm with known reward
    engine.recordOutcome('known', 'exploit', 0.5, '');

    // Add a gap for a new untried topic
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'unknown', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };
    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps();

    const decision = engine.selectTopic();
    expect(decision).not.toBeNull();
    // Unexplored topic should win — its UCB is infinity
    expect(decision!.topic).toBe('unknown');
    expect(decision!.action).toBe('explore');
  });

  it('should detect surprises from low-confidence confirmed hypotheses', () => {
    const mockHypothesis = {
      list: (status?: string) => {
        if (status === 'confirmed') {
          return [{ statement: 'Errors decrease on weekends', confidence: 0.1, status: 'confirmed', variables: [] }];
        }
        if (status === 'rejected') {
          return [{ statement: 'High CPU always causes errors', confidence: 0.9, status: 'rejected', variables: [] }];
        }
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockHypothesis as never });
    const surprises = engine.detectSurprises();

    expect(surprises.length).toBe(2);
    // Low confidence confirmed → surprise
    expect(surprises.some(s => s.topic.includes('weekends'))).toBe(true);
    // High confidence rejected → surprise
    expect(surprises.some(s => s.topic.includes('CPU'))).toBe(true);
  });

  it('should detect surprises from experiments with large effects', () => {
    const mockExperiments = {
      list: () => [
        {
          name: 'Z-threshold test',
          hypothesis: 'Changing Z affects anomalies',
          conclusion: { significant: true, effect_size: 1.5, p_value: 0.001 },
        },
      ],
    };

    engine.setDataSources({ experimentEngine: mockExperiments as never });
    const surprises = engine.detectSurprises();

    expect(surprises.length).toBe(1);
    expect(surprises[0].topic).toBe('Z-threshold test');
    expect(surprises[0].deviation).toBeCloseTo(1.0, 1);
  });

  it('should store explorations', () => {
    engine.recordOutcome('a', 'explore', 0.5, 'first');
    engine.recordOutcome('b', 'exploit', 0.8, 'second');
    engine.recordOutcome('c', 'explore', 0.3, 'third');

    const explorations = engine.getExplorations(10);
    expect(explorations.length).toBe(3);
    const topics = explorations.map(e => e.topic);
    expect(topics).toContain('a');
    expect(topics).toContain('b');
    expect(topics).toContain('c');
  });

  it('should generate questions via detectGaps', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'bugs', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps(); // Creates gap + persists questions

    const questions = engine.getQuestions(20);
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.topic).toBe('bugs');
      expect(q.questionType).toMatch(/^(what|why|how|correlation|prediction|comparison)$/);
    }
  });

  it('should update gap exploration count on recordOutcome', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'performance', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps();

    const gapsBefore = engine.getGaps(10);
    const perfGap = gapsBefore.find(g => g.topic === 'performance');
    expect(perfGap).toBeDefined();
    expect(perfGap!.explorationCount).toBe(0);

    engine.recordOutcome('performance', 'explore', 0.5, 'exploring');
    const gapsAfter = engine.getGaps(10);
    const updatedGap = gapsAfter.find(g => g.topic === 'performance');
    expect(updatedGap).toBeDefined();
    expect(updatedGap!.explorationCount).toBe(1);
  });

  it('should mark gap as addressed when reward is high', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'resolved', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps();

    // High reward → addressed
    engine.recordOutcome('resolved', 'explore', 0.9, 'fully explored');

    // Gap should be addressed (no longer active)
    const activeGaps = engine.getGaps(10);
    const resolvedGap = activeGaps.find(g => g.topic === 'resolved');
    expect(resolvedGap).toBeUndefined(); // addressed_at is set → filtered out

    const status = engine.getStatus();
    expect(status.totalGaps).toBe(1); // Exists but addressed
    expect(status.activeGaps).toBe(0);
  });

  it('should correctly classify gap types', () => {
    // With no knowledge at all → dark_zone
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'unknownArea', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    const gaps = engine.detectGaps();
    expect(gaps[0].gapType).toBe('dark_zone');
  });

  it('should get specific gap by id', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'testGap', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    engine.setDataSources({ attentionEngine: mockAttention as never });
    engine.detectGaps();

    const gaps = engine.getGaps(10);
    expect(gaps.length).toBeGreaterThan(0);

    const gap = engine.getGap(gaps[0].id!);
    expect(gap).not.toBeNull();
    expect(gap!.topic).toBe('testgap'); // Topics are lowercased
  });

  it('should return null for non-existent gap', () => {
    const gap = engine.getGap(999);
    expect(gap).toBeNull();
  });
});
