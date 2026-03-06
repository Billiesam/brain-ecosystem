import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';
import type { BaseSynapseManager } from '../synapses/synapse-manager.js';

// ── Types ───────────────────────────────────────────────

export interface FeedbackEngineConfig {
  brainName: string;
  /** Reward adjustment per positive signal. Default: 0.1 */
  positiveRewardDelta?: number;
  /** Reward adjustment per negative signal. Default: 0.1 */
  negativeRewardDelta?: number;
}

export type FeedbackSignal = 'positive' | 'negative' | 'correction';

export interface FeedbackRecord {
  id?: number;
  target_type: string;
  target_id: number;
  signal: FeedbackSignal;
  detail: string | null;
  reward_score: number;
  created_at: string;
}

export interface FeedbackCorrection {
  id?: number;
  target_type: string;
  target_id: number;
  original: string;
  correction: string;
  applied: number;
  created_at: string;
}

export interface FeedbackStats {
  totalFeedback: number;
  positiveCount: number;
  negativeCount: number;
  correctionCount: number;
  avgRewardScore: number;
}

// ── Migration ───────────────────────────────────────────

export function runFeedbackMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      signal TEXT NOT NULL CHECK(signal IN ('positive','negative','correction')),
      detail TEXT,
      reward_score REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_signals_target ON feedback_signals(target_type, target_id);

    CREATE TABLE IF NOT EXISTS feedback_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      original TEXT NOT NULL,
      correction TEXT NOT NULL,
      applied INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_corrections_target ON feedback_corrections(target_type, target_id);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class FeedbackEngine {
  private readonly db: Database.Database;
  private readonly config: Required<FeedbackEngineConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;

  // ── Prepared statements ──────────────────────────────
  private readonly stmtInsertFeedback: Database.Statement;
  private readonly stmtGetFeedback: Database.Statement;
  private readonly stmtGetFeedbackHistory: Database.Statement;
  private readonly stmtCountBySignal: Database.Statement;
  private readonly stmtTotalFeedback: Database.Statement;
  private readonly stmtAvgReward: Database.Statement;
  private readonly stmtInsertCorrection: Database.Statement;
  private readonly stmtGetCorrections: Database.Statement;
  private readonly stmtDistinctTargets: Database.Statement;
  private readonly stmtGetRewardComponents: Database.Statement;

  constructor(db: Database.Database, config: FeedbackEngineConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      positiveRewardDelta: config.positiveRewardDelta ?? 0.1,
      negativeRewardDelta: config.negativeRewardDelta ?? 0.1,
    };

    runFeedbackMigration(db);

    // Prepare statements
    this.stmtInsertFeedback = db.prepare(`
      INSERT INTO feedback_signals (target_type, target_id, signal, detail, reward_score)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtGetFeedback = db.prepare(
      'SELECT * FROM feedback_signals WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC'
    );

    this.stmtGetFeedbackHistory = db.prepare(
      'SELECT * FROM feedback_signals WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?'
    );

    this.stmtCountBySignal = db.prepare(
      'SELECT signal, COUNT(*) as cnt FROM feedback_signals GROUP BY signal'
    );

    this.stmtTotalFeedback = db.prepare('SELECT COUNT(*) as cnt FROM feedback_signals');

    this.stmtAvgReward = db.prepare('SELECT AVG(reward_score) as avg FROM feedback_signals WHERE reward_score IS NOT NULL');

    this.stmtInsertCorrection = db.prepare(`
      INSERT INTO feedback_corrections (target_type, target_id, original, correction)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtGetCorrections = db.prepare(
      'SELECT * FROM feedback_corrections WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC'
    );

    this.stmtDistinctTargets = db.prepare(
      'SELECT DISTINCT target_type, target_id FROM feedback_signals'
    );

    this.stmtGetRewardComponents = db.prepare(`
      SELECT signal, COUNT(*) as cnt
      FROM feedback_signals
      WHERE target_type = ? AND target_id = ?
      GROUP BY signal
    `);

    this.log.info(`[FeedbackEngine] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setThoughtStream(ts: ThoughtStream): void { this.ts = ts; }

  // ── Core Operations ──────────────────────────────────

  recordFeedback(type: string, targetId: number, signal: FeedbackSignal, detail?: string): FeedbackRecord {
    let rewardScore: number;
    switch (signal) {
      case 'positive':
        rewardScore = 1.0;
        break;
      case 'negative':
        rewardScore = -1.0;
        break;
      case 'correction':
        rewardScore = -0.5;
        break;
    }

    this.stmtInsertFeedback.run(type, targetId, signal, detail ?? null, rewardScore);

    this.log.debug(`[FeedbackEngine] Recorded ${signal} feedback for ${type}:${targetId}`);
    this.ts?.emit('feedback', 'discovering', `${signal} feedback for ${type}:${targetId}`, signal === 'negative' ? 'notable' : 'routine');

    return {
      target_type: type,
      target_id: targetId,
      signal,
      detail: detail ?? null,
      reward_score: rewardScore,
      created_at: new Date().toISOString(),
    };
  }

  getRewardScore(type: string, targetId: number): number {
    const rows = this.stmtGetRewardComponents.all(type, targetId) as Array<{ signal: string; cnt: number }>;

    if (rows.length === 0) return 0;

    let totalScore = 0;
    let totalCount = 0;

    for (const row of rows) {
      let signalValue: number;
      switch (row.signal) {
        case 'positive':
          signalValue = 1.0;
          break;
        case 'negative':
          signalValue = -1.0;
          break;
        case 'correction':
          signalValue = -0.5;
          break;
        default:
          signalValue = 0;
      }
      totalScore += signalValue * row.cnt;
      totalCount += row.cnt;
    }

    if (totalCount === 0) return 0;

    // Clamp to [-1, 1]
    const raw = totalScore / totalCount;
    return Math.max(-1, Math.min(1, raw));
  }

  applyRewards(synapseManager?: BaseSynapseManager): void {
    if (!synapseManager) {
      this.log.debug('[FeedbackEngine] No synapse manager provided, skipping reward application');
      return;
    }

    const targets = this.stmtDistinctTargets.all() as Array<{ target_type: string; target_id: number }>;

    for (const target of targets) {
      const reward = this.getRewardScore(target.target_type, target.target_id);

      if (reward > 0) {
        // Strengthen synapse
        try {
          synapseManager.strengthen(
            { type: target.target_type, id: target.target_id },
            { type: target.target_type, id: target.target_id },
            'feedback_reward',
          );
        } catch {
          // Synapse may not exist, that's ok
        }
      } else if (reward < 0) {
        // Weaken synapse — find existing first, then weaken by factor
        try {
          const existing = synapseManager.find(
            { type: target.target_type, id: target.target_id },
            { type: target.target_type, id: target.target_id },
            'feedback_reward',
          );
          if (existing) {
            synapseManager.weaken(existing.id, this.config.negativeRewardDelta);
          }
        } catch {
          // Synapse may not exist, that's ok
        }
      }
    }

    this.log.info(`[FeedbackEngine] Applied rewards to ${targets.length} target(s)`);
    this.ts?.emit('feedback', 'analyzing', `Applied rewards to ${targets.length} target(s)`, 'notable');
  }

  learnFromCorrection(original: string, correction: string, targetType: string, targetId: number): FeedbackCorrection {
    this.stmtInsertCorrection.run(targetType, targetId, original, correction);

    // Also record a correction feedback signal
    this.recordFeedback(targetType, targetId, 'correction', `Corrected: "${original}" -> "${correction}"`);

    this.log.debug(`[FeedbackEngine] Learned correction for ${targetType}:${targetId}`);

    return {
      target_type: targetType,
      target_id: targetId,
      original,
      correction,
      applied: 0,
      created_at: new Date().toISOString(),
    };
  }

  getStats(): FeedbackStats {
    const totalRow = this.stmtTotalFeedback.get() as { cnt: number };
    const avgRow = this.stmtAvgReward.get() as { avg: number | null };
    const signalRows = this.stmtCountBySignal.all() as Array<{ signal: string; cnt: number }>;

    const signalCounts: Record<string, number> = {};
    for (const row of signalRows) {
      signalCounts[row.signal] = row.cnt;
    }

    return {
      totalFeedback: totalRow.cnt,
      positiveCount: signalCounts['positive'] ?? 0,
      negativeCount: signalCounts['negative'] ?? 0,
      correctionCount: signalCounts['correction'] ?? 0,
      avgRewardScore: avgRow.avg ?? 0,
    };
  }

  getFeedbackHistory(type: string, targetId: number, limit?: number): FeedbackRecord[] {
    const maxResults = limit ?? 50;
    return this.stmtGetFeedbackHistory.all(type, targetId, maxResults) as FeedbackRecord[];
  }
}
