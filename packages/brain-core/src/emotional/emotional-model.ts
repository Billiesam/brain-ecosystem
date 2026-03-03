import Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export interface EmotionalModelConfig {
  brainName: string;
  decayFactor?: number;        // Smoothing decay (0-1), default 0.7
  significanceThreshold?: number; // Min |delta| to log influence, default 0.1
  historyRetentionDays?: number; // Auto-cleanup older entries, default 30
}

export interface EmotionalDataSources {
  getAutoResponderStatus?: () => { totalResponses: number; successRate: number; recentSeverity: string[] };
  getCuriosityStatus?: () => { activeGaps: number; avgGapScore: number; explorationRate: number };
  getEmergenceStatus?: () => { recentEvents: number; avgSurprise: number };
  getHypothesisConfidence?: () => { avgConfidence: number; confirmedRate: number };
  getPredictionAccuracy?: () => number;
  getReportCards?: () => Array<{ combined_score: number }>;
  getAttentionStatus?: () => { avgUrgency: number; burstCount: number; contextSwitches: number };
  getMetaTrend?: () => { learningRate: number; discoveryRate: number; direction: string };
  getReasoningChainCount?: () => number;
  getCreativeHypothesisCount?: () => number;
  getDebateCount?: () => number;
}

export type EmotionDimension =
  | 'frustration' | 'curiosity' | 'surprise' | 'confidence'
  | 'satisfaction' | 'stress' | 'momentum' | 'creativity';

export type MoodType =
  | 'flow' | 'anxious' | 'bored' | 'excited' | 'reflective' | 'determined';

export interface EmotionalDimensions {
  frustration: number;
  curiosity: number;
  surprise: number;
  confidence: number;
  satisfaction: number;
  stress: number;
  momentum: number;
  creativity: number;
}

export interface MoodResult {
  mood: MoodType;
  score: number;
  valence: number;   // -1 (negative) to +1 (positive)
  arousal: number;    // 0 (calm) to 1 (activated)
  dimensions: EmotionalDimensions;
}

export interface MoodInfluence {
  id: number;
  timestamp: string;
  dimension: EmotionDimension;
  old_value: number;
  new_value: number;
  delta: number;
  source_engine: string;
  trigger_event: string;
}

export interface EmotionalHistoryEntry {
  timestamp: string;
  frustration: number;
  curiosity: number;
  surprise: number;
  confidence: number;
  satisfaction: number;
  stress: number;
  momentum: number;
  creativity: number;
  dominant_mood: MoodType;
  mood_score: number;
  cycle_number: number;
}

export interface EmotionalStatus {
  brainName: string;
  currentMood: MoodResult;
  historyCount: number;
  influenceCount: number;
  uptime: number;
  lastSenseTime: string | null;
  cycleCount: number;
}

// ── Mood Patterns ───────────────────────────────────────

interface MoodPattern {
  weights: Partial<Record<EmotionDimension, number>>;
  valence: number;
  arousal: number;
}

const MOOD_PATTERNS: Record<MoodType, MoodPattern> = {
  flow: {
    weights: { confidence: 0.3, satisfaction: 0.3, stress: -0.25, momentum: 0.25, frustration: -0.15 },
    valence: 0.9,
    arousal: 0.6,
  },
  anxious: {
    weights: { stress: 0.4, confidence: -0.3, frustration: 0.3 },
    valence: -0.7,
    arousal: 0.8,
  },
  bored: {
    weights: { curiosity: -0.35, surprise: -0.35, confidence: 0.2, momentum: -0.2 },
    valence: -0.3,
    arousal: 0.1,
  },
  excited: {
    weights: { curiosity: 0.35, surprise: 0.3, momentum: 0.25, creativity: 0.15 },
    valence: 0.8,
    arousal: 0.9,
  },
  reflective: {
    weights: { stress: -0.3, confidence: 0.2, frustration: -0.25, satisfaction: 0.15, curiosity: 0.1 },
    valence: 0.4,
    arousal: 0.2,
  },
  determined: {
    weights: { frustration: 0.3, momentum: 0.35, confidence: 0.15, stress: 0.1, creativity: 0.1 },
    valence: 0.2,
    arousal: 0.7,
  },
};

// ── Recommendations ─────────────────────────────────────

const MOOD_RECOMMENDATIONS: Record<MoodType, string[]> = {
  anxious: [
    'Reduce experiment rate — consolidate existing knowledge first',
    'Focus on high-confidence tasks to rebuild certainty',
    'Run dream consolidation to prune noisy memories',
  ],
  bored: [
    'Increase exploration — look for blind spots and knowledge gaps',
    'Generate creative hypotheses to spark new research',
    'Seek cross-domain analogies for fresh perspectives',
  ],
  flow: [
    'Maintain current pace — avoid unnecessary interruptions',
    'Channel productivity into complex multi-step reasoning',
    'Good time for ambitious experiments',
  ],
  excited: [
    'Channel energy into testing hypotheses rigorously',
    'Document surprising findings before they fade',
    'Cross-validate new patterns against existing knowledge',
  ],
  reflective: [
    'Good time for self-reflection and contradiction analysis',
    'Review and update confidence scores across knowledge base',
    'Generate narrative digests to solidify understanding',
  ],
  determined: [
    'Use frustration as fuel — tackle the hardest open problems',
    'Run targeted experiments on persistent issues',
    'Consider alternative approaches to stalled research',
  ],
};

// ── Migration ───────────────────────────────────────────

export function runEmotionalMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS emotional_state (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
      frustration REAL NOT NULL DEFAULT 0,
      curiosity   REAL NOT NULL DEFAULT 0,
      surprise    REAL NOT NULL DEFAULT 0,
      confidence  REAL NOT NULL DEFAULT 0.5,
      satisfaction REAL NOT NULL DEFAULT 0.5,
      stress      REAL NOT NULL DEFAULT 0,
      momentum    REAL NOT NULL DEFAULT 0.5,
      creativity  REAL NOT NULL DEFAULT 0.5,
      dominant_mood TEXT NOT NULL DEFAULT 'reflective',
      mood_score  REAL NOT NULL DEFAULT 0,
      cycle_number INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_emotional_state_ts ON emotional_state(timestamp);

    CREATE TABLE IF NOT EXISTS mood_influences (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      TEXT NOT NULL DEFAULT (datetime('now')),
      dimension      TEXT NOT NULL,
      old_value      REAL NOT NULL,
      new_value      REAL NOT NULL,
      delta          REAL NOT NULL,
      source_engine  TEXT NOT NULL,
      trigger_event  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mood_influences_ts ON mood_influences(timestamp);
    CREATE INDEX IF NOT EXISTS idx_mood_influences_dim ON mood_influences(dimension);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class EmotionalModel {
  private readonly db: Database.Database;
  private readonly config: Required<EmotionalModelConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;
  private sources: EmotionalDataSources = {};
  private readonly startTime = Date.now();
  private cycleCount = 0;
  private lastSenseTime: string | null = null;

  // Current dimensions — neutral starting point
  private dimensions: EmotionalDimensions = {
    frustration: 0,
    curiosity: 0.3,
    surprise: 0.2,
    confidence: 0.5,
    satisfaction: 0.5,
    stress: 0,
    momentum: 0.5,
    creativity: 0.5,
  };

  // Prepared statements
  private readonly stmtInsertState: Database.Statement;
  private readonly stmtInsertInfluence: Database.Statement;
  private readonly stmtGetHistory: Database.Statement;
  private readonly stmtGetInfluences: Database.Statement;
  private readonly stmtCountHistory: Database.Statement;
  private readonly stmtCountInfluences: Database.Statement;
  private readonly stmtCleanupHistory: Database.Statement;
  private readonly stmtCleanupInfluences: Database.Statement;

  constructor(db: Database.Database, config: EmotionalModelConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      decayFactor: config.decayFactor ?? 0.7,
      significanceThreshold: config.significanceThreshold ?? 0.1,
      historyRetentionDays: config.historyRetentionDays ?? 30,
    };

    runEmotionalMigration(db);

    this.stmtInsertState = db.prepare(`
      INSERT INTO emotional_state (frustration, curiosity, surprise, confidence, satisfaction, stress, momentum, creativity, dominant_mood, mood_score, cycle_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertInfluence = db.prepare(`
      INSERT INTO mood_influences (dimension, old_value, new_value, delta, source_engine, trigger_event)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetHistory = db.prepare(`
      SELECT * FROM emotional_state ORDER BY id DESC LIMIT ?
    `);

    this.stmtGetInfluences = db.prepare(`
      SELECT * FROM mood_influences ORDER BY id DESC LIMIT ?
    `);

    this.stmtCountHistory = db.prepare(`SELECT COUNT(*) as count FROM emotional_state`);
    this.stmtCountInfluences = db.prepare(`SELECT COUNT(*) as count FROM mood_influences`);

    this.stmtCleanupHistory = db.prepare(`
      DELETE FROM emotional_state WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);
    this.stmtCleanupInfluences = db.prepare(`
      DELETE FROM mood_influences WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);
  }

  // ── Setters ─────────────────────────────────────────

  setThoughtStream(ts: ThoughtStream): void { this.ts = ts; }
  setDataSources(sources: EmotionalDataSources): void { this.sources = sources; }

  // ── Core Methods ────────────────────────────────────

  sense(): EmotionalDimensions {
    this.cycleCount++;
    const decay = this.config.decayFactor;
    const threshold = this.config.significanceThreshold;
    const old = { ...this.dimensions };

    // Sense each dimension
    const sensed: EmotionalDimensions = {
      frustration: this.senseFrustration(),
      curiosity: this.senseCuriosity(),
      surprise: this.senseSurprise(),
      confidence: this.senseConfidence(),
      satisfaction: this.senseSatisfaction(),
      stress: this.senseStress(),
      momentum: this.senseMomentum(),
      creativity: this.senseCreativity(),
    };

    // Apply smoothing + clamp
    const dims = Object.keys(sensed) as EmotionDimension[];
    for (const dim of dims) {
      this.dimensions[dim] = clamp(old[dim] * decay + sensed[dim] * (1 - decay));
    }

    // Log significant changes
    for (const dim of dims) {
      const delta = this.dimensions[dim] - old[dim];
      if (Math.abs(delta) > threshold) {
        const source = this.getDimensionSource(dim);
        this.stmtInsertInfluence.run(dim, old[dim], this.dimensions[dim], delta, source, `sense_cycle_${this.cycleCount}`);
      }
    }

    // Persist state
    const mood = this.getMood();
    this.stmtInsertState.run(
      this.dimensions.frustration, this.dimensions.curiosity,
      this.dimensions.surprise, this.dimensions.confidence,
      this.dimensions.satisfaction, this.dimensions.stress,
      this.dimensions.momentum, this.dimensions.creativity,
      mood.mood, mood.score, this.cycleCount,
    );

    this.lastSenseTime = new Date().toISOString();

    // Cleanup old data periodically
    if (this.cycleCount % 100 === 0) {
      this.stmtCleanupHistory.run(this.config.historyRetentionDays);
      this.stmtCleanupInfluences.run(this.config.historyRetentionDays);
    }

    this.ts?.emit('emotional', 'analyzing', `Mood: ${mood.mood} (${(mood.score * 100).toFixed(0)}%) | valence=${mood.valence > 0 ? '+' : ''}${mood.valence.toFixed(2)} arousal=${mood.arousal.toFixed(2)}`, 'routine');

    return this.dimensions;
  }

  getMood(): MoodResult {
    let bestMood: MoodType = 'reflective';
    let bestScore = -Infinity;

    for (const [mood, pattern] of Object.entries(MOOD_PATTERNS) as Array<[MoodType, MoodPattern]>) {
      let score = 0;
      for (const [dim, weight] of Object.entries(pattern.weights) as Array<[EmotionDimension, number]>) {
        score += this.dimensions[dim] * weight;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMood = mood;
      }
    }

    const pattern = MOOD_PATTERNS[bestMood];

    return {
      mood: bestMood,
      score: clamp(bestScore),
      valence: pattern.valence,
      arousal: pattern.arousal,
      dimensions: { ...this.dimensions },
    };
  }

  getInfluences(limit = 20): MoodInfluence[] {
    const rows = this.stmtGetInfluences.all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as number,
      timestamp: r.timestamp as string,
      dimension: r.dimension as EmotionDimension,
      old_value: r.old_value as number,
      new_value: r.new_value as number,
      delta: r.delta as number,
      source_engine: r.source_engine as string,
      trigger_event: r.trigger_event as string,
    }));
  }

  getHistory(limit = 50): EmotionalHistoryEntry[] {
    const rows = this.stmtGetHistory.all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      timestamp: r.timestamp as string,
      frustration: r.frustration as number,
      curiosity: r.curiosity as number,
      surprise: r.surprise as number,
      confidence: r.confidence as number,
      satisfaction: r.satisfaction as number,
      stress: r.stress as number,
      momentum: r.momentum as number,
      creativity: r.creativity as number,
      dominant_mood: r.dominant_mood as MoodType,
      mood_score: r.mood_score as number,
      cycle_number: r.cycle_number as number,
    }));
  }

  getRecommendations(): string[] {
    const mood = this.getMood();
    return MOOD_RECOMMENDATIONS[mood.mood] ?? [];
  }

  getStatus(): EmotionalStatus {
    const hc = this.stmtCountHistory.get() as { count: number };
    const ic = this.stmtCountInfluences.get() as { count: number };
    return {
      brainName: this.config.brainName,
      currentMood: this.getMood(),
      historyCount: hc.count,
      influenceCount: ic.count,
      uptime: Date.now() - this.startTime,
      lastSenseTime: this.lastSenseTime,
      cycleCount: this.cycleCount,
    };
  }

  getDimensions(): EmotionalDimensions {
    return { ...this.dimensions };
  }

  // ── Private: Dimension Sensing ──────────────────────

  private senseFrustration(): number {
    const src = this.sources;
    let value = 0;
    if (src.getAutoResponderStatus) {
      const status = src.getAutoResponderStatus();
      const failRate = 1 - status.successRate;
      const severityScore = status.recentSeverity.reduce((sum, s) => {
        if (s === 'critical') return sum + 1.0;
        if (s === 'high') return sum + 0.7;
        if (s === 'medium') return sum + 0.4;
        return sum + 0.1;
      }, 0) / Math.max(status.recentSeverity.length, 1);
      value = failRate * 0.6 + severityScore * 0.4;
    }
    return clamp(value);
  }

  private senseCuriosity(): number {
    const src = this.sources;
    if (src.getCuriosityStatus) {
      const status = src.getCuriosityStatus();
      const gapSignal = Math.min(status.activeGaps / 20, 1) * 0.4;
      const scoreSignal = status.avgGapScore * 0.3;
      const explorationSignal = status.explorationRate * 0.3;
      return clamp(gapSignal + scoreSignal + explorationSignal);
    }
    return 0;
  }

  private senseSurprise(): number {
    const src = this.sources;
    let value = 0;
    if (src.getEmergenceStatus) {
      const status = src.getEmergenceStatus();
      const eventSignal = Math.min(status.recentEvents / 10, 1) * 0.5;
      const surpriseSignal = status.avgSurprise * 0.5;
      value = eventSignal + surpriseSignal;
    }
    return clamp(value);
  }

  private senseConfidence(): number {
    const src = this.sources;
    let signals = 0;
    let total = 0;
    if (src.getHypothesisConfidence) {
      const status = src.getHypothesisConfidence();
      total += status.avgConfidence * 0.5 + status.confirmedRate * 0.5;
      signals++;
    }
    if (src.getPredictionAccuracy) {
      total += src.getPredictionAccuracy();
      signals++;
    }
    return signals > 0 ? clamp(total / signals) : 0.5;
  }

  private senseSatisfaction(): number {
    const src = this.sources;
    if (src.getReportCards) {
      const cards = src.getReportCards();
      if (cards.length === 0) return 0.5;
      const avg = cards.reduce((s, c) => s + c.combined_score, 0) / cards.length;
      return clamp(avg);
    }
    return 0.5;
  }

  private senseStress(): number {
    const src = this.sources;
    if (src.getAttentionStatus) {
      const status = src.getAttentionStatus();
      const urgencySignal = status.avgUrgency * 0.4;
      const burstSignal = Math.min(status.burstCount / 10, 1) * 0.35;
      const switchSignal = Math.min(status.contextSwitches / 20, 1) * 0.25;
      return clamp(urgencySignal + burstSignal + switchSignal);
    }
    return 0;
  }

  private senseMomentum(): number {
    const src = this.sources;
    if (src.getMetaTrend) {
      const trend = src.getMetaTrend();
      const learningSignal = clamp(trend.learningRate) * 0.4;
      const discoverySignal = clamp(trend.discoveryRate) * 0.3;
      const directionBoost = trend.direction === 'improving' ? 0.3 : trend.direction === 'stable' ? 0.15 : 0;
      return clamp(learningSignal + discoverySignal + directionBoost);
    }
    return 0.5;
  }

  private senseCreativity(): number {
    const src = this.sources;
    let signals = 0;
    let total = 0;
    if (src.getReasoningChainCount) {
      total += Math.min(src.getReasoningChainCount() / 50, 1) * 0.4;
      signals++;
    }
    if (src.getCreativeHypothesisCount) {
      total += Math.min(src.getCreativeHypothesisCount() / 20, 1) * 0.35;
      signals++;
    }
    if (src.getDebateCount) {
      total += Math.min(src.getDebateCount() / 10, 1) * 0.25;
      signals++;
    }
    return signals > 0 ? clamp(total) : 0.5;
  }

  // ── Private: Helpers ────────────────────────────────

  private getDimensionSource(dim: EmotionDimension): string {
    const map: Record<EmotionDimension, string> = {
      frustration: 'AutoResponder',
      curiosity: 'CuriosityEngine',
      surprise: 'EmergenceEngine',
      confidence: 'HypothesisEngine+PredictionEngine',
      satisfaction: 'MetaCognitionLayer',
      stress: 'AttentionEngine',
      momentum: 'MetaCognitionLayer+MetaTrends',
      creativity: 'ReasoningEngine+HypothesisEngine+DebateEngine',
    };
    return map[dim];
  }
}

// ── Utility ─────────────────────────────────────────────

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
