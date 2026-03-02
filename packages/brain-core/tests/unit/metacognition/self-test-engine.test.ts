import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SelfTestEngine } from '../../../src/metacognition/self-test-engine.js';

describe('SelfTestEngine', () => {
  let db: Database.Database;
  let engine: SelfTestEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    engine = new SelfTestEngine(db);
  });

  it('should create self_tests table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'self_tests'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('testPrinciple() creates a self-test record', () => {
    const result = engine.testPrinciple('High error rates correlate with deployment failures');
    expect(result.id).toBeDefined();
    expect(result.principleStatement).toBe('High error rates correlate with deployment failures');
    expect(result.predictionResult).toBeDefined();
    expect(['confirmed', 'contradicted', 'inconclusive']).toContain(result.predictionResult);
    expect(result.understandingDepth).toBeGreaterThanOrEqual(0);
    expect(result.understandingDepth).toBeLessThanOrEqual(1);
  });

  it('testPrinciple() computes understanding depth', () => {
    // Without any data sources, matchingConfirmed=0, matchingPredictions=0, hypothesisConfidence=0
    // rawDepth = 0*0.5 + 0*0.3 + 0*0.2 = 0 => depth = 0 => result = 'contradicted'
    const result = engine.testPrinciple('Some principle about errors');
    expect(result.understandingDepth).toBe(0);
    expect(result.predictionResult).toBe('contradicted');
  });

  it('testAll() tests all confirmed principles', () => {
    // Without distiller set, returns empty
    const results = engine.testAll();
    expect(results).toEqual([]);
  });

  it('testAll() uses distiller when set', () => {
    const mockDistiller = {
      getPrinciples: () => [
        { id: 'p1', domain: 'test', statement: 'Errors increase at night', success_rate: 0.8, sample_size: 10, confidence: 0.7, source: 'test' },
        { id: 'p2', domain: 'test', statement: 'Bugs cluster in modules', success_rate: 0.9, sample_size: 15, confidence: 0.85, source: 'test' },
      ],
    };

    engine.setKnowledgeDistiller(mockDistiller as never);
    const results = engine.testAll();
    expect(results).toHaveLength(2);
    expect(results[0].principleStatement).toBe('Errors increase at night');
    expect(results[1].principleStatement).toBe('Bugs cluster in modules');
  });

  it('getUnderstandingReport() returns correct stats', () => {
    engine.testPrinciple('Principle alpha about error monitoring');
    engine.testPrinciple('Principle beta about crash detection');
    engine.testPrinciple('Principle gamma about log analysis');

    const report = engine.getUnderstandingReport();
    expect(report.totalTested).toBe(3);
    expect(report.deepUnderstanding + report.shallowUnderstanding + report.untested).toBeLessThanOrEqual(3);
    expect(report.avgDepth).toBeGreaterThanOrEqual(0);
    expect(report.weakestPrinciples).toBeDefined();
    expect(report.weakestPrinciples.length).toBeLessThanOrEqual(5);
  });

  it('getStatus() returns counts', () => {
    engine.testPrinciple('Test principle one');
    engine.testPrinciple('Test principle two');

    const status = engine.getStatus();
    expect(status.totalTests).toBe(2);
    // Without data sources, all will be contradicted (depth=0)
    expect(status.contradicted).toBe(2);
    expect(status.confirmed).toBe(0);
    expect(status.inconclusive).toBe(0);
    expect(status.avgDepth).toBe(0);
  });

  it('handles multiple tests and accumulates correctly', () => {
    for (let i = 0; i < 5; i++) {
      engine.testPrinciple(`Principle ${i} about testing patterns`);
    }

    const status = engine.getStatus();
    expect(status.totalTests).toBe(5);

    const report = engine.getUnderstandingReport();
    expect(report.totalTested).toBe(5);
    expect(report.weakestPrinciples.length).toBe(5);
  });
});
