import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MetaCognitionLayer } from '../../../src/metacognition/meta-cognition-layer.js';

describe('MetaCognitionLayer — Meta-Trends', () => {
  let db: Database.Database;
  let layer: MetaCognitionLayer;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    layer = new MetaCognitionLayer(db);
  });

  it('should create meta_trends table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'meta_trends'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('should record a trend entry', () => {
    layer.recordTrend(1, {
      newPrinciples: 3,
      newHypotheses: 5,
      predictionAccuracy: 0.72,
      closedGaps: 2,
      totalPrinciples: 10,
      totalHypotheses: 20,
      emergenceCount: 1,
    });

    const rows = db.prepare('SELECT * FROM meta_trends').all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].cycle).toBe(1);
    expect(rows[0].learning_rate).toBeCloseTo(3, 0); // 3/1 = 3
    expect(rows[0].discovery_rate).toBeCloseTo(5, 0); // 5/1 = 5
    expect(rows[0].total_principles).toBe(10);
    expect(rows[0].total_hypotheses).toBe(20);
    expect(rows[0].prediction_accuracy).toBeCloseTo(0.72, 2);
    expect(rows[0].emergence_count).toBe(1);
  });

  it('should return recent trend entries via getMetaTrend()', () => {
    for (let i = 1; i <= 5; i++) {
      layer.recordTrend(i, {
        newPrinciples: i,
        newHypotheses: i * 2,
        predictionAccuracy: 0.5 + i * 0.05,
        closedGaps: i,
        totalPrinciples: i * 3,
        totalHypotheses: i * 6,
        emergenceCount: 0,
      });
    }

    const trend = layer.getMetaTrend(3);
    expect(trend.length).toBe(3);
    // Should be in chronological order (reversed from DESC)
    expect(trend[0].cycle).toBeLessThan(trend[2].cycle);
  });

  it('should compute averages and direction in getLongTermAnalysis()', () => {
    // Record multiple trend points with increasing quality
    for (let i = 1; i <= 6; i++) {
      layer.recordTrend(i, {
        newPrinciples: i,
        newHypotheses: i * 2,
        predictionAccuracy: 0.5 + i * 0.05,
        closedGaps: i,
        totalPrinciples: i * 3,
        totalHypotheses: i * 6,
        emergenceCount: 0,
      });
    }

    const analysis = layer.getLongTermAnalysis(7);
    expect(analysis.days).toBe(7);
    expect(analysis.avgLearningRate).toBeGreaterThan(0);
    expect(analysis.avgDiscoveryRate).toBeGreaterThan(0);
    expect(analysis.avgKnowledgeQuality).toBeGreaterThanOrEqual(0);
    expect(analysis.peakLearningRate).toBeGreaterThan(0);
    expect(analysis.peakDiscoveryRate).toBeGreaterThan(0);
  });

  it('should return stagnating when no data', () => {
    const analysis = layer.getLongTermAnalysis(7);
    expect(analysis.trendDirection).toBe('stagnating');
    expect(analysis.avgLearningRate).toBe(0);
    expect(analysis.avgDiscoveryRate).toBe(0);
    expect(analysis.peakLearningRate).toBe(0);
  });

  it('should detect rising trend when second half has higher knowledge quality', () => {
    // First half: low quality
    for (let i = 1; i <= 3; i++) {
      layer.recordTrend(i, {
        newPrinciples: 1,
        newHypotheses: 2,
        predictionAccuracy: 0.1,
        closedGaps: 0,
        totalPrinciples: 2,
        totalHypotheses: 10,
        emergenceCount: 0,
      });
    }
    // Second half: much higher quality
    for (let i = 4; i <= 6; i++) {
      layer.recordTrend(i, {
        newPrinciples: 5,
        newHypotheses: 3,
        predictionAccuracy: 0.9,
        closedGaps: 3,
        totalPrinciples: 20,
        totalHypotheses: 10,
        emergenceCount: 2,
      });
    }

    const analysis = layer.getLongTermAnalysis(7);
    expect(analysis.trendDirection).toBe('rising');
  });

  it('should detect falling trend when second half has lower knowledge quality', () => {
    // First half: high quality
    for (let i = 1; i <= 3; i++) {
      layer.recordTrend(i, {
        newPrinciples: 5,
        newHypotheses: 3,
        predictionAccuracy: 0.9,
        closedGaps: 3,
        totalPrinciples: 20,
        totalHypotheses: 10,
        emergenceCount: 2,
      });
    }
    // Second half: low quality
    for (let i = 4; i <= 6; i++) {
      layer.recordTrend(i, {
        newPrinciples: 0,
        newHypotheses: 1,
        predictionAccuracy: 0.1,
        closedGaps: 0,
        totalPrinciples: 2,
        totalHypotheses: 10,
        emergenceCount: 0,
      });
    }

    const analysis = layer.getLongTermAnalysis(7);
    expect(analysis.trendDirection).toBe('falling');
  });

  it('should detect seasonal patterns from recorded trends', () => {
    // Record some trends
    for (let i = 1; i <= 5; i++) {
      layer.recordTrend(i, {
        newPrinciples: i,
        newHypotheses: i,
        predictionAccuracy: 0.5,
        closedGaps: 1,
        totalPrinciples: 5,
        totalHypotheses: 5,
        emergenceCount: 0,
      });
    }

    const patterns = layer.detectSeasonalPatterns();
    // Should return patterns for each metric (learning_rate, discovery_rate, etc.)
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) {
      expect(p.metric).toBeDefined();
      expect(typeof p.peakHour).toBe('number');
      expect(typeof p.peakDayOfWeek).toBe('number');
      expect(typeof p.avgAtPeak).toBe('number');
    }
  });

  it('should include latestTrend and trendDirection in getStatus()', () => {
    layer.recordTrend(1, {
      newPrinciples: 2,
      newHypotheses: 3,
      predictionAccuracy: 0.6,
      closedGaps: 1,
      totalPrinciples: 5,
      totalHypotheses: 8,
      emergenceCount: 0,
    });

    const status = layer.getStatus();
    expect(status.latestTrend).not.toBeNull();
    expect(status.latestTrend!.cycle).toBe(1);
    expect(status.latestTrend!.predictionAccuracy).toBeCloseTo(0.6, 2);
    expect(['rising', 'falling', 'stagnating']).toContain(status.trendDirection);
  });
});
