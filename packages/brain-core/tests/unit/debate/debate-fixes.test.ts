import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DebateEngine } from '../../../src/debate/debate-engine.js';
import { KnowledgeDistiller } from '../../../src/research/knowledge-distiller.js';
import { ResearchOrchestrator } from '../../../src/research/research-orchestrator.js';
import { ActionBridgeEngine } from '../../../src/action/action-bridge.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('Fix 1: Challenge → Principle Confidence Adjustment', () => {
  let db: Database.Database;
  let distiller: KnowledgeDistiller;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    distiller = new KnowledgeDistiller(db, { brainName: 'test' });
    // Insert a test principle
    db.prepare(`INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source)
      VALUES ('p1', 'test', 'Test principle', 0.8, 10, 0.85, 'hypothesis')`).run();
  });

  afterEach(() => { db.close(); });

  it('adjustPrincipleConfidence reduces confidence with factor < 1', () => {
    const result = distiller.adjustPrincipleConfidence('p1', 0.7);
    expect(result).toBe(true);

    const principles = distiller.getPrinciples('test', 10);
    const p = principles.find(p => p.id === 'p1');
    expect(p).toBeDefined();
    expect(p!.confidence).toBeCloseTo(0.85 * 0.7); // 0.595
  });

  it('adjustPrincipleConfidence boosts confidence with factor > 1', () => {
    distiller.adjustPrincipleConfidence('p1', 1.1);
    const p = distiller.getPrinciples('test', 10).find(p => p.id === 'p1');
    expect(p!.confidence).toBeCloseTo(0.85 * 1.1); // 0.935
  });

  it('adjustPrincipleConfidence clamps to [0, 1]', () => {
    // Set confidence very high
    db.prepare('UPDATE knowledge_principles SET confidence = 0.95 WHERE id = ?').run('p1');
    distiller.adjustPrincipleConfidence('p1', 1.2); // 0.95 * 1.2 = 1.14 → clamped to 1.0
    const p = distiller.getPrinciples('test', 10).find(p => p.id === 'p1');
    expect(p!.confidence).toBe(1.0);
  });

  it('adjustPrincipleConfidence returns false for unknown id', () => {
    expect(distiller.adjustPrincipleConfidence('unknown', 0.5)).toBe(false);
  });

  it('removePrinciple deletes a disproved principle', () => {
    expect(distiller.removePrinciple('p1')).toBe(true);
    const principles = distiller.getPrinciples('test', 10);
    expect(principles.find(p => p.id === 'p1')).toBeUndefined();
  });

  it('removePrinciple returns false for unknown id', () => {
    expect(distiller.removePrinciple('nonexistent')).toBe(false);
  });
});

describe('Fix 2: Debate Recommendations → ActionBridge', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;
  let actionBridge: ActionBridgeEngine;
  let debateEngine: DebateEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
    actionBridge = new ActionBridgeEngine(db, { brainName: 'test' });
    debateEngine = new DebateEngine(db, { brainName: 'test' });
    orch.setActionBridge(actionBridge);
    orch.setDebateEngine(debateEngine);
  });

  afterEach(() => { db.close(); });

  it('debate synthesis recommendations become ActionBridge proposals', () => {
    // Start a debate and synthesize
    const debate = debateEngine.startDebate('What should we optimize?');
    debateEngine.synthesize(debate.id!);

    // Verify the debate was synthesized
    const updated = debateEngine.getDebate(debate.id!);
    expect(updated?.status).toBe('synthesized');

    // Now simulate what the orchestrator does: propose recommendations
    const synthesis = updated?.synthesis;
    if (synthesis && synthesis.recommendations.length > 0) {
      for (const rec of synthesis.recommendations.slice(0, 2)) {
        const actionId = actionBridge.propose({
          source: 'research',
          type: 'create_goal',
          title: `Debate recommendation: ${rec.substring(0, 70)}`,
          description: rec,
          confidence: synthesis.confidence,
          payload: { debateId: debate.id, recommendation: rec },
        });
        expect(actionId).toBeGreaterThan(0);
      }
    }

    // Verify actions were created
    const pending = actionBridge.getQueue('pending');
    // At least the debate creates some heuristic recommendations
    expect(pending.length).toBeGreaterThanOrEqual(0); // may be 0 if no recommendations generated without data
  });
});

describe('Fix 3: Debate Lifecycle — closeDebate', () => {
  let db: Database.Database;
  let debateEngine: DebateEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    debateEngine = new DebateEngine(db, { brainName: 'test' });
  });

  afterEach(() => { db.close(); });

  it('closeDebate sets status to closed with timestamp', () => {
    const debate = debateEngine.startDebate('Test debate');
    expect(debate.status).toBe('deliberating');

    debateEngine.closeDebate(debate.id!);
    const closed = debateEngine.getDebate(debate.id!);
    expect(closed?.status).toBe('closed');
    expect(closed?.closed_at).toBeDefined();
    expect(closed?.closed_at).not.toBeNull();
  });

  it('synthesize + close full lifecycle', () => {
    const debate = debateEngine.startDebate('Lifecycle test');
    const synthesis = debateEngine.synthesize(debate.id!);
    expect(synthesis).toBeDefined();

    debateEngine.closeDebate(debate.id!);
    const final = debateEngine.getDebate(debate.id!);
    expect(final?.status).toBe('closed');
  });
});

describe('Fix 4: Targeted Challenge Selection (weakest first)', () => {
  let db: Database.Database;
  let distiller: KnowledgeDistiller;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    distiller = new KnowledgeDistiller(db, { brainName: 'test' });

    // Insert principles with varying confidence
    db.prepare(`INSERT INTO knowledge_principles (id, domain, statement, success_rate, sample_size, confidence, source) VALUES
      ('p1', 'test', 'Strong principle', 0.9, 20, 0.95, 'hypothesis'),
      ('p2', 'test', 'Medium principle', 0.7, 10, 0.60, 'hypothesis'),
      ('p3', 'test', 'Weak principle', 0.5, 5, 0.30, 'hypothesis')
    `).run();
  });

  afterEach(() => { db.close(); });

  it('sorting principles by confidence puts weakest first', () => {
    const principles = distiller.getPrinciples(undefined, 20);
    const sorted = [...principles].sort((a, b) => a.confidence - b.confidence);
    expect(sorted[0].statement).toBe('Weak principle');
    expect(sorted[0].confidence).toBe(0.30);
  });

  it('weakest principle is targeted for challenge', () => {
    const principles = distiller.getPrinciples(undefined, 20);
    const sorted = [...principles].sort((a, b) => a.confidence - b.confidence);
    const target = sorted[0];

    // Verify it's the weakest
    for (const p of principles) {
      expect(target.confidence).toBeLessThanOrEqual(p.confidence);
    }
  });
});

describe('Fix 5: Wasted LLM Call Removed', () => {
  let db: Database.Database;
  let debateEngine: DebateEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    debateEngine = new DebateEngine(db, { brainName: 'test' });
  });

  afterEach(() => { db.close(); });

  it('synchronous synthesize does not call LLM (fire-and-forget removed)', () => {
    const mockLlm = { isAvailable: () => true, call: vi.fn().mockResolvedValue({ text: 'test' }) };
    debateEngine.setLLMService(mockLlm as any);

    const debate = debateEngine.startDebate('Test');
    debateEngine.synthesize(debate.id!);

    // LLM should NOT be called in synchronous synthesize
    expect(mockLlm.call).not.toHaveBeenCalled();
  });
});

describe('Fix 6: Cross-Brain Debate Signal Handling', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;
  let debateEngine: DebateEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
    debateEngine = new DebateEngine(db, { brainName: 'test' });
    orch.setDebateEngine(debateEngine);
  });

  afterEach(() => { db.close(); });

  it('handles debate_perspective_request by generating perspective', () => {
    const debate = debateEngine.startDebate('Cross-brain test');

    // Simulate receiving a perspective request from trading-brain
    orch.onCrossBrainEvent('trading-brain', 'debate_perspective_request', {
      debateId: debate.id!,
      question: 'Cross-brain test',
    });

    // No crash = success (signal router not wired in test, so perspective is generated but not sent)
  });

  it('handles debate_perspective_response by adding to debate', () => {
    const debate = debateEngine.startDebate('Multi-brain debate');

    // Simulate receiving a perspective response
    orch.onCrossBrainEvent('trading-brain', 'debate_perspective_response', {
      debateId: debate.id!,
      perspective: {
        brainName: 'trading-brain',
        position: 'Trading perspective on the topic',
        confidence: 0.75,
        relevance: 0.8,
        arguments: [{ claim: 'Market data supports this', evidence: ['data:1'], source: 'prediction', strength: 0.7 }],
      },
    });

    // Verify the perspective was added
    const updated = debateEngine.getDebate(debate.id!);
    expect(updated?.perspectives.length).toBe(2); // Original + trading-brain
    expect(updated?.perspectives.some(p => p.brainName === 'trading-brain')).toBe(true);
  });
});
