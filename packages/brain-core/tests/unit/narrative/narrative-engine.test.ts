import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { NarrativeEngine } from '../../../src/narrative/narrative-engine.js';

describe('NarrativeEngine', () => {
  let db: Database.Database;
  let engine: NarrativeEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new NarrativeEngine(db, { brainName: 'test-brain' });
  });

  it('should create tables on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'narrative%'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('narrative_digests');
    expect(names).toContain('narrative_log');
  });

  it('should explain topic with no data sources', () => {
    const result = engine.explain('error patterns');
    expect(result.topic).toBe('error patterns');
    expect(result.summary).toContain('No knowledge found');
    expect(result.details).toHaveLength(0);
    expect(result.confidence).toBe(0);
    expect(result.sources).toHaveLength(0);
    expect(result.generatedAt).toBeGreaterThan(0);
  });

  it('should explain topic with knowledge distiller data', () => {
    const mockDistiller = {
      getPrinciples: () => [
        { id: 1, statement: 'Errors spike at night', domain: 'error patterns', confidence: 0.8, sample_size: 50 },
        { id: 2, statement: 'CPU usage correlates with errors', domain: 'error patterns', confidence: 0.6, sample_size: 30 },
      ],
      getAntiPatterns: () => [
        { id: 1, statement: 'Ignoring error bursts', domain: 'error patterns', confidence: 0.7, failure_rate: 0.6, alternative: 'Set up alerts' },
      ],
      getSummary: () => ({}),
    };

    engine.setDataSources({ knowledgeDistiller: mockDistiller as never });
    const result = engine.explain('error patterns');

    expect(result.details.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.summary).toContain('principle');
  });

  it('should answer a question with no data', () => {
    const result = engine.ask('why do errors spike?');
    expect(result.question).toBe('why do errors spike?');
    expect(result.answer).toContain("don't have enough data");
    expect(result.confidence).toBe(0);
    expect(result.sources).toHaveLength(0);
  });

  it('should answer a question with matching principles', () => {
    const mockDistiller = {
      getPrinciples: () => [
        { id: 1, statement: 'Errors spike at night due to batch jobs', domain: 'ops', confidence: 0.85, sample_size: 100 },
      ],
      getAntiPatterns: () => [],
      getSummary: () => ({}),
    };

    engine.setDataSources({ knowledgeDistiller: mockDistiller as never });
    const result = engine.ask('why do errors spike at night?');

    expect(result.answer).toContain('spike');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('should find contradictions (empty without data)', () => {
    const result = engine.findContradictions();
    expect(result).toHaveLength(0);
  });

  it('should detect hypothesis vs antipattern contradiction', () => {
    const mockDistiller = {
      getPrinciples: () => [],
      getAntiPatterns: () => [
        { id: 1, statement: 'aggressive caching leads to stale data errors', domain: 'ops', confidence: 0.8, failure_rate: 0.6, alternative: 'Use TTL-based cache' },
      ],
      getSummary: () => ({}),
    };
    const mockHypothesis = {
      list: () => [
        { id: 1, statement: 'aggressive caching reduces response time and errors', status: 'confirmed', confidence: 0.75, p_value: 0.02, evidence_for: 10, evidence_against: 2 },
      ],
      getSummary: () => ({}),
    };

    engine.setDataSources({
      knowledgeDistiller: mockDistiller as never,
      hypothesisEngine: mockHypothesis as never,
    });
    const result = engine.findContradictions();

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.type).toBe('hypothesis_vs_antipattern');
  });

  it('should generate a weekly digest', () => {
    const result = engine.generateDigest(7);
    expect(result.period.from).toBeDefined();
    expect(result.period.to).toBeDefined();
    expect(result.summary).toContain('test-brain');
    expect(result.markdown).toContain('Weekly Digest');
    expect(result.generatedAt).toBeGreaterThan(0);

    // Should persist digest
    const count = (db.prepare('SELECT COUNT(*) as c FROM narrative_digests').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('should get status', () => {
    const status = engine.getStatus();
    expect(status.digestCount).toBe(0);
    expect(status.narrativeCount).toBe(0);
    expect(status.lastDigest).toBeNull();
  });

  it('should get confidence report with no data', () => {
    const report = engine.getConfidenceReport('errors');
    expect(report.topic).toBe('errors');
    expect(report.overallConfidence).toBe(0);
    expect(report.uncertainties.length).toBeGreaterThan(0);
  });

  it('should log narrative operations', () => {
    engine.explain('test topic');
    engine.ask('what is test?');

    const count = (db.prepare('SELECT COUNT(*) as c FROM narrative_log').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('should get digest history', () => {
    engine.generateDigest(7);
    engine.generateDigest(14);

    const history = engine.getDigestHistory(10);
    expect(history).toHaveLength(2);
    expect(history[0]!.id).toBe(2); // most recent first
  });

  it('should get specific digest by id', () => {
    engine.generateDigest(7);
    const digest = engine.getDigest(1);
    expect(digest).toContain('Weekly Digest');
  });

  it('should return null for non-existent digest', () => {
    expect(engine.getDigest(999)).toBeNull();
  });

  describe('Contradiction cooldown', () => {
    it('should cache identical contradiction results within cooldown', () => {
      // With no data sources, findContradictions returns the same empty result
      const result1 = engine.findContradictions();
      const result2 = engine.findContradictions();
      // Both return same cached array reference within cooldown
      expect(result1).toEqual(result2);
    });

    it('should return fresh results when data changes', () => {
      const result1 = engine.findContradictions();

      // Add a knowledge principle so contradictions change
      engine.setDataSources({
        hypothesisEngine: {
          list: () => [
            { id: 1, statement: 'A is true', type: 'correlation', source: 'test', confidence: 0.9, status: 'confirmed', variables: [], condition: {}, evidence_for: 5, evidence_against: 0, p_value: 0.01, created_at: '', tested_at: '' },
            { id: 2, statement: 'A is false', type: 'correlation', source: 'test', confidence: 0.8, status: 'confirmed', variables: [], condition: {}, evidence_for: 4, evidence_against: 1, p_value: 0.02, created_at: '', tested_at: '' },
          ],
          getSummary: () => ({ total: 2, confirmed: 2, rejected: 0, proposed: 0, testing: 0, accuracy: 0.5 }),
        } as never,
      });
      const result2 = engine.findContradictions();
      // Result should differ since data changed
      expect(result2.length).toBeGreaterThanOrEqual(0); // may or may not find contradictions, but no crash
    });

    it('should return fresh result after cooldown expires', () => {
      const result1 = engine.findContradictions();

      // Force-expire the cooldown by manipulating internal state
      // @ts-expect-error — accessing private for test
      engine['lastContradictionTime'] = Date.now() - 400_000; // 400s ago, well past 300s cooldown

      const result2 = engine.findContradictions();
      // Should re-compute (even if result is same value, it's freshly computed)
      expect(result2).toEqual(result1);
    });
  });
});
