import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { FeedbackEngine, runFeedbackMigration } from '../feedback-engine.js';

// ── Helpers ──────────────────────────────────────────────────

function createTestDb(): Database.Database {
  return new Database(':memory:');
}

// ── Tests ───────────────────────────────────────────────────

describe('FeedbackEngine', () => {
  let db: Database.Database;
  let engine: FeedbackEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new FeedbackEngine(db, { brainName: 'test' });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('creates feedback tables on migration', () => {
    const signalTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_signals'").all();
    const correctionTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_corrections'").all();
    expect(signalTable).toHaveLength(1);
    expect(correctionTable).toHaveLength(1);
  });

  it('migration is idempotent', () => {
    runFeedbackMigration(db);
    runFeedbackMigration(db);
    const signalTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_signals'").all();
    expect(signalTable).toHaveLength(1);
  });

  it('records positive feedback', () => {
    const record = engine.recordFeedback('insight', 1, 'positive', 'Great insight');
    expect(record.signal).toBe('positive');
    expect(record.reward_score).toBe(1.0);
    expect(record.target_type).toBe('insight');
    expect(record.target_id).toBe(1);
    expect(record.detail).toBe('Great insight');
  });

  it('records negative feedback', () => {
    const record = engine.recordFeedback('prediction', 2, 'negative', 'Incorrect prediction');
    expect(record.signal).toBe('negative');
    expect(record.reward_score).toBe(-1.0);
  });

  it('records correction feedback', () => {
    const record = engine.recordFeedback('rule', 3, 'correction');
    expect(record.signal).toBe('correction');
    expect(record.reward_score).toBe(-0.5);
    expect(record.detail).toBeNull();
  });

  it('calculates reward score from multiple signals', () => {
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'negative');

    const score = engine.getRewardScore('insight', 1);
    // (1 + 1 + -1) / 3 = 0.333...
    expect(score).toBeCloseTo(1 / 3, 2);
  });

  it('clamps reward score to [-1, 1]', () => {
    // All positive -> should be exactly 1.0
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'positive');

    const positiveScore = engine.getRewardScore('insight', 1);
    expect(positiveScore).toBe(1.0);

    // All negative -> should be exactly -1.0
    engine.recordFeedback('prediction', 2, 'negative');
    engine.recordFeedback('prediction', 2, 'negative');

    const negativeScore = engine.getRewardScore('prediction', 2);
    expect(negativeScore).toBe(-1.0);
  });

  it('returns 0 for target with no feedback', () => {
    const score = engine.getRewardScore('nonexistent', 999);
    expect(score).toBe(0);
  });

  it('learns from correction', () => {
    const correction = engine.learnFromCorrection(
      'X causes Y', 'X correlates with Y', 'fact', 10
    );
    expect(correction.original).toBe('X causes Y');
    expect(correction.correction).toBe('X correlates with Y');
    expect(correction.target_type).toBe('fact');
    expect(correction.target_id).toBe(10);
    expect(correction.applied).toBe(0);

    // Should also have created a correction feedback signal
    const history = engine.getFeedbackHistory('fact', 10);
    expect(history).toHaveLength(1);
    expect(history[0]!.signal).toBe('correction');
  });

  it('returns correct stats', () => {
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 2, 'positive');
    engine.recordFeedback('prediction', 1, 'negative');
    engine.recordFeedback('rule', 1, 'correction');

    const stats = engine.getStats();
    expect(stats.totalFeedback).toBe(4);
    expect(stats.positiveCount).toBe(2);
    expect(stats.negativeCount).toBe(1);
    expect(stats.correctionCount).toBe(1);
    // avg: (1 + 1 + -1 + -0.5) / 4 = 0.125
    expect(stats.avgRewardScore).toBeCloseTo(0.125, 2);
  });

  it('returns feedback history for a target', () => {
    engine.recordFeedback('insight', 1, 'positive', 'good');
    engine.recordFeedback('insight', 1, 'negative', 'bad');
    engine.recordFeedback('insight', 1, 'positive', 'better');
    engine.recordFeedback('insight', 2, 'positive', 'other target');

    const history = engine.getFeedbackHistory('insight', 1);
    expect(history).toHaveLength(3);
    // Should not include target_id=2
    expect(history.every(h => h.target_id === 1)).toBe(true);
  });

  it('limits feedback history results', () => {
    for (let i = 0; i < 10; i++) {
      engine.recordFeedback('insight', 1, 'positive', `feedback ${i}`);
    }

    const history = engine.getFeedbackHistory('insight', 1, 5);
    expect(history).toHaveLength(5);
  });

  it('handles multiple signals for same target in reward calculation', () => {
    // 3 positive, 2 negative, 1 correction
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('insight', 1, 'negative');
    engine.recordFeedback('insight', 1, 'negative');
    engine.recordFeedback('insight', 1, 'correction');

    const score = engine.getRewardScore('insight', 1);
    // (3*1 + 2*-1 + 1*-0.5) / 6 = 0.5 / 6 = 0.0833...
    expect(score).toBeCloseTo(0.5 / 6, 2);
  });

  it('calls synapse manager strengthen/weaken in applyRewards', () => {
    const mockSynapseManager = {
      strengthen: vi.fn(),
      weaken: vi.fn(),
      find: vi.fn().mockReturnValue({ id: 1, weight: 0.5 }),
    } as any;

    engine.recordFeedback('insight', 1, 'positive');
    engine.recordFeedback('prediction', 2, 'negative');

    engine.applyRewards(mockSynapseManager);

    expect(mockSynapseManager.strengthen).toHaveBeenCalled();
    expect(mockSynapseManager.find).toHaveBeenCalled();
    expect(mockSynapseManager.weaken).toHaveBeenCalled();
  });

  it('skips applyRewards without synapse manager', () => {
    engine.recordFeedback('insight', 1, 'positive');
    // Should not throw
    expect(() => engine.applyRewards()).not.toThrow();
  });
});
