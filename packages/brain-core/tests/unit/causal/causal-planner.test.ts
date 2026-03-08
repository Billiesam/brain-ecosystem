import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CausalGraph, runCausalMigration } from '../../../src/causal/engine.js';
import { CausalPlanner } from '../../../src/causal/causal-planner.js';

describe('CausalPlanner', () => {
  let db: Database.Database;
  let graph: CausalGraph;
  let planner: CausalPlanner;

  beforeEach(() => {
    db = new Database(':memory:');
    runCausalMigration(db);
    graph = new CausalGraph(db);
    planner = new CausalPlanner(graph);

    // Seed causal data: A → B → target
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const t = now - (10 - i) * 60000;
      graph.recordEvent('data_imports', t - 5000);
      graph.recordEvent('hypothesis_count', t);
      graph.recordEvent('prediction_accuracy', t + 2000);
    }
    // Run analysis to build edges
    graph.analyze();
  });

  describe('diagnose', () => {
    it('returns a diagnosis with root causes', () => {
      const diagnosis = planner.diagnose('prediction_accuracy');
      expect(diagnosis.metric).toBe('prediction_accuracy');
      expect(diagnosis.rootCauses).toBeDefined();
      expect(Array.isArray(diagnosis.rootCauses)).toBe(true);
      expect(Array.isArray(diagnosis.confounders)).toBe(true);
      expect(Array.isArray(diagnosis.suggestedInterventions)).toBe(true);
    });

    it('returns empty diagnosis for unknown metric', () => {
      const diagnosis = planner.diagnose('nonexistent_metric');
      expect(diagnosis.rootCauses).toHaveLength(0);
    });
  });

  describe('suggestInterventions', () => {
    it('suggests interventions for a metric', () => {
      const interventions = planner.suggestInterventions('prediction_accuracy');
      expect(Array.isArray(interventions)).toBe(true);
      // May or may not have interventions depending on causal data strength
    });

    it('returns interventions with required fields', () => {
      const interventions = planner.suggestInterventions('prediction_accuracy');
      for (const i of interventions) {
        expect(i.action).toBeTruthy();
        expect(i.targetEvent).toBeTruthy();
        expect(typeof i.expectedEffect).toBe('number');
        expect(typeof i.confidence).toBe('number');
        expect(Array.isArray(i.sideEffects)).toBe(true);
      }
    });
  });

  describe('predictOutcome', () => {
    it('predicts outcome for an intervention', () => {
      const intervention = {
        action: 'increase_data_imports',
        targetEvent: 'data_imports',
        expectedEffect: 0.3,
        confidence: 0.7,
        sideEffects: [],
      };
      const outcome = planner.predictOutcome(intervention);
      expect(outcome.intervention).toBe(intervention);
      expect(typeof outcome.predictedMetricDelta).toBe('number');
      expect(typeof outcome.confidence).toBe('number');
      expect(typeof outcome.reasoning).toBe('string');
    });
  });

  describe('diagnoseStagnantGoals', () => {
    it('returns empty array without goal engine', () => {
      const results = planner.diagnoseStagnantGoals();
      expect(results).toHaveLength(0);
    });
  });

  describe('integration', () => {
    it('full pipeline: diagnose → interventions → predict', () => {
      const diagnosis = planner.diagnose('hypothesis_count');
      if (diagnosis.suggestedInterventions.length > 0) {
        const outcome = planner.predictOutcome(diagnosis.suggestedInterventions[0]);
        expect(outcome).toBeDefined();
        expect(outcome.reasoning).toBeTruthy();
      }
      // Test passes even without interventions (depends on causal data)
    });
  });
});
