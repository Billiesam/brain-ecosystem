import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PredictionEngine, runPredictionMigration } from '../../../src/prediction/prediction-engine.js';
import { FeedbackEngine } from '../../../src/feedback/feedback-engine.js';
import { ActiveLearner, runActiveLearningMigration } from '../../../src/active-learning/active-learner.js';
import { TraceCollector } from '../../../src/observability/trace-collector.js';

describe('Session 79b: Intelligence Health Check — Wiring Tests', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  // ── Fix 1: Prediction state sync ──

  it('Prediction state total_resolved increments on resolve', () => {
    runPredictionMigration(db);
    const engine = new PredictionEngine(db, { brainName: 'test', minConfidence: 0.01, minDataPoints: 2 });

    // Record enough metric data to create a prediction
    for (let i = 0; i < 5; i++) {
      engine.recordMetric('test_metric', 10 + i, 'metric');
    }

    // Create a prediction
    const pred = engine.predict({ domain: 'metric', metric: 'test_metric' });
    expect(pred).not.toBeNull();

    // Manually add a more recent metric value so it can be resolved
    db.prepare(`INSERT INTO prediction_metrics (metric, value, domain, timestamp) VALUES (?, ?, ?, ?)`).run(
      'test_metric', 15, 'metric', Date.now() + 1000,
    );

    // Force the prediction to be past its horizon by backdating created_at
    db.prepare(`UPDATE predictions SET created_at = created_at - 999999999 WHERE prediction_id = ?`).run(pred!.prediction_id);

    const resolved = engine.resolveExpired();
    expect(resolved).toBeGreaterThanOrEqual(1);

    // Check that prediction_state was updated
    const state = db.prepare('SELECT total_resolved, total_correct FROM prediction_state WHERE id = 1').get() as { total_resolved: number; total_correct: number };
    expect(state.total_resolved).toBeGreaterThanOrEqual(1);
  });

  // ── Fix 2: Auto-feedback generates signals ──

  it('Auto-feedback generates positive signal from confirmed hypothesis', () => {
    // FeedbackEngine needs its migration
    const feedbackEngine = new FeedbackEngine(db, { brainName: 'test' });

    // Record a positive feedback signal (simulating what the orchestrator does)
    const record = feedbackEngine.recordFeedback('hypothesis', 1, 'positive', 'Confirmed: test hypothesis');
    expect(record).toBeTruthy();
    expect(record.signal).toBe('positive');
    expect(record.target_type).toBe('hypothesis');

    // Check stats reflect the signal
    const stats = feedbackEngine.getStats();
    expect(stats.totalFeedback).toBeGreaterThanOrEqual(1);
    expect(stats.positiveCount).toBeGreaterThanOrEqual(1);
  });

  // ── Fix 3: ActiveLearner receives gap sources and produces gaps with IDs ──

  it('ActiveLearner receives gap sources and produces gaps with IDs', () => {
    runActiveLearningMigration(db);
    const learner = new ActiveLearner(db, { brainName: 'test' });

    // Identify gaps with real sources
    const gaps = learner.identifyGaps({
      knowledgeVoids: [
        { topic: 'quantum computing', description: 'No data on quantum algorithms' },
      ],
      lowConfidenceFacts: [
        { topic: 'neural networks', confidence: 0.1 },
      ],
    });

    expect(gaps.length).toBe(2);

    // Persist them via addGap
    const persisted = learner.addGap(gaps[0]!.gapType, gaps[0]!.topic, gaps[0]!.description);
    expect(persisted.id).toBeDefined();
    expect(persisted.id).toBeGreaterThan(0);

    // planLearning should work with the persisted ID
    const plan = learner.planLearning(persisted.id!);
    expect(plan).not.toBeNull();
    expect(plan!.strategy).toBe('research_mission');
  });

  // ── Fix 6: Research cycle start/end creates a trace ──

  it('Research cycle start/end creates a trace', () => {
    const collector = new TraceCollector(db);

    const traceId = collector.startTrace('research_cycle', { cycle: 1, brainName: 'test' });
    expect(traceId).toBeTruthy();

    collector.endTrace(traceId);

    // Check the trace was persisted
    const status = collector.getStatus();
    expect(status.totalTraces).toBeGreaterThanOrEqual(1);
  });
});
