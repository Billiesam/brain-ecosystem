import type { CausalGraph, CausalEdge } from './engine.js';
import type { GoalEngine, Goal } from '../goals/goal-engine.js';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface CausalDiagnosis {
  metric: string;
  rootCauses: Array<{
    event: string;
    strength: number;
    lag_ms: number;
    confidence: number;
  }>;
  confounders: string[];
  suggestedInterventions: Intervention[];
}

export interface Intervention {
  action: string;
  targetEvent: string;
  expectedEffect: number;
  confidence: number;
  sideEffects: string[];
}

export interface PredictedOutcome {
  intervention: Intervention;
  predictedMetricDelta: number;
  confidence: number;
  reasoning: string;
}

// ── CausalPlanner ────────────────────────────────────────

export class CausalPlanner {
  private readonly causalGraph: CausalGraph;
  private readonly log = getLogger();
  private goalEngine: GoalEngine | null = null;

  constructor(causalGraph: CausalGraph) {
    this.causalGraph = causalGraph;
  }

  setGoalEngine(engine: GoalEngine): void { this.goalEngine = engine; }

  // ── Diagnose ───────────────────────────────────────────

  /** Find root causes for a metric being off-target. */
  diagnose(goalMetric: string): CausalDiagnosis {
    const causes = this.causalGraph.getCauses(goalMetric);

    // Sort by strength × confidence for strongest causes first
    const ranked = causes
      .sort((a, b) => (b.strength * b.confidence) - (a.strength * a.confidence))
      .slice(0, 10);

    const rootCauses = ranked.map(edge => ({
      event: edge.cause,
      strength: edge.strength,
      lag_ms: edge.lag_ms,
      confidence: edge.confidence,
    }));

    // Find deeper root causes via chains
    const deepRoots: typeof rootCauses = [];
    const allChains = this.causalGraph.findChains();
    for (const cause of rootCauses.slice(0, 3)) {
      // Filter chains that contain our cause and the goalMetric
      const relevant = allChains.filter(c =>
        c.chain.includes(cause.event) && c.chain.includes(goalMetric),
      );
      for (const chain of relevant) {
        if (chain.chain.length > 2) {
          const origin = chain.chain[0];
          if (!rootCauses.some(r => r.event === origin) && !deepRoots.some(r => r.event === origin)) {
            deepRoots.push({
              event: origin,
              strength: chain.totalStrength,
              lag_ms: chain.totalLag,
              confidence: chain.totalStrength, // approximate
            });
          }
        }
      }
    }

    // Find confounders between each cause and the metric
    const confounders: string[] = [];
    for (const cause of rootCauses.slice(0, 5)) {
      try {
        const cf = this.causalGraph.detectConfounders(cause.event, goalMetric);
        for (const c of cf) {
          if (!confounders.includes(c)) confounders.push(c);
        }
      } catch { /* no confounders */ }
    }

    const allRootCauses = [...rootCauses, ...deepRoots];
    const interventions = this.suggestInterventionsFromCauses(allRootCauses, goalMetric);

    this.log.info(`[causal-planner] Diagnosed ${goalMetric}: ${allRootCauses.length} root causes, ${confounders.length} confounders`);

    return {
      metric: goalMetric,
      rootCauses: allRootCauses,
      confounders,
      suggestedInterventions: interventions,
    };
  }

  // ── Suggest Interventions ──────────────────────────────

  /** Generate intervention suggestions based on causal analysis. */
  suggestInterventions(goalMetric: string): Intervention[] {
    const diagnosis = this.diagnose(goalMetric);
    return diagnosis.suggestedInterventions;
  }

  private suggestInterventionsFromCauses(
    rootCauses: CausalDiagnosis['rootCauses'],
    targetMetric: string,
  ): Intervention[] {
    const interventions: Intervention[] = [];

    for (const cause of rootCauses.slice(0, 5)) {
      // Determine action based on edge direction
      const effects = this.causalGraph.getEffects(cause.event);
      const targetEdge = effects.find(e => e.effect === targetMetric);
      // direction is number: +1 = positive, -1 = negative
      const directionNum = targetEdge?.direction ?? 1;

      const action = directionNum >= 0
        ? `increase_${cause.event}`
        : `decrease_${cause.event}`;

      // Find potential side effects — other things caused by this event
      const sideEffects = effects
        .filter(e => e.effect !== targetMetric)
        .map(e => `${e.direction >= 0 ? '+' : '-'}${e.effect} (strength: ${e.strength.toFixed(2)})`);

      interventions.push({
        action,
        targetEvent: cause.event,
        expectedEffect: cause.strength * directionNum,
        confidence: cause.confidence,
        sideEffects,
      });
    }

    return interventions;
  }

  // ── Predict Outcome ────────────────────────────────────

  /** Predict what happens if an intervention is applied. */
  predictOutcome(intervention: Intervention): PredictedOutcome {
    const predictedDelta = intervention.expectedEffect;
    const confidence = intervention.confidence;
    const reasoning = `Direct causal effect of ${intervention.action} on ${intervention.targetEvent}`;

    return {
      intervention,
      predictedMetricDelta: predictedDelta,
      confidence,
      reasoning,
    };
  }

  // ── Goal Integration ───────────────────────────────────

  /** Diagnose stagnant goals and suggest causal interventions. */
  diagnoseStagnantGoals(): Array<{ goal: Goal; diagnosis: CausalDiagnosis }> {
    if (!this.goalEngine) return [];

    const results: Array<{ goal: Goal; diagnosis: CausalDiagnosis }> = [];
    const activeGoals = this.goalEngine.listGoals('active');

    for (const goal of activeGoals) {
      const progress = this.goalEngine.getProgress(goal.id!);
      if (progress && progress.trend === 'stagnant') {
        try {
          const diagnosis = this.diagnose(goal.metricName);
          if (diagnosis.rootCauses.length > 0) {
            results.push({ goal, diagnosis });
          }
        } catch {
          // No causal data for this metric
        }
      }
    }

    return results;
  }
}
