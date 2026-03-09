/**
 * GovernanceLayer — Active engine control with throttle, cooldown, isolate, escalate, restore.
 * Responds to LoopDetector findings and MetaCognition grades.
 */
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { LoopDetector } from './loop-detector.js';
import type { EngineRegistry } from './engine-registry.js';

// ── Types ───────────────────────────────────────────────

export type GovernanceActionType = 'throttle' | 'cooldown' | 'isolate' | 'escalate' | 'restore';

export interface GovernanceAction {
  id: number;
  engine: string;
  actionType: GovernanceActionType;
  reason: string;
  source: string;
  expiresAt: string | null;
  active: boolean;
  cycle: number;
  createdAt: string;
}

export interface GovernanceDecision {
  engine: string;
  action: GovernanceActionType;
  reason: string;
}

export interface GovernanceLayerStatus {
  totalActions: number;
  activeActions: number;
  byType: Record<GovernanceActionType, number>;
  throttledEngines: string[];
  isolatedEngines: string[];
}

// ── Migration ───────────────────────────────────────────

export function runGovernanceMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      engine TEXT NOT NULL,
      action_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      expires_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      cycle INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_governance_actions_engine ON governance_actions(engine, active);
  `);
}

// ── GovernanceLayer ─────────────────────────────────────

export class GovernanceLayer {
  private db: Database.Database;
  private log = getLogger();
  private loopDetector: LoopDetector | null = null;
  private engineRegistry: EngineRegistry | null = null;
  private metaCognitionLayer: { evaluate: (windowCycles?: number) => Array<{ engine: string; grade: string; combined_score: number }> } | null = null;
  private journalWriter: { write: (entry: Record<string, unknown>) => void } | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    runGovernanceMigration(db);
  }

  setLoopDetector(detector: LoopDetector): void { this.loopDetector = detector; }
  setEngineRegistry(registry: EngineRegistry): void { this.engineRegistry = registry; }
  setMetaCognitionLayer(layer: { evaluate: (windowCycles?: number) => Array<{ engine: string; grade: string; combined_score: number }> }): void { this.metaCognitionLayer = layer; }
  setJournalWriter(writer: { write: (entry: Record<string, unknown>) => void }): void { this.journalWriter = writer; }

  /** Check if an engine should run this cycle. Respects throttle/cooldown/isolate. */
  shouldRun(engineId: string, cycle: number): boolean {
    // Check for active isolate
    const isolated = this.db.prepare(
      "SELECT id FROM governance_actions WHERE engine = ? AND action_type = 'isolate' AND active = 1 LIMIT 1"
    ).get(engineId) as { id: number } | undefined;
    if (isolated) return false;

    // Check for active cooldown (with expiry check)
    const cooldown = this.db.prepare(
      "SELECT id, expires_at FROM governance_actions WHERE engine = ? AND action_type = 'cooldown' AND active = 1 LIMIT 1"
    ).get(engineId) as { id: number; expires_at: string | null } | undefined;
    if (cooldown) {
      if (cooldown.expires_at) {
        const now = new Date().toISOString();
        if (now < cooldown.expires_at) return false;
        // Expired → auto-restore
        this.db.prepare('UPDATE governance_actions SET active = 0 WHERE id = ?').run(cooldown.id);
      } else {
        return false;
      }
    }

    // Check for throttle (skip every Nth cycle)
    const throttle = this.db.prepare(
      "SELECT id FROM governance_actions WHERE engine = ? AND action_type = 'throttle' AND active = 1 LIMIT 1"
    ).get(engineId) as { id: number } | undefined;
    if (throttle && cycle % 2 !== 0) return false; // throttle = skip odd cycles

    return true;
  }

  /** Apply throttle — engine runs at reduced frequency. */
  throttle(engineId: string, reason: string, cycle = 0, source = 'auto'): void {
    this.recordAction(engineId, 'throttle', reason, source, null, cycle);
  }

  /** Apply cooldown — engine pauses for N cycles. */
  cooldown(engineId: string, reason: string, cyclesToCool = 10, cycle = 0, source = 'auto'): void {
    const expiresAt = new Date(Date.now() + cyclesToCool * 60_000).toISOString(); // ~1min per cycle
    this.recordAction(engineId, 'cooldown', reason, source, expiresAt, cycle);
  }

  /** Isolate — engine completely stopped, manual restore required. */
  isolate(engineId: string, reason: string, cycle = 0, source = 'auto'): void {
    this.recordAction(engineId, 'isolate', reason, source, null, cycle);
    if (this.engineRegistry) this.engineRegistry.disable(engineId);
  }

  /** Escalate — log to journal + notification, no runtime change. */
  escalate(engineId: string, reason: string, cycle = 0, source = 'auto'): void {
    this.recordAction(engineId, 'escalate', reason, source, null, cycle);
    if (this.journalWriter) {
      this.journalWriter.write({
        title: `Governance Escalation: ${engineId}`,
        content: reason,
        type: 'insight',
        significance: 'critical',
        tags: ['governance', 'escalation', engineId],
        references: [],
        data: { engine: engineId, source },
      });
    }
  }

  /** Restore — re-enable an engine, clear active actions. */
  restore(engineId: string, reason: string, cycle = 0, source = 'auto'): void {
    this.db.prepare(
      'UPDATE governance_actions SET active = 0 WHERE engine = ? AND active = 1'
    ).run(engineId);
    this.recordAction(engineId, 'restore', reason, source, null, cycle);
    if (this.engineRegistry) this.engineRegistry.enable(engineId);
    this.log.info(`[governance] Restored: ${engineId} — ${reason}`);
  }

  /** Periodic auto-governance review. */
  review(cycle: number): GovernanceDecision[] {
    const decisions: GovernanceDecision[] = [];

    // 1. LoopDetector findings
    if (this.loopDetector) {
      const active = this.loopDetector.getActive();
      for (const detection of active) {
        for (const engine of detection.enginesInvolved) {
          switch (detection.loopType) {
            case 'retrigger_spiral':
              decisions.push({ engine, action: 'throttle', reason: detection.description });
              this.throttle(engine, detection.description, cycle);
              break;
            case 'stagnation':
              decisions.push({ engine, action: 'cooldown', reason: detection.description });
              this.cooldown(engine, detection.description, 10, cycle);
              break;
            case 'kpi_gaming':
              decisions.push({ engine, action: 'escalate', reason: detection.description });
              this.escalate(engine, detection.description, cycle);
              break;
            case 'epistemic_drift':
              decisions.push({ engine, action: 'isolate', reason: detection.description });
              this.isolate(engine, detection.description, cycle);
              break;
          }
        }
      }
    }

    // 2. MetaCognition Grade F 3× in a row → cooldown
    if (this.metaCognitionLayer) {
      try {
        const fEngines = this.db.prepare(`
          SELECT engine, COUNT(*) as f_count FROM engine_report_cards
          WHERE grade = 'F' AND rowid > (SELECT MAX(rowid) - 30 FROM engine_report_cards)
          GROUP BY engine HAVING f_count >= 3
        `).all() as Array<{ engine: string; f_count: number }>;

        for (const { engine, f_count } of fEngines) {
          // Check if already has active action
          const existing = this.db.prepare(
            'SELECT id FROM governance_actions WHERE engine = ? AND active = 1 LIMIT 1'
          ).get(engine);
          if (!existing) {
            decisions.push({ engine, action: 'cooldown', reason: `Grade F ${f_count}× in recent evaluations` });
            this.cooldown(engine, `Grade F ${f_count}× in recent evaluations`, 15, cycle);
          }
        }
      } catch {
        // engine_report_cards may not exist
      }
    }

    // 3. Expire old cooldowns
    const expired = this.db.prepare(
      "SELECT DISTINCT engine FROM governance_actions WHERE action_type = 'cooldown' AND active = 1 AND expires_at IS NOT NULL AND expires_at < datetime('now')"
    ).all() as Array<{ engine: string }>;
    for (const { engine } of expired) {
      decisions.push({ engine, action: 'restore', reason: 'Cooldown expired' });
      this.restore(engine, 'Cooldown expired', cycle);
    }

    // 4. Multiple throttles → escalate to isolate
    try {
      const multiThrottle = this.db.prepare(`
        SELECT engine, COUNT(*) as t_count FROM governance_actions
        WHERE action_type = 'throttle' AND cycle > ? - 50
        GROUP BY engine HAVING t_count >= 3
      `).all(cycle) as Array<{ engine: string; t_count: number }>;

      for (const { engine, t_count } of multiThrottle) {
        const isIsolated = this.db.prepare(
          "SELECT id FROM governance_actions WHERE engine = ? AND action_type = 'isolate' AND active = 1 LIMIT 1"
        ).get(engine);
        if (!isIsolated) {
          decisions.push({ engine, action: 'isolate', reason: `${t_count} throttles in recent cycles — escalating` });
          this.isolate(engine, `${t_count} throttles in recent cycles — escalating to isolate`, cycle);
        }
      }
    } catch { /* ignore */ }

    if (decisions.length > 0) {
      this.log.info(`[governance] Review cycle ${cycle}: ${decisions.length} decisions`);
    }

    return decisions;
  }

  /** Get action history. */
  getHistory(limit = 50): GovernanceAction[] {
    const rows = this.db.prepare(
      'SELECT * FROM governance_actions ORDER BY id DESC LIMIT ?'
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToAction(r));
  }

  /** Get active actions for a specific engine. */
  getActiveActions(engineId?: string): GovernanceAction[] {
    const sql = engineId
      ? 'SELECT * FROM governance_actions WHERE active = 1 AND engine = ? ORDER BY id DESC'
      : 'SELECT * FROM governance_actions WHERE active = 1 ORDER BY id DESC';
    const rows = (engineId
      ? this.db.prepare(sql).all(engineId)
      : this.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToAction(r));
  }

  /** Get status summary. */
  getStatus(): GovernanceLayerStatus {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM governance_actions').get() as { c: number }).c;
    const active = (this.db.prepare('SELECT COUNT(*) as c FROM governance_actions WHERE active = 1').get() as { c: number }).c;
    const byTypeRows = this.db.prepare(
      'SELECT action_type, COUNT(*) as c FROM governance_actions WHERE active = 1 GROUP BY action_type'
    ).all() as Array<{ action_type: string; c: number }>;
    const byType: Record<string, number> = { throttle: 0, cooldown: 0, isolate: 0, escalate: 0, restore: 0 };
    for (const r of byTypeRows) byType[r.action_type] = r.c;

    const throttled = this.db.prepare(
      "SELECT DISTINCT engine FROM governance_actions WHERE action_type = 'throttle' AND active = 1"
    ).all() as Array<{ engine: string }>;
    const isolated = this.db.prepare(
      "SELECT DISTINCT engine FROM governance_actions WHERE action_type = 'isolate' AND active = 1"
    ).all() as Array<{ engine: string }>;

    return {
      totalActions: total,
      activeActions: active,
      byType: byType as Record<GovernanceActionType, number>,
      throttledEngines: throttled.map(r => r.engine),
      isolatedEngines: isolated.map(r => r.engine),
    };
  }

  // ── Private ─────────────────────────────────────────────

  private recordAction(engine: string, actionType: GovernanceActionType, reason: string, source: string, expiresAt: string | null, cycle: number): void {
    this.db.prepare(`
      INSERT INTO governance_actions (engine, action_type, reason, source, expires_at, active, cycle)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(engine, actionType, reason, source, expiresAt, cycle);
    this.log.info(`[governance] ${actionType} → ${engine}: ${reason}`);
  }

  private rowToAction(row: Record<string, unknown>): GovernanceAction {
    return {
      id: row.id as number,
      engine: row.engine as string,
      actionType: row.action_type as GovernanceActionType,
      reason: row.reason as string,
      source: row.source as string,
      expiresAt: row.expires_at as string | null,
      active: row.active === 1,
      cycle: row.cycle as number,
      createdAt: row.created_at as string,
    };
  }
}
