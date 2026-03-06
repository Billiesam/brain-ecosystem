import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export interface ActiveLearnerConfig {
  brainName: string;
  maxOpenGaps?: number;
}

export type GapType = 'knowledge_void' | 'low_confidence' | 'unanswered' | 'cross_brain';
export type GapStatus = 'open' | 'investigating' | 'closed';
export type StrategyOutcome = 'success' | 'failure' | 'partial' | 'pending';

export interface LearningGap {
  id?: number;
  gapType: GapType;
  topic: string;
  description?: string;
  impact: number;
  ease: number;
  strategy?: string;
  status: GapStatus;
  createdAt?: string;
  closedAt?: string;
}

export interface LearningStrategy {
  id?: number;
  gapId: number;
  strategy: string;
  outcome: StrategyOutcome;
  createdAt?: string;
}

export interface GapSources {
  ragMisses?: Array<{ query: string }>;
  lowConfidenceFacts?: Array<{ topic: string; confidence: number }>;
  knowledgeVoids?: Array<{ topic: string; description?: string }>;
}

export interface PlanResult {
  gapId: number;
  strategy: string;
}

export interface ActiveLearnerStatus {
  totalGaps: number;
  openGaps: number;
  closedGaps: number;
  strategySuccessRate: number;
}

// ── Migration ───────────────────────────────────────────

export function runActiveLearningMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_gaps (
      id INTEGER PRIMARY KEY,
      gap_type TEXT NOT NULL,
      topic TEXT NOT NULL,
      description TEXT,
      impact REAL DEFAULT 0.5,
      ease REAL DEFAULT 0.5,
      strategy TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','investigating','closed')),
      created_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_learning_gaps_status ON learning_gaps(status);
    CREATE INDEX IF NOT EXISTS idx_learning_gaps_type ON learning_gaps(gap_type);

    CREATE TABLE IF NOT EXISTS learning_strategies (
      id INTEGER PRIMARY KEY,
      gap_id INTEGER REFERENCES learning_gaps(id),
      strategy TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('success','failure','partial','pending')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_learning_strategies_gap ON learning_strategies(gap_id);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class ActiveLearner {
  private readonly db: Database.Database;
  private readonly config: Required<ActiveLearnerConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;

  // Prepared statements
  private readonly stmtInsertGap: Database.Statement;
  private readonly stmtUpdateGapStatus: Database.Statement;
  private readonly stmtUpdateGapStrategy: Database.Statement;
  private readonly stmtGetGap: Database.Statement;
  private readonly stmtOpenGaps: Database.Statement;
  private readonly stmtOpenGapCount: Database.Statement;
  private readonly stmtInsertStrategy: Database.Statement;
  private readonly stmtTotalGaps: Database.Statement;
  private readonly stmtClosedGaps: Database.Statement;
  private readonly stmtTotalStrategies: Database.Statement;
  private readonly stmtSuccessfulStrategies: Database.Statement;

  constructor(db: Database.Database, config: ActiveLearnerConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      maxOpenGaps: config.maxOpenGaps ?? 50,
    };

    runActiveLearningMigration(db);

    this.stmtInsertGap = db.prepare(
      `INSERT INTO learning_gaps (gap_type, topic, description, impact, ease)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtUpdateGapStatus = db.prepare(
      `UPDATE learning_gaps SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END WHERE id = ?`,
    );
    this.stmtUpdateGapStrategy = db.prepare(
      'UPDATE learning_gaps SET strategy = ?, status = \'investigating\' WHERE id = ?',
    );
    this.stmtGetGap = db.prepare('SELECT * FROM learning_gaps WHERE id = ?');
    this.stmtOpenGaps = db.prepare(
      "SELECT * FROM learning_gaps WHERE status = 'open' OR status = 'investigating' ORDER BY (impact * ease) DESC LIMIT ?",
    );
    this.stmtOpenGapCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM learning_gaps WHERE status = 'open' OR status = 'investigating'",
    );
    this.stmtInsertStrategy = db.prepare(
      'INSERT INTO learning_strategies (gap_id, strategy, outcome) VALUES (?, ?, ?)',
    );
    this.stmtTotalGaps = db.prepare('SELECT COUNT(*) as cnt FROM learning_gaps');
    this.stmtClosedGaps = db.prepare("SELECT COUNT(*) as cnt FROM learning_gaps WHERE status = 'closed'");
    this.stmtTotalStrategies = db.prepare('SELECT COUNT(*) as cnt FROM learning_strategies');
    this.stmtSuccessfulStrategies = db.prepare(
      "SELECT COUNT(*) as cnt FROM learning_strategies WHERE outcome = 'success'",
    );

    this.log.debug(`[ActiveLearner] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setThoughtStream(stream: ThoughtStream): void {
    this.ts = stream;
  }

  // ── Core: Identify Gaps ──────────────────────────────

  identifyGaps(sources?: GapSources): LearningGap[] {
    const gaps: LearningGap[] = [];

    this.ts?.emit('active-learning', 'analyzing', 'Scanning for knowledge gaps...', 'routine');

    // 1. Knowledge voids: topics with no facts
    if (sources?.knowledgeVoids) {
      for (const void_ of sources.knowledgeVoids) {
        gaps.push({
          gapType: 'knowledge_void',
          topic: void_.topic,
          description: void_.description ?? `No knowledge found about "${void_.topic}"`,
          impact: 0.6,
          ease: 0.5,
          status: 'open',
        });
      }
    }

    // 2. Low confidence facts
    if (sources?.lowConfidenceFacts) {
      for (const fact of sources.lowConfidenceFacts) {
        if (fact.confidence < 0.3) {
          gaps.push({
            gapType: 'low_confidence',
            topic: fact.topic,
            description: `Low confidence (${fact.confidence.toFixed(2)}) on "${fact.topic}"`,
            impact: 0.5,
            ease: 0.6,
            status: 'open',
          });
        }
      }
    }

    // 3. Unanswered queries (RAG misses)
    if (sources?.ragMisses) {
      for (const miss of sources.ragMisses) {
        gaps.push({
          gapType: 'unanswered',
          topic: miss.query,
          description: `Query with 0 RAG results: "${miss.query}"`,
          impact: 0.7,
          ease: 0.4,
          status: 'open',
        });
      }
    }

    this.ts?.emit(
      'active-learning',
      'discovering',
      `Found ${gaps.length} knowledge gaps`,
      gaps.length > 5 ? 'notable' : 'routine',
    );

    this.log.debug(`[ActiveLearner] Identified ${gaps.length} gaps`);

    return gaps;
  }

  // ── Core: Plan Learning ──────────────────────────────

  planLearning(gapId: number): PlanResult | null {
    const row = this.stmtGetGap.get(gapId) as Record<string, unknown> | undefined;
    if (!row) return null;

    const gap = this.toGap(row);
    let strategy: string;

    switch (gap.gapType) {
      case 'knowledge_void':
        strategy = 'research_mission';
        break;
      case 'low_confidence':
        strategy = 'experiment';
        break;
      case 'unanswered':
        strategy = 'ask_user';
        break;
      case 'cross_brain':
        strategy = 'teach_request';
        break;
      default:
        strategy = 'research_mission';
    }

    // Update gap with chosen strategy
    this.stmtUpdateGapStrategy.run(strategy, gapId);

    // Record strategy choice
    this.stmtInsertStrategy.run(gapId, strategy, 'pending');

    this.ts?.emit(
      'active-learning',
      'reflecting',
      `Plan for gap #${gapId}: ${strategy}`,
      'routine',
    );

    this.log.debug(`[ActiveLearner] Plan for #${gapId}: ${strategy}`);

    return { gapId, strategy };
  }

  // ── Core: Prioritize ────────────────────────────────

  prioritize(gaps: LearningGap[]): LearningGap[] {
    return [...gaps].sort((a, b) => (b.impact * b.ease) - (a.impact * a.ease));
  }

  // ── Core: Close Gap ──────────────────────────────────

  closeGap(gapId: number, outcome: StrategyOutcome): boolean {
    const row = this.stmtGetGap.get(gapId) as Record<string, unknown> | undefined;
    if (!row) return false;

    this.stmtUpdateGapStatus.run('closed', 'closed', gapId);

    // Record strategy outcome
    this.stmtInsertStrategy.run(gapId, (row.strategy as string) ?? 'unknown', outcome);

    this.ts?.emit(
      'active-learning',
      outcome === 'success' ? 'discovering' : 'reflecting',
      `Gap #${gapId} closed: ${outcome}`,
      outcome === 'success' ? 'notable' : 'routine',
    );

    this.log.debug(`[ActiveLearner] Closed gap #${gapId}: ${outcome}`);

    return true;
  }

  // ── Core: Add Gap ────────────────────────────────────

  addGap(
    type: GapType,
    topic: string,
    description?: string,
    impact?: number,
    ease?: number,
  ): LearningGap {
    // Check maxOpenGaps limit
    const openCount = (this.stmtOpenGapCount.get() as { cnt: number }).cnt;
    if (openCount >= this.config.maxOpenGaps) {
      this.log.warn(`[ActiveLearner] Max open gaps (${this.config.maxOpenGaps}) reached, rejecting new gap`);
      throw new Error(`Maximum open gaps (${this.config.maxOpenGaps}) reached`);
    }

    const impactVal = impact ?? 0.5;
    const easeVal = ease ?? 0.5;

    const info = this.stmtInsertGap.run(type, topic, description ?? null, impactVal, easeVal);

    this.ts?.emit('active-learning', 'reflecting', `New gap: ${topic} (${type})`, 'routine');

    return {
      id: Number(info.lastInsertRowid),
      gapType: type,
      topic,
      description,
      impact: impactVal,
      ease: easeVal,
      status: 'open',
    };
  }

  // ── Core: Get Open Gaps ──────────────────────────────

  getOpenGaps(limit = 20): LearningGap[] {
    const rows = this.stmtOpenGaps.all(limit) as Record<string, unknown>[];
    return rows.map(r => this.toGap(r));
  }

  // ── Core: Status ─────────────────────────────────────

  getStatus(): ActiveLearnerStatus {
    const totalGaps = (this.stmtTotalGaps.get() as { cnt: number }).cnt;
    const openGaps = (this.stmtOpenGapCount.get() as { cnt: number }).cnt;
    const closedGaps = (this.stmtClosedGaps.get() as { cnt: number }).cnt;

    const totalStrategies = (this.stmtTotalStrategies.get() as { cnt: number }).cnt;
    const successfulStrategies = (this.stmtSuccessfulStrategies.get() as { cnt: number }).cnt;
    const strategySuccessRate = totalStrategies > 0
      ? successfulStrategies / totalStrategies
      : 0;

    return { totalGaps, openGaps, closedGaps, strategySuccessRate };
  }

  // ── Private: Row Mapping ─────────────────────────────

  private toGap(row: Record<string, unknown>): LearningGap {
    return {
      id: row.id as number,
      gapType: row.gap_type as GapType,
      topic: row.topic as string,
      description: (row.description as string) ?? undefined,
      impact: row.impact as number,
      ease: row.ease as number,
      strategy: (row.strategy as string) ?? undefined,
      status: row.status as GapStatus,
      createdAt: row.created_at as string,
      closedAt: (row.closed_at as string) ?? undefined,
    };
  }
}
