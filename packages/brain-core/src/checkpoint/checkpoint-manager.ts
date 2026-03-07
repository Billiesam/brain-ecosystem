import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────

export interface Checkpoint {
  id: number;
  workflow_id: string;
  workflow_type: string;
  step: number;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CheckpointSummary {
  workflow_id: string;
  workflow_type: string;
  latest_step: number;
  total_checkpoints: number;
  first_at: string;
  last_at: string;
}

export interface CheckpointManagerStatus {
  totalCheckpoints: number;
  totalWorkflows: number;
  byType: Record<string, number>;
  oldestAt: string | null;
}

// ── Migration ────────────────────────────────────────────

export function runCheckpointMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      workflow_type TEXT NOT NULL DEFAULT 'orchestrator',
      step INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT '{}',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_workflow ON workflow_checkpoints(workflow_id, step);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_type ON workflow_checkpoints(workflow_type);
  `);
}

// ── CheckpointManager ────────────────────────────────────

export class CheckpointManager {
  private readonly db: Database.Database;
  private readonly log = getLogger();

  // Prepared statements (lazy)
  private stmtSave!: Database.Statement;
  private stmtLoad!: Database.Statement;
  private stmtHistory!: Database.Statement;
  private stmtLatest!: Database.Statement;
  private stmtListWorkflows!: Database.Statement;
  private stmtDelete!: Database.Statement;
  private stmtCount!: Database.Statement;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
    runCheckpointMigration(db);
  }

  private ensureStatements(): void {
    if (this.initialized) return;
    this.stmtSave = this.db.prepare(`
      INSERT INTO workflow_checkpoints (workflow_id, workflow_type, step, state, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.stmtLoad = this.db.prepare(`
      SELECT * FROM workflow_checkpoints
      WHERE workflow_id = ? ORDER BY step DESC LIMIT 1
    `);
    this.stmtHistory = this.db.prepare(`
      SELECT * FROM workflow_checkpoints
      WHERE workflow_id = ? ORDER BY step ASC
    `);
    this.stmtLatest = this.db.prepare(`
      SELECT wc.*, (SELECT COUNT(*) FROM workflow_checkpoints WHERE workflow_id = wc.workflow_id) as total
      FROM workflow_checkpoints wc
      WHERE wc.workflow_id = ?
      ORDER BY wc.step DESC LIMIT 1
    `);
    this.stmtListWorkflows = this.db.prepare(`
      SELECT workflow_id, workflow_type,
             MAX(step) as latest_step,
             COUNT(*) as total_checkpoints,
             MIN(created_at) as first_at,
             MAX(created_at) as last_at
      FROM workflow_checkpoints
      GROUP BY workflow_id
      ORDER BY last_at DESC
      LIMIT ?
    `);
    this.stmtDelete = this.db.prepare(`
      DELETE FROM workflow_checkpoints WHERE workflow_id = ?
    `);
    this.stmtCount = this.db.prepare(`
      SELECT COUNT(*) as c FROM workflow_checkpoints
    `);
    this.initialized = true;
  }

  /**
   * Save a checkpoint for a workflow at a specific step.
   * State is serialized to JSON. Overwrites if same workflow_id + step exists.
   */
  save(workflowId: string, step: number, state: Record<string, unknown>, options?: {
    workflowType?: string;
    metadata?: Record<string, unknown>;
  }): number {
    this.ensureStatements();
    const type = options?.workflowType ?? 'orchestrator';
    const meta = options?.metadata ?? {};

    const result = this.stmtSave.run(
      workflowId, type, step,
      JSON.stringify(state),
      JSON.stringify(meta),
    );

    this.log.debug(`[Checkpoint] Saved ${workflowId} step ${step}`);
    return result.lastInsertRowid as number;
  }

  /**
   * Load the latest checkpoint for a workflow.
   * Returns null if no checkpoint exists.
   */
  load(workflowId: string): Checkpoint | null {
    this.ensureStatements();
    const row = this.stmtLoad.get(workflowId) as (Checkpoint & { state: string; metadata: string }) | undefined;
    if (!row) return null;
    return {
      ...row,
      state: JSON.parse(row.state as string),
      metadata: JSON.parse(row.metadata as string),
    };
  }

  /**
   * Get the step number to resume from.
   * Returns 0 if no checkpoint exists (start from beginning).
   */
  resumeStep(workflowId: string): number {
    const cp = this.load(workflowId);
    return cp ? cp.step : 0;
  }

  /**
   * Fork a workflow — copy all checkpoints to a new workflow ID.
   * Useful for time-travel debugging (branch off from a known-good state).
   */
  fork(sourceWorkflowId: string, newWorkflowId: string): number {
    this.ensureStatements();
    const checkpoints = this.history(sourceWorkflowId);
    if (checkpoints.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT INTO workflow_checkpoints (workflow_id, workflow_type, step, state, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertAll = this.db.transaction(() => {
      for (const cp of checkpoints) {
        insert.run(
          newWorkflowId, cp.workflow_type, cp.step,
          JSON.stringify(cp.state),
          JSON.stringify({ ...cp.metadata, forked_from: sourceWorkflowId }),
        );
      }
    });
    insertAll();

    this.log.info(`[Checkpoint] Forked ${sourceWorkflowId} → ${newWorkflowId} (${checkpoints.length} checkpoints)`);
    return checkpoints.length;
  }

  /**
   * Get full checkpoint history for a workflow.
   */
  history(workflowId: string): Checkpoint[] {
    this.ensureStatements();
    const rows = this.stmtHistory.all(workflowId) as Array<Checkpoint & { state: string; metadata: string }>;
    return rows.map(row => ({
      ...row,
      state: JSON.parse(row.state as string),
      metadata: JSON.parse(row.metadata as string),
    }));
  }

  /**
   * List all workflows with their checkpoint summaries.
   */
  listWorkflows(limit = 50): CheckpointSummary[] {
    this.ensureStatements();
    return this.stmtListWorkflows.all(limit) as CheckpointSummary[];
  }

  /**
   * Delete all checkpoints for a workflow.
   */
  delete(workflowId: string): number {
    this.ensureStatements();
    return this.stmtDelete.run(workflowId).changes;
  }

  /**
   * Prune old checkpoints. Keeps at most `keepPerWorkflow` checkpoints per workflow,
   * and deletes all checkpoints older than `maxAgeDays` days.
   */
  prune(options?: { maxAgeDays?: number; keepPerWorkflow?: number }): number {
    const maxAge = options?.maxAgeDays ?? 30;
    const keepPer = options?.keepPerWorkflow ?? 10;
    let pruned = 0;

    // 1. Delete old checkpoints
    const ageResult = this.db.prepare(`
      DELETE FROM workflow_checkpoints
      WHERE created_at < datetime('now', ? || ' days')
    `).run(`-${maxAge}`);
    pruned += ageResult.changes;

    // 2. Keep only latest N per workflow
    const workflows = this.db.prepare(`
      SELECT DISTINCT workflow_id FROM workflow_checkpoints
    `).all() as Array<{ workflow_id: string }>;

    for (const { workflow_id } of workflows) {
      const excess = this.db.prepare(`
        DELETE FROM workflow_checkpoints
        WHERE workflow_id = ? AND id NOT IN (
          SELECT id FROM workflow_checkpoints
          WHERE workflow_id = ?
          ORDER BY step DESC
          LIMIT ?
        )
      `).run(workflow_id, workflow_id, keepPer);
      pruned += excess.changes;
    }

    if (pruned > 0) {
      this.log.info(`[Checkpoint] Pruned ${pruned} old checkpoints`);
    }
    return pruned;
  }

  /**
   * Get checkpoint manager status.
   */
  getStatus(): CheckpointManagerStatus {
    this.ensureStatements();
    const total = (this.stmtCount.get() as { c: number }).c;

    const typeRows = this.db.prepare(`
      SELECT workflow_type, COUNT(*) as c FROM workflow_checkpoints GROUP BY workflow_type
    `).all() as Array<{ workflow_type: string; c: number }>;

    const byType: Record<string, number> = {};
    for (const r of typeRows) byType[r.workflow_type] = r.c;

    const workflows = this.db.prepare(`
      SELECT COUNT(DISTINCT workflow_id) as c FROM workflow_checkpoints
    `).get() as { c: number };

    const oldest = this.db.prepare(`
      SELECT MIN(created_at) as oldest FROM workflow_checkpoints
    `).get() as { oldest: string | null };

    return {
      totalCheckpoints: total,
      totalWorkflows: workflows.c,
      byType,
      oldestAt: oldest.oldest,
    };
  }
}
