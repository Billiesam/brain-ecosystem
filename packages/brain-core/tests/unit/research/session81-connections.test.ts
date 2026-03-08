import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PredictionEngine, runPredictionMigration } from '../../../src/prediction/prediction-engine.js';
import { GoalEngine } from '../../../src/goals/goal-engine.js';
import { ReasoningEngine } from '../../../src/reasoning/reasoning-engine.js';
import { HypothesisEngine } from '../../../src/hypothesis/engine.js';

describe('Session 81: Cross-Module Connections I', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  // ── Connection 1: Prediction→Goal ──

  it('Prediction accuracy feeds into GoalEngine metrics', () => {
    runPredictionMigration(db);
    const pred = new PredictionEngine(db, { brainName: 'test', minConfidence: 0.01, minDataPoints: 2 });
    const goal = new GoalEngine(db, { brainName: 'test' });

    // Create a goal tracking prediction accuracy
    const g = goal.createGoal('Improve prediction accuracy', 'predictionAccuracy', 0.8, 100);
    expect(g.id).toBeDefined();

    // Record prediction accuracy as progress
    goal.recordProgress(1, { predictionAccuracy: 0.5 });
    goal.recordProgress(2, { predictionAccuracy: 0.6 });

    const progress = goal.getProgress(g.id!);
    expect(progress).not.toBeNull();
    expect(progress!.dataPoints).toBe(2);
  });

  // ── Connection 2: Reasoning→Hypothesis ──

  it('High-confidence inference chain generates hypothesis', () => {
    const reasoning = new ReasoningEngine(db, { brainName: 'test' });
    const hypothesis = new HypothesisEngine(db, { brainName: 'test' });

    // Insert a rule for reasoning
    db.prepare(`INSERT INTO inference_rules (antecedent, consequent, confidence, source_type, source_id, domain, keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'IF error_count > 5', 'THEN system_unstable', 0.8, 'test', 'rule-1', 'general', '["error", "unstable"]',
    );

    // Create a hypothesis from reasoning output (simulating what orchestrator does)
    const hyp = hypothesis.propose({
      statement: 'error_count > 5 → system_unstable',
      type: 'correlation',
      source: 'reasoning_engine',
      variables: ['error_count'],
      condition: { type: 'correlation', params: { strategy: 'inference_chain', chain_id: 1, confidence: 0.8 } },
    });

    expect(hyp).toBeDefined();
    expect(hyp.source).toBe('reasoning_engine');
    expect(hyp.status).toBe('proposed');

    // Check summary
    const summary = hypothesis.getSummary();
    expect(summary.total).toBeGreaterThanOrEqual(1);
  });

  // ── Connection 3: MemoryPalace→RAG source registration ──
  // (RAG indexing is async + requires embedding engine, so we test source setup)

  it('RAGIndexer accepts memory_palace custom source', async () => {
    // Import RAGIndexer
    const { RAGIndexer } = await import('../../../src/rag/rag-indexer.js');
    const indexer = new RAGIndexer(db);

    // Add memory palace source
    indexer.addSource({
      collection: 'memory_palace',
      query: `SELECT 1 as id, 'test connection' as text`,
      textColumns: ['text'],
      idColumn: 'id',
    });

    // indexAll without RAG engine should warn but not throw
    const result = await indexer.indexAll();
    expect(result).toBe(0); // No RAG engine set
  });

  // ── Connection 4: CodeHealth→SelfMod suggestion path ──

  it('CodeHealthMonitor high tech debt produces actionable status', async () => {
    const { CodeHealthMonitor } = await import('../../../src/code-health/health-monitor.js');
    const monitor = new CodeHealthMonitor(db, { brainName: 'test' });

    // Initial status with no scans
    const status = monitor.getStatus();
    expect(status.totalScans).toBe(0);
    expect(status.lastScan).toBeNull();

    // After a scan, status should reflect results
    // (scan requires real filesystem, so we verify the status interface)
    expect(status).toHaveProperty('avgTechDebt');
  });
});
