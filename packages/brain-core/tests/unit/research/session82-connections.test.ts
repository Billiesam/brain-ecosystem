import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { AttentionEngine } from '../../../src/attention/attention-engine.js';
import { PredictionEngine, runPredictionMigration } from '../../../src/prediction/prediction-engine.js';
import { ConsensusEngine, runConsensusMigration } from '../../../src/consensus/consensus-engine.js';
import { HypothesisEngine } from '../../../src/hypothesis/engine.js';

describe('Session 82: Cross-Module Connections II', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  // ── Connection 1: Emotional→Attention ──

  it('AttentionEngine.setFocus boosts topic attention', () => {
    const engine = new AttentionEngine(db, { brainName: 'test' });

    // Set focus on a topic (simulating what orchestrator does on high arousal)
    engine.setFocus('anomaly_detection', 2.0);

    const topics = engine.getTopTopics(5);
    const boosted = topics.find(t => t.topic === 'anomaly_detection');
    expect(boosted).toBeDefined();
    expect(boosted!.score).toBeGreaterThan(0);
  });

  // ── Connection 2: Simulation→Prediction ──

  it('PredictionEngine records simulation metrics', () => {
    runPredictionMigration(db);
    const engine = new PredictionEngine(db, { brainName: 'test', minConfidence: 0.01, minDataPoints: 2 });

    // Record simulated metrics (simulating what orchestrator does after simulation)
    engine.recordMetric('sim_knowledge_growth', 0.8, 'metric');
    engine.recordMetric('sim_error_rate', 0.12, 'metric');

    // Verify metrics were recorded
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM prediction_metrics WHERE metric LIKE ?').get('sim_%') as { cnt: number }).cnt;
    expect(count).toBe(2);
  });

  // ── Connection 3: Teaching→Consensus ──

  it('ConsensusEngine accepts teaching_review proposals', () => {
    runConsensusMigration(db);
    const engine = new ConsensusEngine(db, { brainName: 'test' });

    // Propose a teaching review (simulating what orchestrator does after teaching)
    const proposal = engine.propose({
      type: 'teaching_review',
      description: 'Review 3 principles for teaching: principle A; principle B; principle C',
      options: ['adopt', 'reject', 'defer'],
    });

    expect(proposal.id).toBeDefined();
    expect(proposal.type).toBe('teaching_review');

    // Cast a vote
    const vote = engine.vote(proposal.id, 'adopt', 0.8, 'Strong evidence');
    expect(vote).toBeDefined();

    const status = engine.getStatus();
    expect(status.totalProposals).toBeGreaterThanOrEqual(1);
  });

  // ── Connection 4: Narrative→Emotion (via observation pipeline) ──

  it('HypothesisEngine records contradiction observations', () => {
    const engine = new HypothesisEngine(db, { brainName: 'test' });

    // Record contradiction observation (simulating what orchestrator does when contradictions found)
    engine.observe({
      source: 'test',
      type: 'high_severity_contradiction',
      value: 2,
      timestamp: Date.now(),
      metadata: { contradictionCount: 5, highSeverityCount: 2 },
    });

    // Verify observation was recorded
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM observations WHERE type = ?').get('high_severity_contradiction') as { cnt: number }).cnt;
    expect(count).toBe(1);
  });
});
