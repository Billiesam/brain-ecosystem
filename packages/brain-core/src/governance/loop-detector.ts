/**
 * LoopDetector — Anti-pattern detection for the engine ecosystem.
 * Detects: retrigger spirals, stagnation, KPI gaming, epistemic drift.
 */
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { RuntimeInfluenceTracker } from './runtime-influence-tracker.js';

// ── Types ───────────────────────────────────────────────

export type LoopType = 'retrigger_spiral' | 'stagnation' | 'kpi_gaming' | 'epistemic_drift';
export type LoopSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface LoopDetection {
  id: number;
  loopType: LoopType;
  severity: LoopSeverity;
  enginesInvolved: string[];
  description: string;
  evidence: Record<string, unknown>;
  cycle: number;
  resolved: boolean;
  createdAt: string;
}

export interface LoopDetectorStatus {
  totalDetections: number;
  activeDetections: number;
  byType: Record<LoopType, number>;
}

// ── Migration ───────────────────────────────────────────

export function runLoopDetectorMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_detections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loop_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      engines_involved TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence_json TEXT NOT NULL DEFAULT '{}',
      cycle INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_loop_detections_cycle ON loop_detections(cycle, resolved);
  `);
}

// ── LoopDetector ────────────────────────────────────────

export class LoopDetector {
  private db: Database.Database;
  private log = getLogger();
  private influenceTracker: RuntimeInfluenceTracker | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    runLoopDetectorMigration(db);
  }

  setInfluenceTracker(tracker: RuntimeInfluenceTracker): void {
    this.influenceTracker = tracker;
  }

  /** Run all 4 detectors and record findings. Returns new detections. */
  detect(cycle: number): LoopDetection[] {
    const detections: LoopDetection[] = [];
    detections.push(...this.detectRetriggerSpirals(cycle));
    detections.push(...this.detectStagnation(cycle));
    detections.push(...this.detectKpiGaming(cycle));
    detections.push(...this.detectEpistemicDrift(cycle));
    return detections;
  }

  /** Get all active (unresolved) detections. */
  getActive(): LoopDetection[] {
    const rows = this.db.prepare(
      'SELECT * FROM loop_detections WHERE resolved = 0 ORDER BY cycle DESC LIMIT 50'
    ).all() as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToDetection(r));
  }

  /** Resolve a detection. */
  resolve(id: number): void {
    this.db.prepare('UPDATE loop_detections SET resolved = 1 WHERE id = ?').run(id);
  }

  /** Get status summary. */
  getStatus(): LoopDetectorStatus {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM loop_detections').get() as { c: number }).c;
    const active = (this.db.prepare('SELECT COUNT(*) as c FROM loop_detections WHERE resolved = 0').get() as { c: number }).c;
    const byTypeRows = this.db.prepare(
      'SELECT loop_type, COUNT(*) as c FROM loop_detections WHERE resolved = 0 GROUP BY loop_type'
    ).all() as Array<{ loop_type: string; c: number }>;
    const byType: Record<string, number> = { retrigger_spiral: 0, stagnation: 0, kpi_gaming: 0, epistemic_drift: 0 };
    for (const r of byTypeRows) byType[r.loop_type] = r.c;
    return { totalDetections: total, activeDetections: active, byType: byType as Record<LoopType, number> };
  }

  // ── Detector 1: Retrigger Spirals ───────────────────────

  private detectRetriggerSpirals(cycle: number): LoopDetection[] {
    if (!this.influenceTracker) return [];
    const graph = this.influenceTracker.buildInfluenceGraph(30);
    const detections: LoopDetection[] = [];

    // Build adjacency from influence edges (engine → metric → engine that reads it)
    const adj = new Map<string, Set<string>>();
    for (const edge of graph.edges) {
      if (!adj.has(edge.source)) adj.set(edge.source, new Set());
      // edge.target is a metric, find engines that also influence the same metric
      for (const other of graph.edges) {
        if (other.source !== edge.source && other.target === edge.target) {
          adj.get(edge.source)!.add(other.source);
        }
      }
    }

    // DFS cycle detection
    const visited = new Set<string>();
    const stack = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (node: string, path: string[]): void => {
      if (stack.has(node)) {
        const cycleStart = path.indexOf(node);
        if (cycleStart >= 0) cycles.push(path.slice(cycleStart));
        return;
      }
      if (visited.has(node)) return;
      visited.add(node);
      stack.add(node);
      for (const neighbor of adj.get(node) ?? []) {
        dfs(neighbor, [...path, node]);
      }
      stack.delete(node);
    };

    for (const node of adj.keys()) {
      dfs(node, []);
    }

    for (const c of cycles.slice(0, 3)) {
      const detection = this.record({
        loopType: 'retrigger_spiral',
        severity: c.length > 3 ? 'high' : 'medium',
        enginesInvolved: c,
        description: `Retrigger spiral detected: ${c.join(' → ')} → ${c[0]}`,
        evidence: { cycleLength: c.length, path: c },
        cycle,
      });
      detections.push(detection);
    }

    return detections;
  }

  // ── Detector 2: Stagnation ──────────────────────────────

  private detectStagnation(cycle: number): LoopDetection[] {
    const detections: LoopDetection[] = [];

    // Check engine_metrics for identical values over last 5 cycles
    try {
      const engines = this.db.prepare(`
        SELECT DISTINCT engine FROM engine_metrics
        WHERE cycle > ? - 6 AND cycle <= ?
      `).all(cycle, cycle) as Array<{ engine: string }>;

      for (const { engine } of engines) {
        const rows = this.db.prepare(`
          SELECT insights, anomalies, predictions FROM engine_metrics
          WHERE engine = ? AND cycle > ? - 6 AND cycle <= ?
          ORDER BY cycle ASC
        `).all(engine, cycle, cycle) as Array<{ insights: number; anomalies: number; predictions: number }>;

        if (rows.length >= 5) {
          const allSame = rows.every(r =>
            r.insights === rows[0].insights &&
            r.anomalies === rows[0].anomalies &&
            r.predictions === rows[0].predictions
          );
          if (allSame && rows[0].insights === 0 && rows[0].predictions === 0) {
            detections.push(this.record({
              loopType: 'stagnation',
              severity: 'medium',
              enginesInvolved: [engine],
              description: `Engine "${engine}" produced no output for 5+ cycles`,
              evidence: { consecutiveCycles: rows.length, metrics: rows[0] },
              cycle,
            }));
          }
        }
      }
    } catch {
      // engine_metrics table may not exist
    }

    return detections;
  }

  // ── Detector 3: KPI Gaming ──────────────────────────────

  private detectKpiGaming(cycle: number): LoopDetection[] {
    const detections: LoopDetection[] = [];

    try {
      // Check if any engine's combined_score rises while system knowledge_quality drops
      const recentCards = this.db.prepare(`
        SELECT engine, combined_score FROM engine_report_cards
        WHERE rowid > (SELECT MAX(rowid) - 20 FROM engine_report_cards)
        ORDER BY engine, rowid ASC
      `).all() as Array<{ engine: string; combined_score: number }>;

      // Group by engine
      const byEngine = new Map<string, number[]>();
      for (const r of recentCards) {
        if (!byEngine.has(r.engine)) byEngine.set(r.engine, []);
        byEngine.get(r.engine)!.push(r.combined_score);
      }

      // Check knowledge_quality trend via meta_trends (if available)
      let kqTrend = 0;
      try {
        const kqRows = this.db.prepare(`
          SELECT value FROM meta_trends WHERE metric = 'knowledge_quality'
          ORDER BY rowid DESC LIMIT 5
        `).all() as Array<{ value: number }>;
        if (kqRows.length >= 3) {
          kqTrend = kqRows[0].value - kqRows[kqRows.length - 1].value;
        }
      } catch { /* meta_trends may not exist */ }

      // KPI gaming: engine score rising but system quality declining
      if (kqTrend < -0.05) {
        for (const [engine, scores] of byEngine) {
          if (scores.length >= 3) {
            const trend = scores[scores.length - 1] - scores[0];
            if (trend > 0.1) {
              detections.push(this.record({
                loopType: 'kpi_gaming',
                severity: 'high',
                enginesInvolved: [engine],
                description: `Engine "${engine}" score rising (+${trend.toFixed(2)}) while knowledge_quality falling (${kqTrend.toFixed(2)})`,
                evidence: { engineTrend: trend, kqTrend, scores },
                cycle,
              }));
            }
          }
        }
      }
    } catch {
      // tables may not exist
    }

    return detections;
  }

  // ── Detector 4: Epistemic Drift ─────────────────────────

  private detectEpistemicDrift(cycle: number): LoopDetection[] {
    const detections: LoopDetection[] = [];

    try {
      // Rising contradictions + falling confidence over window
      const contradictionCount = (this.db.prepare(
        "SELECT COUNT(*) as c FROM contradictions WHERE created_at > datetime('now', '-24 hours')"
      ).get() as { c: number }).c;

      const oldContradictionCount = (this.db.prepare(
        "SELECT COUNT(*) as c FROM contradictions WHERE created_at > datetime('now', '-48 hours') AND created_at <= datetime('now', '-24 hours')"
      ).get() as { c: number }).c;

      // Average hypothesis confidence
      let avgConfidence = 0.5;
      try {
        const confRow = this.db.prepare(
          "SELECT AVG(confidence) as avg FROM hypotheses WHERE status = 'active'"
        ).get() as { avg: number | null };
        avgConfidence = confRow?.avg ?? 0.5;
      } catch { /* ignore */ }

      if (contradictionCount > oldContradictionCount + 2 && avgConfidence < 0.4) {
        detections.push(this.record({
          loopType: 'epistemic_drift',
          severity: contradictionCount > oldContradictionCount + 5 ? 'critical' : 'high',
          enginesInvolved: ['knowledge_graph', 'hypothesis_engine', 'contradiction_resolver'],
          description: `Epistemic drift: contradictions rising (${oldContradictionCount}→${contradictionCount}), avg confidence ${avgConfidence.toFixed(2)}`,
          evidence: { contradictionCount, oldContradictionCount, avgConfidence },
          cycle,
        }));
      }
    } catch {
      // tables may not exist
    }

    return detections;
  }

  // ── Private ─────────────────────────────────────────────

  private record(params: {
    loopType: LoopType;
    severity: LoopSeverity;
    enginesInvolved: string[];
    description: string;
    evidence: Record<string, unknown>;
    cycle: number;
  }): LoopDetection {
    const result = this.db.prepare(`
      INSERT INTO loop_detections (loop_type, severity, engines_involved, description, evidence_json, cycle)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.loopType, params.severity, JSON.stringify(params.enginesInvolved),
      params.description, JSON.stringify(params.evidence), params.cycle,
    );

    this.log.info(`[loop-detector] ${params.loopType} (${params.severity}): ${params.description}`);

    return {
      id: Number(result.lastInsertRowid),
      loopType: params.loopType,
      severity: params.severity,
      enginesInvolved: params.enginesInvolved,
      description: params.description,
      evidence: params.evidence,
      cycle: params.cycle,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
  }

  private rowToDetection(row: Record<string, unknown>): LoopDetection {
    return {
      id: row.id as number,
      loopType: row.loop_type as LoopType,
      severity: row.severity as LoopSeverity,
      enginesInvolved: JSON.parse(row.engines_involved as string),
      description: row.description as string,
      evidence: JSON.parse(row.evidence_json as string),
      cycle: row.cycle as number,
      resolved: row.resolved === 1,
      createdAt: row.created_at as string,
    };
  }
}
