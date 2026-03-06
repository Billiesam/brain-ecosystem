import { describe, it, expect } from 'vitest';
import { computeAdaptiveThresholds, computeConfidence, timeDecayedConfidence } from '../confidence-scorer.js';

describe('computeAdaptiveThresholds', () => {
  const baseConfig = {
    minOccurrences: 3,
    minSuccessRate: 0.70,
    minConfidence: 0.60,
    pruneThreshold: 0.30,
  };

  it('should not scale minOccurrences above cap of 1.5x', () => {
    // With 200 errors and 100 solutions, errorScale = min(1.5, 200/100) = 1.5
    // solutionScale = min(1.5, 100/20) = 1.5
    // dataScale = 1.5
    const result = computeAdaptiveThresholds(200, 100, baseConfig);

    // minOccurrences = round(3 * 1.5) = 5 (not 6+ with old cap of 2.0)
    expect(result.minOccurrences).toBeLessThanOrEqual(5);
  });

  it('should keep minOccurrences low with small datasets', () => {
    // With 10 errors and 5 solutions
    const result = computeAdaptiveThresholds(10, 5, baseConfig);

    // errorScale = min(1.5, max(0.5, 10/100)) = 0.5
    // solutionScale = min(1.5, max(0.5, 5/20)) = 0.5
    // dataScale = 0.5
    // minOccurrences = max(2, round(3 * 0.5)) = 2
    expect(result.minOccurrences).toBe(2);
  });

  it('should produce reasonable thresholds for moderate data', () => {
    // 50 errors, 20 solutions → errorScale = 0.5, solutionScale = 1.0, dataScale = 0.75
    const result = computeAdaptiveThresholds(50, 20, baseConfig);

    expect(result.minOccurrences).toBeGreaterThanOrEqual(2);
    expect(result.minOccurrences).toBeLessThanOrEqual(4);
    expect(result.minSuccessRate).toBeGreaterThan(0.60);
    expect(result.minSuccessRate).toBeLessThan(0.95);
    expect(result.minConfidence).toBeGreaterThan(0.50);
    expect(result.minConfidence).toBeLessThan(0.90);
  });

  it('should cap errorScale at 1.5 instead of 2.0', () => {
    // Very large dataset: 500 errors
    const result = computeAdaptiveThresholds(500, 100, baseConfig);

    // errorScale = min(1.5, 500/100) = 1.5, not 2.0
    // solutionScale = min(1.5, 100/20) = 1.5
    // dataScale = 1.5
    expect(result.minOccurrences).toBeLessThanOrEqual(5);
  });

  it('should use divisor of 100 for errorScale', () => {
    // At exactly 100 errors, errorScale should be 1.0
    const result = computeAdaptiveThresholds(100, 20, baseConfig);

    // errorScale = min(1.5, max(0.5, 100/100)) = 1.0
    // solutionScale = min(1.5, max(0.5, 20/20)) = 1.0
    // dataScale = 1.0
    // minOccurrences = round(3 * 1.0) = 3
    expect(result.minOccurrences).toBe(3);
  });
});

describe('computeConfidence', () => {
  it('should return 0 with no data', () => {
    expect(computeConfidence(0, 0, new Date().toISOString())).toBe(0);
  });

  it('should return higher confidence for more successes', () => {
    const now = new Date().toISOString();
    const low = computeConfidence(2, 8, now);
    const high = computeConfidence(8, 2, now);
    expect(high).toBeGreaterThan(low);
  });
});

describe('timeDecayedConfidence', () => {
  it('should decay confidence over time', () => {
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 60 * 86400000).toISOString(); // 60 days ago

    const recentConf = timeDecayedConfidence(8, 10, recent, 30);
    const oldConf = timeDecayedConfidence(8, 10, old, 30);

    expect(recentConf).toBeGreaterThan(oldConf);
  });
});
