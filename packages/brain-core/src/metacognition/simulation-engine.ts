import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';
import type { PredictionEngine } from '../prediction/prediction-engine.js';
import type { CausalGraph } from '../causal/engine.js';
import type { MetaCognitionLayer } from './meta-cognition-layer.js';

// ── Types ───────────────────────────────────────────────

export interface SimulationOutcome {
  metric: string;
  predicted: number;
  direction: 'increase' | 'decrease' | 'stable';
  confidence: number;
}

export interface Simulation {
  id?: number;
  scenario: string;
  parameters: Record<string, unknown>;
  predictedOutcomes: SimulationOutcome[];
  actualOutcomes: SimulationOutcome[] | null;
  accuracy: number | null;
  simulatedAt: string;
  validatedAt: string | null;
}

export interface SimulationStatus {
  totalSimulations: number;
  validatedCount: number;
  avgAccuracy: number;
  recentSimulations: Simulation[];
}

// ── Migration ───────────────────────────────────────────

export function runSimulationMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS simulations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '{}',
      predicted_outcomes TEXT NOT NULL DEFAULT '[]',
      actual_outcomes TEXT DEFAULT NULL,
      accuracy REAL DEFAULT NULL,
      simulated_at TEXT DEFAULT (datetime('now')),
      validated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_simulations_accuracy ON simulations(accuracy);
  `);
}

// ── SimulationEngine ───────────────────────────────────

export class SimulationEngine {
  private db: Database.Database;
  private thoughtStream: ThoughtStream | null = null;
  private predictionEngine: PredictionEngine | null = null;
  private causalGraph: CausalGraph | null = null;
  private metaCognition: MetaCognitionLayer | null = null;
  private log = getLogger();

  constructor(db: Database.Database) {
    this.db = db;
    runSimulationMigration(db);
  }

  setThoughtStream(stream: ThoughtStream): void {
    this.thoughtStream = stream;
  }

  setPredictionEngine(engine: PredictionEngine): void {
    this.predictionEngine = engine;
  }

  setCausalGraph(graph: CausalGraph): void {
    this.causalGraph = graph;
  }

  setMetaCognitionLayer(layer: MetaCognitionLayer): void {
    this.metaCognition = layer;
  }

  /**
   * Simulate a scenario: parse key metrics, find downstream causal effects,
   * predict directions and magnitudes, persist and return.
   */
  simulate(scenario: string): Simulation {
    const parsed = this.parseScenario(scenario);
    const predictedOutcomes: SimulationOutcome[] = [];

    // Gather baseline from PredictionEngine if available
    const baselineMetrics: Record<string, number> = {};
    if (this.predictionEngine) {
      try {
        const summary = this.predictionEngine.getSummary();
        if (summary.recent) {
          for (const pred of summary.recent) {
            baselineMetrics[pred.metric] = pred.predicted_value;
          }
        }
      } catch {
        // No baseline available
      }
    }

    // For each parsed scenario component, find downstream causal effects
    for (const { metric, multiplier } of parsed) {
      if (this.causalGraph) {
        const effects = this.causalGraph.getEffects(metric);

        for (const edge of effects) {
          // Predict direction based on edge direction and multiplier
          const effectiveDirection = edge.direction * (multiplier >= 1 ? 1 : -1);
          const direction: SimulationOutcome['direction'] =
            effectiveDirection > 0 ? 'increase' : effectiveDirection < 0 ? 'decrease' : 'stable';

          // Predict magnitude based on multiplier and edge strength
          const baseline = baselineMetrics[edge.effect] ?? 1;
          const delta = (multiplier - 1) * edge.strength;
          const predicted = baseline * (1 + delta * edge.direction);

          // Confidence is based on edge strength, confidence, and sample size
          const sampleFactor = Math.min(1, edge.sample_size / 20);
          const confidence = edge.strength * edge.confidence * sampleFactor;

          predictedOutcomes.push({
            metric: edge.effect,
            predicted: Math.round(predicted * 1000) / 1000,
            direction,
            confidence: Math.round(confidence * 1000) / 1000,
          });
        }
      }

      // Also add the direct metric itself
      const baseline = baselineMetrics[metric] ?? 1;
      const predicted = baseline * multiplier;
      predictedOutcomes.push({
        metric,
        predicted: Math.round(predicted * 1000) / 1000,
        direction: multiplier > 1 ? 'increase' : multiplier < 1 ? 'decrease' : 'stable',
        confidence: 0.8, // Direct metric — high confidence
      });
    }

    // If no causal graph and no parsed metrics, generate a generic outcome
    if (predictedOutcomes.length === 0) {
      predictedOutcomes.push({
        metric: 'unknown',
        predicted: 0,
        direction: 'stable',
        confidence: 0.1,
      });
    }

    const parameters: Record<string, unknown> = {
      parsedMetrics: parsed,
      baselineAvailable: Object.keys(baselineMetrics).length > 0,
      causalEdgesUsed: predictedOutcomes.length - parsed.length,
    };

    // Persist
    const result = this.db.prepare(`
      INSERT INTO simulations (scenario, parameters, predicted_outcomes)
      VALUES (?, ?, ?)
    `).run(
      scenario,
      JSON.stringify(parameters),
      JSON.stringify(predictedOutcomes),
    );

    const simulation: Simulation = {
      id: result.lastInsertRowid as number,
      scenario,
      parameters,
      predictedOutcomes,
      actualOutcomes: null,
      accuracy: null,
      simulatedAt: new Date().toISOString(),
      validatedAt: null,
    };

    this.log.info(`[simulation] Simulated "${scenario}": ${predictedOutcomes.length} predicted outcomes`);
    this.thoughtStream?.emit(
      'simulation-engine', 'analyzing',
      `Simulated scenario: "${scenario}" → ${predictedOutcomes.length} outcomes predicted`,
      predictedOutcomes.length >= 3 ? 'notable' : 'routine',
      { simulationId: simulation.id, outcomes: predictedOutcomes.length },
    );

    return simulation;
  }

  /** Shortcut: simulate what happens when a metric changes by a multiplier. */
  whatIf(metric: string, multiplier: number): Simulation {
    const scenario = multiplier >= 1
      ? `${metric} increases by ${Math.round((multiplier - 1) * 100)}%`
      : `${metric} decreases by ${Math.round((1 - multiplier) * 100)}%`;
    return this.simulate(scenario);
  }

  /** Validate a simulation against actual outcomes. */
  validateSimulation(id: number, actualOutcomes: SimulationOutcome[]): Simulation | null {
    const row = this.db.prepare('SELECT * FROM simulations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const sim = this.toSimulation(row);
    const predicted = sim.predictedOutcomes;

    // Compute accuracy: matching directions / total predicted
    let matches = 0;
    let compared = 0;

    for (const pred of predicted) {
      const actual = actualOutcomes.find(a => a.metric === pred.metric);
      if (actual) {
        compared++;
        if (actual.direction === pred.direction) {
          matches++;
        }
      }
    }

    const accuracy = compared > 0 ? matches / compared : 0;

    this.db.prepare(`
      UPDATE simulations SET actual_outcomes = ?, accuracy = ?, validated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(actualOutcomes),
      accuracy,
      id,
    );

    this.log.info(`[simulation] Validated #${id}: accuracy=${(accuracy * 100).toFixed(1)}% (${matches}/${compared} correct)`);
    this.thoughtStream?.emit(
      'simulation-engine', 'analyzing',
      `Simulation #${id} validated: ${(accuracy * 100).toFixed(1)}% accuracy`,
      accuracy >= 0.7 ? 'notable' : 'routine',
      { simulationId: id, accuracy, matches, compared },
    );

    return {
      ...sim,
      actualOutcomes,
      accuracy,
      validatedAt: new Date().toISOString(),
    };
  }

  /** List recent simulations. */
  listSimulations(limit = 20): Simulation[] {
    const rows = this.db.prepare(
      'SELECT * FROM simulations ORDER BY id DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.toSimulation(r));
  }

  /** Get overall accuracy metrics. */
  getAccuracy(): { avgAccuracy: number; validatedCount: number; totalSimulations: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM simulations').get() as { c: number }).c;
    const validated = this.db.prepare(
      'SELECT COUNT(*) as c, AVG(accuracy) as avg FROM simulations WHERE accuracy IS NOT NULL',
    ).get() as { c: number; avg: number | null };

    return {
      avgAccuracy: validated.avg ?? 0,
      validatedCount: validated.c,
      totalSimulations: total,
    };
  }

  /** Get status summary. */
  getStatus(): SimulationStatus {
    const accuracy = this.getAccuracy();
    const recent = this.listSimulations(10);

    return {
      totalSimulations: accuracy.totalSimulations,
      validatedCount: accuracy.validatedCount,
      avgAccuracy: accuracy.avgAccuracy,
      recentSimulations: recent,
    };
  }

  // ── Private ──────────────────────────────────────────────

  private toSimulation(row: Record<string, unknown>): Simulation {
    return {
      id: row.id as number,
      scenario: row.scenario as string,
      parameters: JSON.parse((row.parameters as string) || '{}'),
      predictedOutcomes: JSON.parse((row.predicted_outcomes as string) || '[]'),
      actualOutcomes: row.actual_outcomes ? JSON.parse(row.actual_outcomes as string) : null,
      accuracy: row.accuracy as number | null,
      simulatedAt: row.simulated_at as string,
      validatedAt: (row.validated_at as string) ?? null,
    };
  }

  /**
   * Parse a scenario string into metric+multiplier pairs.
   * Supports patterns like:
   *   "error_rate doubles"       → { metric: 'error_rate', multiplier: 2 }
   *   "error_rate triples"       → { metric: 'error_rate', multiplier: 3 }
   *   "error_rate halves"        → { metric: 'error_rate', multiplier: 0.5 }
   *   "error_rate increases by 50%"  → { metric: 'error_rate', multiplier: 1.5 }
   *   "error_rate decreases by 30%"  → { metric: 'error_rate', multiplier: 0.7 }
   */
  private parseScenario(scenario: string): Array<{ metric: string; multiplier: number }> {
    const results: Array<{ metric: string; multiplier: number }> = [];
    const lower = scenario.toLowerCase();

    // Pattern: "X doubles/triples/halves"
    const simpleMatch = lower.match(/(\w[\w._-]*)\s+(doubles?|triples?|halves?)/g);
    if (simpleMatch) {
      for (const m of simpleMatch) {
        const parts = m.match(/(\w[\w._-]*)\s+(doubles?|triples?|halves?)/);
        if (parts) {
          const metric = parts[1];
          const verb = parts[2];
          let multiplier = 1;
          if (verb.startsWith('double')) multiplier = 2;
          else if (verb.startsWith('triple')) multiplier = 3;
          else if (verb.startsWith('halv')) multiplier = 0.5;
          results.push({ metric, multiplier });
        }
      }
    }

    // Pattern: "X increases/decreases by N%"
    const pctMatch = lower.match(/(\w[\w._-]*)\s+(increases?|decreases?)\s+by\s+(\d+)%/g);
    if (pctMatch) {
      for (const m of pctMatch) {
        const parts = m.match(/(\w[\w._-]*)\s+(increases?|decreases?)\s+by\s+(\d+)%/);
        if (parts) {
          const metric = parts[1];
          const dir = parts[2];
          const pct = parseInt(parts[3], 10);
          const multiplier = dir.startsWith('increase')
            ? 1 + pct / 100
            : 1 - pct / 100;
          results.push({ metric, multiplier });
        }
      }
    }

    // Fallback: treat entire scenario as a single metric with no change
    if (results.length === 0) {
      // Try to extract any word-like metric name
      const words = scenario.replace(/[^a-zA-Z0-9_.-]/g, ' ').split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        results.push({ metric: words[0], multiplier: 1.5 }); // Default: assume 50% increase
      }
    }

    return results;
  }
}
