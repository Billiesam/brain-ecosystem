/**
 * RuntimeInfluenceTracker — Before/After snapshots per engine step.
 * Observes actual metric changes to build an influence graph.
 */
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface InfluenceEdge {
  source: string;
  target: string;
  strength: number;
  direction: number;    // +1 or -1
  observations: number;
}

export interface InfluenceGraph {
  edges: InfluenceEdge[];
  hubs: string[];     // engines affecting many metrics
  sinks: string[];    // metrics affected by many engines
}

export interface RuntimeInfluenceStatus {
  totalSnapshots: number;
  totalInfluences: number;
  trackedEngines: number;
}

// ── Migration ───────────────────────────────────────────

export function runRuntimeInfluenceMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_influences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_engine TEXT NOT NULL,
      affected_metric TEXT NOT NULL,
      delta REAL NOT NULL,
      cycle INTEGER NOT NULL,
      direction INTEGER NOT NULL DEFAULT 1,
      confidence REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS engine_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engine TEXT NOT NULL,
      cycle INTEGER NOT NULL,
      phase TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_engine_influences_source ON engine_influences(source_engine, cycle);
    CREATE INDEX IF NOT EXISTS idx_engine_snapshots_engine ON engine_snapshots(engine, cycle, phase);
  `);
}

// ── Tracker ─────────────────────────────────────────────

export class RuntimeInfluenceTracker {
  private db: Database.Database;
  private log = getLogger();
  private pendingSnapshots: Map<string, Record<string, number>> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
    runRuntimeInfluenceMigration(db);
  }

  /** Capture metrics before an engine step. */
  snapshotBefore(engineId: string, cycle: number): void {
    const metrics = this.captureMetrics();
    this.pendingSnapshots.set(`${engineId}:${cycle}`, metrics);
    this.db.prepare(`
      INSERT INTO engine_snapshots (engine, cycle, phase, metrics_json) VALUES (?, ?, 'before', ?)
    `).run(engineId, cycle, JSON.stringify(metrics));
  }

  /** Capture metrics after an engine step, compute deltas, record influences. */
  snapshotAfter(engineId: string, cycle: number): void {
    const afterMetrics = this.captureMetrics();
    this.db.prepare(`
      INSERT INTO engine_snapshots (engine, cycle, phase, metrics_json) VALUES (?, ?, 'after', ?)
    `).run(engineId, cycle, JSON.stringify(afterMetrics));

    const beforeMetrics = this.pendingSnapshots.get(`${engineId}:${cycle}`);
    if (!beforeMetrics) return;
    this.pendingSnapshots.delete(`${engineId}:${cycle}`);

    // Compute deltas
    const insertStmt = this.db.prepare(`
      INSERT INTO engine_influences (source_engine, affected_metric, delta, cycle, direction, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const allKeys = new Set([...Object.keys(beforeMetrics), ...Object.keys(afterMetrics)]);
    for (const metric of allKeys) {
      const before = beforeMetrics[metric] ?? 0;
      const after = afterMetrics[metric] ?? 0;
      const delta = after - before;
      if (delta !== 0) {
        const direction = delta > 0 ? 1 : -1;
        const confidence = Math.min(Math.abs(delta) / Math.max(before, 1), 1);
        insertStmt.run(engineId, metric, delta, cycle, direction, confidence);
      }
    }
  }

  /** Build an influence graph from recent observations. */
  buildInfluenceGraph(windowCycles = 50): InfluenceGraph {
    const rows = this.db.prepare(`
      SELECT source_engine, affected_metric,
             AVG(delta) as avg_delta,
             AVG(direction) as avg_direction,
             COUNT(*) as obs,
             AVG(confidence) as avg_conf
      FROM engine_influences
      WHERE cycle > (SELECT COALESCE(MAX(cycle), 0) FROM engine_influences) - ?
      GROUP BY source_engine, affected_metric
      HAVING COUNT(*) >= 2
    `).all(windowCycles) as Array<{
      source_engine: string;
      affected_metric: string;
      avg_delta: number;
      avg_direction: number;
      obs: number;
      avg_conf: number;
    }>;

    const edges: InfluenceEdge[] = rows.map(r => ({
      source: r.source_engine,
      target: r.affected_metric,
      strength: Math.abs(r.avg_delta) * r.avg_conf,
      direction: r.avg_direction >= 0 ? 1 : -1,
      observations: r.obs,
    }));

    // Hubs: engines with many outgoing edges
    const engineEdgeCount = new Map<string, number>();
    for (const e of edges) {
      engineEdgeCount.set(e.source, (engineEdgeCount.get(e.source) ?? 0) + 1);
    }
    const hubs = [...engineEdgeCount.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([engine]) => engine);

    // Sinks: metrics affected by many engines
    const metricEdgeCount = new Map<string, number>();
    for (const e of edges) {
      metricEdgeCount.set(e.target, (metricEdgeCount.get(e.target) ?? 0) + 1);
    }
    const sinks = [...metricEdgeCount.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([metric]) => metric);

    return { edges, hubs, sinks };
  }

  /** Feed engine influence data into the existing CausalGraph. */
  feedIntoCausalGraph(causalGraph: { recordEvent: (source: string, type: string, data?: unknown) => void }): void {
    const graph = this.buildInfluenceGraph(50);
    for (const edge of graph.edges) {
      try {
        causalGraph.recordEvent(
          `engine:${edge.source}`,
          edge.target,
          { value: edge.strength * edge.direction, observations: edge.observations, fromInfluenceTracker: true },
        );
      } catch {
        // best effort
      }
    }
    if (graph.edges.length > 0) {
      this.log.debug(`[influence-tracker] Fed ${graph.edges.length} edges into CausalGraph`);
    }
  }

  /** Get recent influences for a specific engine. */
  getInfluences(engineId: string, limit = 20): Array<{ metric: string; delta: number; cycle: number; confidence: number }> {
    return this.db.prepare(`
      SELECT affected_metric as metric, delta, cycle, confidence
      FROM engine_influences WHERE source_engine = ?
      ORDER BY cycle DESC LIMIT ?
    `).all(engineId, limit) as Array<{ metric: string; delta: number; cycle: number; confidence: number }>;
  }

  /** Get status summary. */
  getStatus(): RuntimeInfluenceStatus {
    const snapshots = (this.db.prepare('SELECT COUNT(*) as c FROM engine_snapshots').get() as { c: number }).c;
    const influences = (this.db.prepare('SELECT COUNT(*) as c FROM engine_influences').get() as { c: number }).c;
    const engines = (this.db.prepare('SELECT COUNT(DISTINCT source_engine) as c FROM engine_influences').get() as { c: number }).c;
    return { totalSnapshots: snapshots, totalInfluences: influences, trackedEngines: engines };
  }

  // ── Private ─────────────────────────────────────────────

  /** Capture current metric counts from key tables. */
  private captureMetrics(): Record<string, number> {
    const metrics: Record<string, number> = {};
    const tables = [
      'insights', 'anomalies', 'hypotheses', 'journal_entries',
      'predictions', 'principles', 'causal_edges',
    ];
    for (const table of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number } | undefined;
        metrics[table] = row?.c ?? 0;
      } catch {
        // Table may not exist in all brains
      }
    }
    return metrics;
  }
}
