import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DebateEngine } from '../../../src/debate/debate-engine.js';

describe('DebateEngine — Advocatus Diaboli (Principle Challenges)', () => {
  let db: Database.Database;
  let engine: DebateEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new DebateEngine(db, { brainName: 'test-brain' });
  });

  it('should create principle_challenges table on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'principle_challenges'",
    ).all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  it('should create a challenge record with no data sources', () => {
    const challenge = engine.challenge('Errors always increase at night');

    expect(challenge.id).toBeDefined();
    expect(challenge.principleStatement).toBe('Errors always increase at night');
    expect(challenge.challengeArguments).toBeInstanceOf(Array);
    expect(challenge.supportingEvidence).toBeInstanceOf(Array);
    expect(challenge.contradictingEvidence).toBeInstanceOf(Array);
    expect(challenge.challengedAt).toBeDefined();
    expect(typeof challenge.resilienceScore).toBe('number');
  });

  it('should compute resilience score based on evidence ratio', () => {
    // Provide data sources that return supporting and contradicting evidence
    const mockHypothesis = {
      list: (status?: string) => {
        if (status === 'rejected') {
          return [
            { statement: 'Errors at night are due to fewer engineers', confidence: 0.7, status: 'rejected', variables: [], p_value: 0.6 },
          ];
        }
        if (status === 'confirmed') {
          return [
            { statement: 'Errors at night spike during maintenance', confidence: 0.8, status: 'confirmed', variables: [], p_value: 0.02 },
            { statement: 'Night errors correlate with batch jobs', confidence: 0.9, status: 'confirmed', variables: [], p_value: 0.01 },
          ];
        }
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockHypothesis as never });
    const challenge = engine.challenge('Errors increase at night');

    // 2 supporting (confirmed) + 1 contradicting (rejected)
    // resilience = supporting / (supporting + contradicting + 0.01) = 2 / 3.01 ~ 0.664
    expect(challenge.supportingEvidence.length).toBe(2);
    expect(challenge.contradictingEvidence.length).toBe(1);
    expect(challenge.resilienceScore).toBeGreaterThan(0);
    expect(challenge.resilienceScore).toBeLessThan(1);
  });

  it('should assign outcome "survived" for high resilience', () => {
    // Only supporting evidence, no contradicting
    const mockHypothesis = {
      list: (status?: string) => {
        if (status === 'confirmed') {
          return [
            { statement: 'Errors at night are real', confidence: 0.9, status: 'confirmed', variables: [], p_value: 0.01 },
            { statement: 'Night errors verified', confidence: 0.85, status: 'confirmed', variables: [], p_value: 0.02 },
            { statement: 'Night batch processing causes errors', confidence: 0.8, status: 'confirmed', variables: [], p_value: 0.03 },
          ];
        }
        if (status === 'rejected') return [];
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockHypothesis as never });
    const challenge = engine.challenge('Errors increase at night');

    // resilience = 3 / (3 + 0 + 0.01) ≈ 0.997 > 0.7 → survived
    expect(challenge.outcome).toBe('survived');
    expect(challenge.resilienceScore).toBeGreaterThan(0.7);
  });

  it('should assign outcome "disproved" for low resilience', () => {
    // Only contradicting evidence, no supporting
    const mockHypothesis = {
      list: (status?: string) => {
        if (status === 'rejected') {
          return [
            { statement: 'Errors at night theory was wrong', confidence: 0.3, status: 'rejected', variables: [], p_value: 0.8 },
            { statement: 'Night errors disproved', confidence: 0.2, status: 'rejected', variables: [], p_value: 0.9 },
          ];
        }
        if (status === 'confirmed') return [];
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockHypothesis as never });
    const challenge = engine.challenge('Errors increase at night');

    // resilience = 0 / (0 + 2 + 0.01) ≈ 0.0 < 0.4 → disproved
    expect(challenge.outcome).toBe('disproved');
    expect(challenge.resilienceScore).toBeLessThan(0.4);
  });

  it('should assign outcome "weakened" for moderate resilience', () => {
    const mockHypothesis = {
      list: (status?: string) => {
        if (status === 'confirmed') {
          return [
            { statement: 'Errors at night confirmed once', confidence: 0.6, status: 'confirmed', variables: [], p_value: 0.04 },
          ];
        }
        if (status === 'rejected') {
          return [
            { statement: 'Errors at night disproved in winter', confidence: 0.5, status: 'rejected', variables: [], p_value: 0.6 },
          ];
        }
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockHypothesis as never });
    const challenge = engine.challenge('Errors increase at night');

    // resilience = 1 / (1 + 1 + 0.01) ≈ 0.497 → 0.4 < 0.497 < 0.7 → weakened
    expect(challenge.outcome).toBe('weakened');
    expect(challenge.resilienceScore).toBeGreaterThan(0.4);
    expect(challenge.resilienceScore).toBeLessThanOrEqual(0.7);
  });

  it('should return recent challenges from getChallengeHistory()', () => {
    engine.challenge('Principle A');
    engine.challenge('Principle B');
    engine.challenge('Principle C');

    const history = engine.getChallengeHistory(10);
    expect(history.length).toBe(3);
    // All three challenges should be present
    const statements = history.map(h => h.principleStatement);
    expect(statements).toContain('Principle A');
    expect(statements).toContain('Principle B');
    expect(statements).toContain('Principle C');

    const limited = engine.getChallengeHistory(2);
    expect(limited.length).toBe(2);
  });

  it('should return weakest principles from getMostVulnerable()', () => {
    // Create challenges with different resilience scores
    const mockForSurvived = {
      list: (status?: string) => {
        if (status === 'confirmed') {
          return [
            { statement: 'Strong evidence', confidence: 0.9, status: 'confirmed', variables: [], p_value: 0.01 },
            { statement: 'More strong evidence', confidence: 0.85, status: 'confirmed', variables: [], p_value: 0.02 },
          ];
        }
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockForSurvived as never });
    engine.challenge('Strong principle');

    const mockForDisproved = {
      list: (status?: string) => {
        if (status === 'rejected') {
          return [
            { statement: 'Counter evidence', confidence: 0.3, status: 'rejected', variables: [], p_value: 0.8 },
            { statement: 'More counter evidence', confidence: 0.2, status: 'rejected', variables: [], p_value: 0.9 },
          ];
        }
        return [];
      },
    };

    engine.setDataSources({ hypothesisEngine: mockForDisproved as never });
    engine.challenge('Weak principle');

    const vulnerable = engine.getMostVulnerable(5);
    expect(vulnerable.length).toBe(2);
    // Sorted by resilience_score ASC (lowest first)
    expect(vulnerable[0].principleStatement).toBe('Weak principle');
    expect(vulnerable[0].resilienceScore).toBeLessThan(vulnerable[1].resilienceScore);
  });

  it('should include totalChallenges in getStatus()', () => {
    engine.challenge('P1');
    engine.challenge('P2');

    const status = engine.getStatus();
    expect(status.totalChallenges).toBe(2);
    expect(status.vulnerablePrinciples.length).toBe(2);
  });
});
