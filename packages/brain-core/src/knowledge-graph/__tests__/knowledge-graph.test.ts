import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { KnowledgeGraphEngine, runKnowledgeGraphMigration } from '../graph-engine.js';
import { FactExtractor } from '../fact-extractor.js';

// ── Helpers ──────────────────────────────────────────────────

function createTestDb(): Database.Database {
  return new Database(':memory:');
}

// ── KnowledgeGraphEngine Tests ──────────────────────────────

describe('KnowledgeGraphEngine', () => {
  let db: Database.Database;
  let engine: KnowledgeGraphEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new KnowledgeGraphEngine(db, { brainName: 'test' });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('creates knowledge_facts table on migration', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_facts'").all();
    expect(tables).toHaveLength(1);
  });

  it('migration is idempotent', () => {
    runKnowledgeGraphMigration(db);
    runKnowledgeGraphMigration(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_facts'").all();
    expect(tables).toHaveLength(1);
  });

  it('adds a new fact', () => {
    const fact = engine.addFact('TypeScript', 'improves', 'code quality');
    expect(fact.subject).toBe('TypeScript');
    expect(fact.predicate).toBe('improves');
    expect(fact.object).toBe('code quality');
    expect(fact.confidence).toBe(0.5);
    expect(fact.evidence_count).toBe(1);
    expect(fact.id).toBeGreaterThan(0);
  });

  it('increments evidence_count on duplicate S-P-O', () => {
    engine.addFact('TypeScript', 'improves', 'code quality');
    const updated = engine.addFact('TypeScript', 'improves', 'code quality');
    expect(updated.evidence_count).toBe(2);
    expect(updated.confidence).toBeGreaterThan(0.5);
  });

  it('queries facts by subject', () => {
    engine.addFact('TypeScript', 'improves', 'code quality');
    engine.addFact('TypeScript', 'requires', 'compilation');
    engine.addFact('Python', 'improves', 'productivity');

    const results = engine.query({ subject: 'TypeScript' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.subject === 'TypeScript')).toBe(true);
  });

  it('queries facts by predicate', () => {
    engine.addFact('TypeScript', 'improves', 'code quality');
    engine.addFact('Python', 'improves', 'productivity');
    engine.addFact('Rust', 'requires', 'ownership rules');

    const results = engine.query({ predicate: 'improves' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.predicate === 'improves')).toBe(true);
  });

  it('queries facts by object', () => {
    engine.addFact('TypeScript', 'improves', 'code quality');
    engine.addFact('ESLint', 'improves', 'code quality');
    engine.addFact('Python', 'improves', 'productivity');

    const results = engine.query({ object: 'code quality' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.object === 'code quality')).toBe(true);
  });

  it('queries with partial filter (subject + predicate)', () => {
    engine.addFact('TypeScript', 'improves', 'code quality');
    engine.addFact('TypeScript', 'improves', 'maintainability');
    engine.addFact('TypeScript', 'requires', 'compilation');

    const results = engine.query({ subject: 'TypeScript', predicate: 'improves' });
    expect(results).toHaveLength(2);
  });

  it('infers transitive relationships', () => {
    engine.addFact('A', 'causes', 'B', undefined, 0.9);
    engine.addFact('B', 'causes', 'C', undefined, 0.8);
    engine.addFact('C', 'causes', 'D', undefined, 0.7);

    const chains = engine.infer('A', 'causes');
    expect(chains.length).toBeGreaterThan(0);

    // Should find A->B->C and A->B->C->D chains
    const longChain = chains.find(c => c.endObject === 'D');
    expect(longChain).toBeDefined();
    expect(longChain!.path).toHaveLength(3);
    expect(longChain!.confidence).toBeCloseTo(0.9 * 0.8 * 0.7, 5);
  });

  it('returns empty chains when no transitive path exists', () => {
    engine.addFact('A', 'causes', 'B', undefined, 0.9);
    // No B->anything with 'causes'

    const chains = engine.infer('A', 'causes');
    // Only 1 hop (A->B), no multi-hop chain
    expect(chains).toHaveLength(0);
  });

  it('detects contradictions', () => {
    engine.addFact('caching', 'causes', 'speed improvement', undefined, 0.8);
    engine.addFact('caching', 'causes', 'memory issues', undefined, 0.7);

    const contradictions = engine.contradictions();
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.subject).toBe('caching');
    expect(contradictions[0]!.predicate).toBe('causes');
    expect(contradictions[0]!.facts).toHaveLength(2);
  });

  it('does not flag low-confidence facts as contradictions', () => {
    engine.addFact('caching', 'causes', 'speed improvement', undefined, 0.8);
    engine.addFact('caching', 'causes', 'memory issues', undefined, 0.3);

    const contradictions = engine.contradictions();
    expect(contradictions).toHaveLength(0);
  });

  it('extracts subgraph via BFS', () => {
    engine.addFact('A', 'relates', 'B');
    engine.addFact('B', 'relates', 'C');
    engine.addFact('C', 'relates', 'D');
    engine.addFact('X', 'relates', 'Y');

    const sub = engine.subgraph('A', 2);
    // Should include A-B, B-C but not C-D (depth 2 from A: A->B is depth 1, B->C is depth 2)
    expect(sub.length).toBeGreaterThanOrEqual(2);

    // Should NOT include X-Y (disconnected)
    const hasXY = sub.some(f => f.subject === 'X' || f.object === 'X');
    expect(hasXY).toBe(false);
  });

  it('returns status with correct totals', () => {
    engine.addFact('A', 'causes', 'B');
    engine.addFact('C', 'requires', 'D');
    engine.addFact('E', 'causes', 'F');

    const status = engine.getStatus();
    expect(status.totalFacts).toBe(3);
    expect(status.predicateDistribution['causes']).toBe(2);
    expect(status.predicateDistribution['requires']).toBe(1);
    expect(status.avgConfidence).toBeCloseTo(0.5, 1);
  });
});

// ── FactExtractor Tests ─────────────────────────────────────

describe('FactExtractor', () => {
  let db: Database.Database;
  let extractor: FactExtractor;

  beforeEach(() => {
    db = createTestDb();
    extractor = new FactExtractor(db, { brainName: 'test' });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('extracts "X causes Y" from insight text', () => {
    const facts = extractor.extractFromInsight('Memory leaks causes application crashes', 'insight-1');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.subject).toBe('Memory leaks');
    expect(facts[0]!.predicate).toBe('causes');
    expect(facts[0]!.object).toBe('application crashes');
  });

  it('extracts "X solves Y" from insight text', () => {
    const facts = extractor.extractFromInsight('Caching solves latency problems', 'insight-2');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('solves');
  });

  it('extracts "X requires Y" from insight text', () => {
    const facts = extractor.extractFromInsight('Kubernetes requires container runtime', 'insight-3');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('requires');
  });

  it('extracts "X improves Y" from insight text', () => {
    const facts = extractor.extractFromInsight('TypeScript improves code quality', 'insight-4');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('improves');
  });

  it('extracts "X prevents Y" from insight text', () => {
    const facts = extractor.extractFromInsight('Input validation prevents injection attacks', 'insight-5');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('prevents');
  });

  it('extracts "when X then Y" from insight text', () => {
    const facts = extractor.extractFromInsight('when load increases then response time degrades', 'insight-6');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.predicate).toBe('leads_to');
    expect(facts[0]!.subject).toBe('load increases');
    expect(facts[0]!.object).toBe('response time degrades');
  });

  it('extracts rule facts', () => {
    const facts = extractor.extractFromRule('error count > 10', 'restart service', 'rule-1');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.subject).toBe('error count > 10');
    expect(facts[0]!.predicate).toBe('triggers');
    expect(facts[0]!.object).toBe('restart service');
    expect(facts[0]!.confidence).toBe(0.8);
  });

  it('extracts error-solution facts', () => {
    const facts = extractor.extractFromErrorSolution(
      'ECONNREFUSED', 'retry with backoff', 'network', 'err-1'
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]!.subject).toBe('ECONNREFUSED');
    expect(facts[0]!.predicate).toBe('solved_by');
    expect(facts[0]!.object).toBe('retry with backoff');
    expect(facts[0]!.confidence).toBe(0.7);
  });

  it('extracts multiple facts from multi-sentence text', () => {
    const text = 'Caching improves performance. Poor indexing causes slow queries';
    const facts = extractor.extractFromInsight(text, 'insight-multi');
    expect(facts).toHaveLength(2);
  });

  it('returns empty array for text with no matching patterns', () => {
    const facts = extractor.extractFromInsight('The sky is blue today', 'insight-none');
    expect(facts).toHaveLength(0);
  });
});
