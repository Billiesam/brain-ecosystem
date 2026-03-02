import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SimulationEngine } from '../../../src/metacognition/simulation-engine.js';

describe('SimulationEngine', () => {
  let db: Database.Database;
  let engine: SimulationEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    engine = new SimulationEngine(db);
  });

  it('should create simulations table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'simulations'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('simulate() creates a simulation', () => {
    const sim = engine.simulate('error_rate doubles');
    expect(sim.id).toBeDefined();
    expect(sim.scenario).toBe('error_rate doubles');
    expect(sim.predictedOutcomes.length).toBeGreaterThan(0);
    expect(sim.actualOutcomes).toBeNull();
    expect(sim.accuracy).toBeNull();
  });

  it('simulate() parses scenario strings', () => {
    // "doubles" => multiplier 2
    const sim1 = engine.simulate('error_rate doubles');
    const directOutcome = sim1.predictedOutcomes.find(o => o.metric === 'error_rate');
    expect(directOutcome).toBeDefined();
    expect(directOutcome!.direction).toBe('increase');
    expect(directOutcome!.predicted).toBeGreaterThan(1);

    // "halves" => multiplier 0.5
    const sim2 = engine.simulate('latency halves');
    const halvedOutcome = sim2.predictedOutcomes.find(o => o.metric === 'latency');
    expect(halvedOutcome).toBeDefined();
    expect(halvedOutcome!.direction).toBe('decrease');

    // "increases by 50%" => multiplier 1.5
    const sim3 = engine.simulate('throughput increases by 50%');
    const increasedOutcome = sim3.predictedOutcomes.find(o => o.metric === 'throughput');
    expect(increasedOutcome).toBeDefined();
    expect(increasedOutcome!.direction).toBe('increase');
    expect(increasedOutcome!.predicted).toBeCloseTo(1.5, 1);
  });

  it('whatIf() is a shortcut for simulate', () => {
    const sim = engine.whatIf('error_rate', 2);
    expect(sim.id).toBeDefined();
    expect(sim.scenario).toContain('error_rate');
    expect(sim.scenario).toContain('increases by 100%');
    expect(sim.predictedOutcomes.length).toBeGreaterThan(0);
  });

  it('whatIf() handles decrease multiplier', () => {
    const sim = engine.whatIf('error_rate', 0.7);
    expect(sim.scenario).toContain('decreases by 30%');
    const outcome = sim.predictedOutcomes.find(o => o.metric === 'error_rate');
    expect(outcome).toBeDefined();
    expect(outcome!.direction).toBe('decrease');
  });

  it('validateSimulation() computes accuracy', () => {
    const sim = engine.simulate('error_rate doubles');

    const actualOutcomes = [
      { metric: 'error_rate', predicted: 2, direction: 'increase' as const, confidence: 1 },
    ];

    const validated = engine.validateSimulation(sim.id!, actualOutcomes);
    expect(validated).not.toBeNull();
    expect(validated!.accuracy).toBeDefined();
    // The predicted direction for error_rate was 'increase', actual is 'increase' => match
    expect(validated!.accuracy).toBe(1);
    expect(validated!.validatedAt).not.toBeNull();
    expect(validated!.actualOutcomes).toHaveLength(1);
  });

  it('validateSimulation() returns null for non-existent simulation', () => {
    const result = engine.validateSimulation(999, []);
    expect(result).toBeNull();
  });

  it('listSimulations() returns recent', () => {
    engine.simulate('metric_a doubles');
    engine.simulate('metric_b halves');
    engine.simulate('metric_c triples');

    const list = engine.listSimulations();
    expect(list).toHaveLength(3);
    // Ordered by id DESC
    expect(list[0].id).toBeGreaterThan(list[1].id!);
  });

  it('getAccuracy() returns stats', () => {
    const sim1 = engine.simulate('error_rate doubles');
    const sim2 = engine.simulate('latency halves');

    engine.validateSimulation(sim1.id!, [
      { metric: 'error_rate', predicted: 2, direction: 'increase', confidence: 1 },
    ]);
    engine.validateSimulation(sim2.id!, [
      { metric: 'latency', predicted: 0.5, direction: 'increase', confidence: 1 },
    ]);

    const accuracy = engine.getAccuracy();
    expect(accuracy.totalSimulations).toBe(2);
    expect(accuracy.validatedCount).toBe(2);
    // sim1: correct direction (increase=increase) => 1.0
    // sim2: wrong direction (decrease != increase) => 0.0
    // average = 0.5
    expect(accuracy.avgAccuracy).toBeCloseTo(0.5, 1);
  });

  it('getStatus() returns correct stats', () => {
    engine.simulate('test scenario doubles');

    const status = engine.getStatus();
    expect(status.totalSimulations).toBe(1);
    expect(status.validatedCount).toBe(0);
    expect(status.avgAccuracy).toBe(0);
    expect(status.recentSimulations).toHaveLength(1);
    expect(status.recentSimulations[0].scenario).toBe('test scenario doubles');
  });

  it('works without data sources', () => {
    // No prediction engine, no causal graph, no metacognition
    const sim = engine.simulate('some unknown scenario');
    expect(sim.id).toBeDefined();
    expect(sim.predictedOutcomes.length).toBeGreaterThan(0);
    // Without causal graph, it falls back to the direct metric + possibly generic outcome
  });
});
