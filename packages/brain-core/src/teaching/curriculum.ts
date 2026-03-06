import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface CurriculumItem {
  id?: number;
  brainName: string;
  domain: string;
  principle: string;
  strength: number;
  teachable: boolean;
  createdAt?: string;
}

export interface CurriculumStatus {
  totalPrinciples: number;
  teachableCount: number;
  byBrain: Record<string, number>;
}

// ── Migration ───────────────────────────────────────────

export function runCurriculumMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS curriculum_items (
      id INTEGER PRIMARY KEY,
      brain_name TEXT NOT NULL,
      domain TEXT NOT NULL,
      principle TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      teachable INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_curriculum_brain ON curriculum_items(brain_name);
    CREATE INDEX IF NOT EXISTS idx_curriculum_teachable ON curriculum_items(teachable);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class Curriculum {
  private readonly db: Database.Database;
  private readonly log = getLogger();

  // Prepared statements
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtGetTeachable: Database.Statement;
  private readonly stmtMarkTeachable: Database.Statement;
  private readonly stmtTotalPrinciples: Database.Statement;
  private readonly stmtTeachableCount: Database.Statement;
  private readonly stmtCountByBrain: Database.Statement;

  constructor(db: Database.Database) {
    runCurriculumMigration(db);

    this.db = db;

    this.stmtUpsert = db.prepare(
      `INSERT INTO curriculum_items (brain_name, domain, principle, strength)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET strength = excluded.strength`,
    );
    this.stmtGetTeachable = db.prepare(
      'SELECT * FROM curriculum_items WHERE brain_name = ? AND teachable = 1 ORDER BY strength DESC LIMIT ?',
    );
    this.stmtMarkTeachable = db.prepare(
      'UPDATE curriculum_items SET teachable = 1 WHERE id = ?',
    );
    this.stmtTotalPrinciples = db.prepare('SELECT COUNT(*) as cnt FROM curriculum_items');
    this.stmtTeachableCount = db.prepare('SELECT COUNT(*) as cnt FROM curriculum_items WHERE teachable = 1');
    this.stmtCountByBrain = db.prepare('SELECT brain_name, COUNT(*) as cnt FROM curriculum_items GROUP BY brain_name');

    this.log.debug('[Curriculum] Initialized');
  }

  // ── Core: Register ───────────────────────────────────

  registerPrinciple(brainName: string, domain: string, principle: string, strength: number): CurriculumItem {
    const info = this.stmtUpsert.run(brainName, domain, principle, strength);

    this.log.debug(`[Curriculum] Registered: ${brainName}/${domain} (strength=${strength.toFixed(2)})`);

    return {
      id: Number(info.lastInsertRowid),
      brainName,
      domain,
      principle,
      strength,
      teachable: false,
    };
  }

  // ── Core: Get Teachable ──────────────────────────────

  getTeachable(brainName: string, limit = 10): CurriculumItem[] {
    const rows = this.stmtGetTeachable.all(brainName, limit) as Record<string, unknown>[];
    return rows.map(r => this.toItem(r));
  }

  // ── Core: Mark Teachable ─────────────────────────────

  markTeachable(id: number): boolean {
    const result = this.stmtMarkTeachable.run(id);
    return result.changes > 0;
  }

  // ── Core: Status ─────────────────────────────────────

  getStatus(): CurriculumStatus {
    const totalPrinciples = (this.stmtTotalPrinciples.get() as { cnt: number }).cnt;
    const teachableCount = (this.stmtTeachableCount.get() as { cnt: number }).cnt;

    const brainRows = this.stmtCountByBrain.all() as Array<{ brain_name: string; cnt: number }>;
    const byBrain: Record<string, number> = {};
    for (const row of brainRows) {
      byBrain[row.brain_name] = row.cnt;
    }

    return { totalPrinciples, teachableCount, byBrain };
  }

  // ── Private: Row Mapping ─────────────────────────────

  private toItem(row: Record<string, unknown>): CurriculumItem {
    return {
      id: row.id as number,
      brainName: row.brain_name as string,
      domain: row.domain as string,
      principle: row.principle as string,
      strength: row.strength as number,
      teachable: (row.teachable as number) === 1,
      createdAt: row.created_at as string,
    };
  }
}
