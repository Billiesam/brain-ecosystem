import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CuriosityEngine } from '../../../src/curiosity/curiosity-engine.js';

describe('BlindSpotDetector', () => {
  let db: Database.Database;
  let engine: CuriosityEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new CuriosityEngine(db, { brainName: 'test-brain' });
  });

  it('should create blind_spots table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'blind_spots'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
    expect(tables[0].name).toBe('blind_spots');
  });

  it('should return empty array on fresh DB with no data sources', () => {
    const spots = engine.detectBlindSpots();
    expect(spots).toEqual([]);
  });

  it('should detect blind spots when topics have low coverage', () => {
    // Attention provides topics; all other sources return minimal data
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'anomalies', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
        { topic: 'latency', score: 8, recency: 0.8, frequency: 3, impact: 1, urgency: 0, lastSeen: Date.now() },
      ],
    };

    // Hypothesis engine returns nothing relevant -> coverage = 0 everywhere
    const mockHypothesis = {
      list: () => [],
    };

    engine.setDataSources({
      attentionEngine: mockAttention as never,
      hypothesisEngine: mockHypothesis as never,
    });

    const spots = engine.detectBlindSpots();
    // With zero coverage everywhere, severity = 1 - 0 = 1.0 > 0.7 threshold
    expect(spots.length).toBeGreaterThan(0);
    expect(spots[0].severity).toBeGreaterThan(0.7);
    expect(spots[0].hypothesisCount).toBe(0);
    expect(spots[0].predictionCount).toBe(0);
    expect(spots[0].journalCount).toBe(0);
    expect(spots[0].experimentCount).toBe(0);
  });

  it('should not detect blind spots when topics have high coverage', () => {
    const mockAttention = {
      getTopTopics: () => [
        { topic: 'errors', score: 10, recency: 1, frequency: 5, impact: 2, urgency: 0, lastSeen: Date.now() },
      ],
    };

    // All sources return many matching entries
    const mockHypothesis = {
      list: () => [
        { statement: 'errors increase at night', confidence: 0.9, status: 'confirmed', variables: [] },
        { statement: 'errors correlate with CPU', confidence: 0.8, status: 'confirmed', variables: [] },
        { statement: 'errors spike during deploy', confidence: 0.7, status: 'testing', variables: [] },
        { statement: 'errors are random', confidence: 0.3, status: 'rejected', variables: [] },
      ],
    };
    const mockNarrative = {
      explain: () => ({ sources: ['a', 'b', 'c', 'd'] }),
    };
    const mockExperiment = {
      list: () => [
        { name: 'errors threshold test', hypothesis: 'errors' },
        { name: 'errors timing', hypothesis: 'errors' },
      ],
    };

    engine.setDataSources({
      attentionEngine: mockAttention as never,
      hypothesisEngine: mockHypothesis as never,
      narrativeEngine: mockNarrative as never,
      experimentEngine: mockExperiment as never,
    });

    const spots = engine.detectBlindSpots();
    // High coverage in all dimensions -> severity low -> no blind spots
    expect(spots.length).toBe(0);
  });

  it('should return correct limit from getBlindSpots()', () => {
    // Insert several blind spots directly
    for (let i = 0; i < 5; i++) {
      db.prepare(
        'INSERT INTO blind_spots (topic, hypothesis_count, prediction_count, journal_count, experiment_count, severity) VALUES (?, 0, 0, 0, 0, ?)',
      ).run(`topic-${i}`, 0.9 - i * 0.01);
    }

    const all = engine.getBlindSpots(10);
    expect(all.length).toBe(5);

    const limited = engine.getBlindSpots(2);
    expect(limited.length).toBe(2);
    // Should be sorted by severity DESC
    expect(limited[0].severity).toBeGreaterThanOrEqual(limited[1].severity);
  });

  it('should resolve a blind spot', () => {
    db.prepare(
      'INSERT INTO blind_spots (topic, hypothesis_count, prediction_count, journal_count, experiment_count, severity) VALUES (?, 0, 0, 0, 0, 0.95)',
    ).run('test-topic');

    const spots = engine.getBlindSpots(10);
    expect(spots.length).toBe(1);

    const result = engine.resolveBlindSpot(spots[0].id!);
    expect(result).toBe(true);

    // After resolving, getBlindSpots should return empty (resolved_at IS NOT NULL)
    const remaining = engine.getBlindSpots(10);
    expect(remaining.length).toBe(0);
  });

  it('should return false when resolving non-existent blind spot', () => {
    const result = engine.resolveBlindSpot(999);
    expect(result).toBe(false);
  });

  it('should include blindSpots count in getStatus()', () => {
    // Insert some blind spots
    db.prepare(
      'INSERT INTO blind_spots (topic, hypothesis_count, prediction_count, journal_count, experiment_count, severity) VALUES (?, 0, 0, 0, 0, 0.9)',
    ).run('spot-a');
    db.prepare(
      'INSERT INTO blind_spots (topic, hypothesis_count, prediction_count, journal_count, experiment_count, severity) VALUES (?, 0, 0, 0, 0, 0.85)',
    ).run('spot-b');

    const status = engine.getStatus();
    expect(status.blindSpots).toBe(2);
    expect(status.topBlindSpots.length).toBe(2);
    expect(status.topBlindSpots[0].severity).toBeGreaterThanOrEqual(status.topBlindSpots[1].severity);
  });

  it('should handle missing data sources gracefully in detectBlindSpots()', () => {
    // No data sources set at all
    // gatherTopics returns empty -> no topics to check -> empty result
    const spots = engine.detectBlindSpots();
    expect(spots).toEqual([]);
    // No errors thrown
  });
});
