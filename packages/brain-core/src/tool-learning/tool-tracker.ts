// ── Tool Tracker — Usage Recording & Recommendation ──────────
//
// Tracks tool usage with context, duration, and outcome.
// Provides statistics and context-based recommendations.

import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export type ToolOutcome = 'success' | 'failure' | 'partial';

export interface ToolUsageRecord {
  id?: number;
  tool_name: string;
  context: string | null;
  duration_ms: number | null;
  outcome: ToolOutcome;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface ToolStats {
  tool: string;
  totalUses: number;
  successRate: number;
  avgDuration: number;
  lastUsed: string;
}

export interface ToolRecommendation {
  tool: string;
  score: number;
  successRate: number;
  frequency: number;
}

export interface ToolTrackerStatus {
  totalTracked: number;
  uniqueTools: number;
  avgSuccessRate: number;
}

export interface ToolTrackerConfig {
  brainName: string;
}

// ── Migration ───────────────────────────────────────────

export function runToolTrackerMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY,
      tool_name TEXT NOT NULL,
      context TEXT,
      duration_ms INTEGER,
      outcome TEXT DEFAULT 'success' CHECK(outcome IN ('success','failure','partial')),
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tool_usage_tool_name ON tool_usage(tool_name);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class ToolTracker {
  private db: Database.Database;
  private config: ToolTrackerConfig;
  private ts: ThoughtStream | null = null;
  private log = getLogger();

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtStatsSingle: Database.Statement;
  private stmtStatsAll: Database.Statement;
  private stmtRecommend: Database.Statement;
  private stmtTotalTracked: Database.Statement;
  private stmtUniqueTools: Database.Statement;
  private stmtAvgSuccessRate: Database.Statement;

  constructor(db: Database.Database, config: ToolTrackerConfig) {
    this.db = db;
    this.config = config;

    runToolTrackerMigration(db);

    // Prepare all statements
    this.stmtInsert = db.prepare(`
      INSERT INTO tool_usage (tool_name, context, duration_ms, outcome, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtStatsSingle = db.prepare(`
      SELECT
        tool_name AS tool,
        COUNT(*) AS totalUses,
        CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS successRate,
        COALESCE(AVG(duration_ms), 0) AS avgDuration,
        MAX(created_at) AS lastUsed
      FROM tool_usage
      WHERE tool_name = ?
      GROUP BY tool_name
    `);

    this.stmtStatsAll = db.prepare(`
      SELECT
        tool_name AS tool,
        COUNT(*) AS totalUses,
        CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS successRate,
        COALESCE(AVG(duration_ms), 0) AS avgDuration,
        MAX(created_at) AS lastUsed
      FROM tool_usage
      GROUP BY tool_name
      ORDER BY totalUses DESC
    `);

    this.stmtRecommend = db.prepare(`
      SELECT
        tool_name AS tool,
        COUNT(*) AS frequency,
        CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS successRate
      FROM tool_usage
      WHERE context LIKE ?
      GROUP BY tool_name
      ORDER BY (CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)) * COUNT(*) DESC
      LIMIT 5
    `);

    this.stmtTotalTracked = db.prepare(`
      SELECT COUNT(*) AS total FROM tool_usage
    `);

    this.stmtUniqueTools = db.prepare(`
      SELECT COUNT(DISTINCT tool_name) AS unique_tools FROM tool_usage
    `);

    this.stmtAvgSuccessRate = db.prepare(`
      SELECT COALESCE(
        CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / NULLIF(COUNT(*), 0),
        0
      ) AS avgRate
      FROM tool_usage
    `);

    this.log.info(`[tool-tracker] Initialized for ${config.brainName}`);
  }

  /** Set the ThoughtStream for consciousness integration. */
  setThoughtStream(stream: ThoughtStream): void {
    this.ts = stream;
  }

  /** Record a tool usage event. */
  recordUsage(
    tool: string,
    context: string | null,
    duration: number | null,
    outcome: ToolOutcome = 'success',
    metadata?: Record<string, unknown>,
  ): void {
    this.stmtInsert.run(
      tool,
      context,
      duration,
      outcome,
      metadata ? JSON.stringify(metadata) : null,
    );

    this.ts?.emit(
      'tool-tracker',
      'analyzing',
      `Recorded ${tool} usage: ${outcome}${duration ? ` (${duration}ms)` : ''}`,
      'routine',
    );
  }

  /** Get statistics for a specific tool, or all tools if none specified. */
  getToolStats(tool?: string): ToolStats | ToolStats[] {
    if (tool) {
      const row = this.stmtStatsSingle.get(tool) as ToolStats | undefined;
      if (!row) {
        return { tool, totalUses: 0, successRate: 0, avgDuration: 0, lastUsed: '' };
      }
      return row;
    }

    return this.stmtStatsAll.all() as ToolStats[];
  }

  /** Recommend top-5 tools for a given context based on success rate * frequency. */
  recommend(context: string): ToolRecommendation[] {
    const pattern = `%${context}%`;
    const rows = this.stmtRecommend.all(pattern) as Array<{
      tool: string;
      frequency: number;
      successRate: number;
    }>;

    return rows.map(r => ({
      tool: r.tool,
      score: r.successRate * r.frequency,
      successRate: r.successRate,
      frequency: r.frequency,
    }));
  }

  /** Get tracker status summary. */
  getStatus(): ToolTrackerStatus {
    const total = (this.stmtTotalTracked.get() as { total: number }).total;
    const unique = (this.stmtUniqueTools.get() as { unique_tools: number }).unique_tools;
    const avgRate = (this.stmtAvgSuccessRate.get() as { avgRate: number }).avgRate;

    return {
      totalTracked: total,
      uniqueTools: unique,
      avgSuccessRate: avgRate,
    };
  }
}
