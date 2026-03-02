import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { HypothesisEngine } from '../../../src/hypothesis/engine.js';

describe('HypothesisEngine — Creative Hypotheses', () => {
  let db: Database.Database;
  let engine: HypothesisEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new HypothesisEngine(db);
  });

  it('should return empty array when no confirmed hypotheses exist', () => {
    const creative = engine.generateCreative(3);
    expect(creative).toEqual([]);
  });

  it('should generate creative hypotheses when confirmed hypotheses exist', () => {
    // First, create some confirmed hypotheses for the creative strategies to work with
    engine.propose({
      statement: 'Errors increase at night',
      type: 'temporal',
      source: 'hypothesis-engine',
      variables: ['errors'],
      condition: { type: 'temporal', params: { peakHour: 2 } },
    });
    // Manually set it to confirmed with high confidence
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.85 WHERE id = 1").run();

    // Add another confirmed hypothesis for combination strategy
    engine.propose({
      statement: 'CPU load correlates with response time',
      type: 'correlation',
      source: 'hypothesis-engine',
      variables: ['cpu_load', 'response_time'],
      condition: { type: 'correlation', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.9 WHERE id = 2").run();

    // Also add some observations for the random walk strategy
    engine.observe({ source: 'brain', type: 'errors', value: 5, timestamp: Date.now() });
    engine.observe({ source: 'brain', type: 'cpu_load', value: 80, timestamp: Date.now() });

    const creative = engine.generateCreative(5);
    // At least some should be generated (inversion, combination, analogy, negation, random_walk)
    expect(creative.length).toBeGreaterThan(0);
  });

  it('should assign creative source prefixes', () => {
    // Set up confirmed hypothesis
    engine.propose({
      statement: 'Latency spikes during deploys',
      type: 'temporal',
      source: 'hypothesis-engine',
      variables: ['latency'],
      condition: { type: 'temporal', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.8 WHERE id = 1").run();

    const creative = engine.generateCreative(3);
    for (const h of creative) {
      expect(h.source).toMatch(/^creative_/);
    }
  });

  it('should assign type "creative" to generated hypotheses', () => {
    engine.propose({
      statement: 'Memory usage grows linearly',
      type: 'threshold',
      source: 'hypothesis-engine',
      variables: ['memory'],
      condition: { type: 'threshold', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.75 WHERE id = 1").run();

    const creative = engine.generateCreative(2);
    for (const h of creative) {
      expect(h.type).toBe('creative');
    }
  });

  it('should return correct counts from getCreativeStats()', () => {
    // Insert confirmed hypotheses first
    engine.propose({
      statement: 'Errors spike during peak hours',
      type: 'temporal',
      source: 'hypothesis-engine',
      variables: ['errors'],
      condition: { type: 'temporal', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.9 WHERE id = 1").run();

    engine.propose({
      statement: 'High CPU means slow response',
      type: 'correlation',
      source: 'hypothesis-engine',
      variables: ['cpu'],
      condition: { type: 'correlation', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.85 WHERE id = 2").run();

    // Generate creative hypotheses
    engine.generateCreative(3);

    const stats = engine.getCreativeStats();
    expect(stats.total).toBeGreaterThan(0);
    // All should be in pending state (proposed)
    expect(stats.confirmed).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.pendingRate).toBeGreaterThan(0);
  });

  it('should limit to count parameter', () => {
    // Create two confirmed hypotheses
    engine.propose({
      statement: 'A is true',
      type: 'temporal',
      source: 'hypothesis-engine',
      variables: ['a'],
      condition: { type: 'temporal', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.9 WHERE id = 1").run();

    engine.propose({
      statement: 'B is also true',
      type: 'correlation',
      source: 'hypothesis-engine',
      variables: ['b'],
      condition: { type: 'correlation', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.8 WHERE id = 2").run();

    engine.observe({ source: 'brain', type: 'typeA', value: 1, timestamp: Date.now() });
    engine.observe({ source: 'brain', type: 'typeB', value: 2, timestamp: Date.now() });

    const one = engine.generateCreative(1);
    expect(one.length).toBeLessThanOrEqual(1);

    const five = engine.generateCreative(5);
    expect(five.length).toBeLessThanOrEqual(5);
  });

  it('should not generate duplicate creative hypotheses', () => {
    engine.propose({
      statement: 'Test principle for inversion',
      type: 'temporal',
      source: 'hypothesis-engine',
      variables: ['test'],
      condition: { type: 'temporal', params: {} },
    });
    db.prepare("UPDATE hypotheses SET status = 'confirmed', confidence = 0.9 WHERE id = 1").run();

    // Generate twice
    const first = engine.generateCreative(3);
    const second = engine.generateCreative(3);

    // The second batch should not include duplicates of the first
    // (due to existing-check in each strategy)
    const allStatements = [...first, ...second].map(h => h.statement);
    const uniqueStatements = new Set(allStatements);
    expect(uniqueStatements.size).toBe(allStatements.length);
  });

  it('should return zero stats on fresh DB', () => {
    const stats = engine.getCreativeStats();
    expect(stats.total).toBe(0);
    expect(stats.confirmed).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.pendingRate).toBe(0);
  });
});
