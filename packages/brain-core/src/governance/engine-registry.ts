/**
 * EngineRegistry — Declarative engine profiles with dependency tracking.
 * Each engine gets a formal profile: reads, writes, emits, subscribes, risk, invariants.
 */
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface EngineProfile {
  id: string;
  reads: string[];
  writes: string[];
  emits: string[];
  subscribes: string[];
  frequency: 'every_cycle' | 'every_N' | 'on_demand';
  frequencyN: number;
  riskClass: 'low' | 'medium' | 'high';
  expectedEffects: string[];
  invariants: string[];
  enabled: boolean;
}

export interface EngineRegistryStatus {
  totalEngines: number;
  enabledEngines: number;
  disabledEngines: number;
  riskDistribution: Record<string, number>;
  dependencyEdges: number;
}

// ── Migration ───────────────────────────────────────────

export function runEngineRegistryMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_registry (
      id TEXT PRIMARY KEY,
      reads_json TEXT NOT NULL DEFAULT '[]',
      writes_json TEXT NOT NULL DEFAULT '[]',
      emits_json TEXT NOT NULL DEFAULT '[]',
      subscribes_json TEXT NOT NULL DEFAULT '[]',
      frequency TEXT NOT NULL DEFAULT 'every_cycle',
      frequency_n INTEGER NOT NULL DEFAULT 1,
      risk_class TEXT NOT NULL DEFAULT 'low',
      expected_effects_json TEXT NOT NULL DEFAULT '[]',
      invariants_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ── Registry ────────────────────────────────────────────

export class EngineRegistry {
  private db: Database.Database;
  private cache: Map<string, EngineProfile> = new Map();
  private log = getLogger();

  constructor(db: Database.Database) {
    this.db = db;
    runEngineRegistryMigration(db);
    this.loadAll();
  }

  /** Register or update an engine profile. */
  register(profile: EngineProfile): void {
    this.db.prepare(`
      INSERT INTO engine_registry (id, reads_json, writes_json, emits_json, subscribes_json, frequency, frequency_n, risk_class, expected_effects_json, invariants_json, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        reads_json = excluded.reads_json,
        writes_json = excluded.writes_json,
        emits_json = excluded.emits_json,
        subscribes_json = excluded.subscribes_json,
        frequency = excluded.frequency,
        frequency_n = excluded.frequency_n,
        risk_class = excluded.risk_class,
        expected_effects_json = excluded.expected_effects_json,
        invariants_json = excluded.invariants_json,
        enabled = excluded.enabled,
        updated_at = datetime('now')
    `).run(
      profile.id,
      JSON.stringify(profile.reads),
      JSON.stringify(profile.writes),
      JSON.stringify(profile.emits),
      JSON.stringify(profile.subscribes),
      profile.frequency,
      profile.frequencyN,
      profile.riskClass,
      JSON.stringify(profile.expectedEffects),
      JSON.stringify(profile.invariants),
      profile.enabled ? 1 : 0,
    );
    this.cache.set(profile.id, { ...profile });
    this.log.debug(`[engine-registry] Registered: ${profile.id} (risk=${profile.riskClass})`);
  }

  /** Get a single engine profile. */
  get(id: string): EngineProfile | undefined {
    return this.cache.get(id);
  }

  /** List all registered engine profiles. */
  list(): EngineProfile[] {
    return [...this.cache.values()];
  }

  /** List only enabled engine profiles. */
  listEnabled(): EngineProfile[] {
    return [...this.cache.values()].filter(p => p.enabled);
  }

  /**
   * Build a dependency graph: engine → engines it depends on.
   * Engine A depends on Engine B if A.reads intersects B.writes.
   */
  getDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    const profiles = this.list();

    for (const consumer of profiles) {
      const deps: string[] = [];
      for (const producer of profiles) {
        if (producer.id === consumer.id) continue;
        // Consumer reads what producer writes
        const overlap = consumer.reads.some(r => producer.writes.includes(r));
        if (overlap) deps.push(producer.id);
      }
      graph.set(consumer.id, deps);
    }

    return graph;
  }

  /** Get reverse dependencies: engine → engines that depend on it. */
  getReverseDependencyGraph(): Map<string, string[]> {
    const forward = this.getDependencyGraph();
    const reverse = new Map<string, string[]>();

    for (const id of this.cache.keys()) {
      reverse.set(id, []);
    }

    for (const [consumer, deps] of forward) {
      for (const dep of deps) {
        const arr = reverse.get(dep);
        if (arr) arr.push(consumer);
      }
    }

    return reverse;
  }

  /** Enable an engine. */
  enable(id: string): void {
    const profile = this.cache.get(id);
    if (!profile) return;
    profile.enabled = true;
    this.db.prepare('UPDATE engine_registry SET enabled = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    this.log.info(`[engine-registry] Enabled: ${id}`);
  }

  /** Disable an engine. */
  disable(id: string): void {
    const profile = this.cache.get(id);
    if (!profile) return;
    profile.enabled = false;
    this.db.prepare('UPDATE engine_registry SET enabled = 0, updated_at = datetime(\'now\') WHERE id = ?').run(id);
    this.log.info(`[engine-registry] Disabled: ${id}`);
  }

  /** Get overall status. */
  getStatus(): EngineRegistryStatus {
    const profiles = this.list();
    const enabled = profiles.filter(p => p.enabled).length;
    const risk: Record<string, number> = { low: 0, medium: 0, high: 0 };
    for (const p of profiles) {
      risk[p.riskClass] = (risk[p.riskClass] || 0) + 1;
    }

    let edgeCount = 0;
    for (const deps of this.getDependencyGraph().values()) {
      edgeCount += deps.length;
    }

    return {
      totalEngines: profiles.length,
      enabledEngines: enabled,
      disabledEngines: profiles.length - enabled,
      riskDistribution: risk,
      dependencyEdges: edgeCount,
    };
  }

  /** Find engines by risk class. */
  getByRisk(riskClass: 'low' | 'medium' | 'high'): EngineProfile[] {
    return this.list().filter(p => p.riskClass === riskClass);
  }

  /** Find engines that write to a specific resource. */
  findWriters(resource: string): EngineProfile[] {
    return this.list().filter(p => p.writes.includes(resource));
  }

  /** Find engines that read from a specific resource. */
  findReaders(resource: string): EngineProfile[] {
    return this.list().filter(p => p.reads.includes(resource));
  }

  // ── Private ─────────────────────────────────────────────

  private loadAll(): void {
    const rows = this.db.prepare('SELECT * FROM engine_registry').all() as Array<{
      id: string;
      reads_json: string;
      writes_json: string;
      emits_json: string;
      subscribes_json: string;
      frequency: string;
      frequency_n: number;
      risk_class: string;
      expected_effects_json: string;
      invariants_json: string;
      enabled: number;
    }>;

    for (const row of rows) {
      this.cache.set(row.id, {
        id: row.id,
        reads: JSON.parse(row.reads_json),
        writes: JSON.parse(row.writes_json),
        emits: JSON.parse(row.emits_json),
        subscribes: JSON.parse(row.subscribes_json),
        frequency: row.frequency as EngineProfile['frequency'],
        frequencyN: row.frequency_n,
        riskClass: row.risk_class as EngineProfile['riskClass'],
        expectedEffects: JSON.parse(row.expected_effects_json),
        invariants: JSON.parse(row.invariants_json),
        enabled: row.enabled === 1,
      });
    }
  }
}

// ── Default Engine Profiles ─────────────────────────────

export function getDefaultEngineProfiles(): EngineProfile[] {
  return [
    {
      id: 'self_observer', reads: ['journal_entries', 'engine_metrics'], writes: ['self_observations', 'self_insights'],
      emits: ['self_observer:reflecting'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'low', expectedEffects: ['self-awareness improvement'], invariants: ['observations always non-negative'], enabled: true,
    },
    {
      id: 'adaptive_strategy', reads: ['strategies', 'experiment_results'], writes: ['strategies'],
      emits: ['strategy:adapting'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'medium', expectedEffects: ['strategy optimization'], invariants: ['at least one active strategy'], enabled: true,
    },
    {
      id: 'experiment_engine', reads: ['experiments', 'hypotheses'], writes: ['experiments', 'experiment_conclusions'],
      emits: ['experiment:running'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'medium', expectedEffects: ['hypothesis validation'], invariants: ['experiment count >= 0'], enabled: true,
    },
    {
      id: 'cross_domain', reads: ['insights', 'anomalies'], writes: ['cross_domain_correlations'],
      emits: ['cross_domain:correlating'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'low', expectedEffects: ['cross-domain correlation discovery'], invariants: [], enabled: true,
    },
    {
      id: 'knowledge_distiller', reads: ['insights', 'journal_entries', 'hypotheses'], writes: ['principles', 'anti_patterns', 'knowledge_strategies'],
      emits: ['distiller:distilling'], subscribes: [], frequency: 'every_N', frequencyN: 5,
      riskClass: 'low', expectedEffects: ['knowledge consolidation'], invariants: ['principles count non-decreasing'], enabled: true,
    },
    {
      id: 'anomaly_detective', reads: ['engine_metrics', 'insights'], writes: ['anomalies'],
      emits: ['anomaly:detected'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'low', expectedEffects: ['anomaly detection'], invariants: [], enabled: true,
    },
    {
      id: 'hypothesis_engine', reads: ['observations', 'insights'], writes: ['hypotheses'],
      emits: ['hypothesis:testing'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'low', expectedEffects: ['hypothesis generation and validation'], invariants: ['confidence in [0,1]'], enabled: true,
    },
    {
      id: 'causal_graph', reads: ['causal_events'], writes: ['causal_edges'],
      emits: ['causal:discovering'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'low', expectedEffects: ['causal relationship discovery'], invariants: ['edge strength in [0,1]'], enabled: true,
    },
    {
      id: 'prediction_engine', reads: ['engine_metrics', 'causal_edges'], writes: ['predictions'],
      emits: ['prediction:forecasting'], subscribes: [], frequency: 'every_N', frequencyN: 3,
      riskClass: 'medium', expectedEffects: ['metric forecasting', 'prediction accuracy improvement'], invariants: ['predictions have confidence'], enabled: true,
    },
    {
      id: 'dream_engine', reads: ['insights', 'synapses', 'journal_entries'], writes: ['dream_history', 'synapses'],
      emits: ['dream:consolidating'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'medium', expectedEffects: ['memory consolidation', 'synapse pruning'], invariants: ['synapse count stable after prune'], enabled: true,
    },
    {
      id: 'attention_engine', reads: ['engine_metrics', 'thoughts'], writes: ['attention_scores', 'context_switches'],
      emits: ['attention:focusing'], subscribes: [], frequency: 'every_cycle', frequencyN: 1,
      riskClass: 'low', expectedEffects: ['focus prioritization'], invariants: ['total weight = 1.0'], enabled: true,
    },
    {
      id: 'curiosity_engine', reads: ['knowledge_gaps', 'insights'], writes: ['knowledge_gaps', 'exploration_records'],
      emits: ['curiosity:exploring'], subscribes: [], frequency: 'every_N', frequencyN: 5,
      riskClass: 'low', expectedEffects: ['knowledge gap identification', 'exploration'], invariants: [], enabled: true,
    },
    {
      id: 'emergence_engine', reads: ['insights', 'synapses', 'causal_edges'], writes: ['emergence_events'],
      emits: ['emergence:detecting'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'low', expectedEffects: ['emergent pattern detection'], invariants: [], enabled: true,
    },
    {
      id: 'meta_cognition', reads: ['engine_metrics', 'engine_report_cards'], writes: ['engine_report_cards', 'frequency_adjustments'],
      emits: ['metacognition:evaluating'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'medium', expectedEffects: ['engine frequency optimization', 'performance grading'], invariants: ['grades in A-F range'], enabled: true,
    },
    {
      id: 'evolution_engine', reads: ['parameter_registry', 'engine_report_cards'], writes: ['evolution_individuals', 'evolution_generations', 'parameter_registry'],
      emits: ['evolution:reflecting'], subscribes: [], frequency: 'every_N', frequencyN: 20,
      riskClass: 'high', expectedEffects: ['parameter optimization', 'fitness improvement'], invariants: ['fitness >= 0', 'parameters within bounds'], enabled: true,
    },
    {
      id: 'narrative_engine', reads: ['journal_entries', 'insights', 'predictions'], writes: ['narratives', 'contradictions'],
      emits: ['narrative:synthesizing'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'low', expectedEffects: ['narrative coherence', 'contradiction detection'], invariants: [], enabled: true,
    },
    {
      id: 'reasoning_engine', reads: ['hypotheses', 'causal_edges', 'principles'], writes: ['inference_chains', 'abductive_explanations'],
      emits: ['reasoning:inferring'], subscribes: [], frequency: 'every_N', frequencyN: 5,
      riskClass: 'low', expectedEffects: ['logical inference', 'abductive reasoning'], invariants: [], enabled: true,
    },
    {
      id: 'creative_engine', reads: ['principles', 'hypotheses', 'knowledge_distiller'], writes: ['creative_insights'],
      emits: ['creative:pollinating'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'low', expectedEffects: ['cross-domain idea generation', 'analogy discovery'], invariants: ['novelty_score in [0,1]'], enabled: true,
    },
    {
      id: 'action_bridge', reads: ['action_queue'], writes: ['action_queue', 'action_outcomes'],
      emits: ['action:executing'], subscribes: [], frequency: 'every_N', frequencyN: 5,
      riskClass: 'high', expectedEffects: ['autonomous action execution'], invariants: ['risk-assessed before execution'], enabled: true,
    },
    {
      id: 'content_forge', reads: ['creative_insights'], writes: ['content_pieces', 'content_engagement'],
      emits: ['content:generating'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'medium', expectedEffects: ['content generation from insights'], invariants: [], enabled: true,
    },
    {
      id: 'code_forge', reads: ['code_health_scans'], writes: ['code_patterns', 'code_products'],
      emits: ['codeforge:extracting'], subscribes: [], frequency: 'every_N', frequencyN: 15,
      riskClass: 'medium', expectedEffects: ['code pattern extraction'], invariants: [], enabled: true,
    },
    {
      id: 'strategy_forge', reads: ['principles', 'knowledge_distiller'], writes: ['strategies', 'strategy_rules'],
      emits: ['strategy:executing'], subscribes: [], frequency: 'every_N', frequencyN: 20,
      riskClass: 'high', expectedEffects: ['strategy creation and execution'], invariants: ['rule confidence in [0,1]'], enabled: true,
    },
    {
      id: 'guardrail_engine', reads: ['parameter_registry', 'goals'], writes: ['guardrail_changelog', 'health_reports'],
      emits: ['guardrails:checking'], subscribes: [], frequency: 'every_N', frequencyN: 50,
      riskClass: 'low', expectedEffects: ['parameter bounds enforcement', 'circuit breaker protection'], invariants: ['circuit breaker state consistent'], enabled: true,
    },
    {
      id: 'debate_engine', reads: ['principles', 'hypotheses', 'journal_entries'], writes: ['debates'],
      emits: ['debate:starting'], subscribes: [], frequency: 'every_N', frequencyN: 10,
      riskClass: 'low', expectedEffects: ['multi-perspective analysis'], invariants: [], enabled: true,
    },
    {
      id: 'signal_router', reads: ['hypotheses', 'anomalies'], writes: ['cross_brain_signals'],
      emits: ['signal:emitting'], subscribes: ['trade_signal', 'engagement_signal', 'research_insight'], frequency: 'every_N', frequencyN: 10,
      riskClass: 'medium', expectedEffects: ['cross-brain signal propagation'], invariants: ['confidence in [0,1]'], enabled: true,
    },
  ];
}
