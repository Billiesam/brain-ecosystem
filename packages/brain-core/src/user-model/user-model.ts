// ── User Model — Skill Tracking & Preference Storage ─────────
//
// Tracks user interactions to infer skill levels per domain,
// stores explicit preferences, and builds a user profile.

import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export type SkillLevel = 'beginner' | 'intermediate' | 'expert';

export interface UserProfile {
  skillDomains: Map<string, SkillLevel>;
  topTools: string[];
  activeHours: number[];
  errorPatterns: string[];
}

export interface UserModelConfig {
  brainName: string;
}

export interface UserModelStatus {
  totalKeys: number;
  domains: number;
  lastUpdated: string | null;
}

interface ProfileRow {
  id: number;
  key: string;
  value: string;
  confidence: number;
  updated_at: string;
}

// ── Migration ───────────────────────────────────────────

export function runUserModelMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ── Engine ──────────────────────────────────────────────

export class UserModel {
  private db: Database.Database;
  private config: UserModelConfig;
  private ts: ThoughtStream | null = null;
  private log = getLogger();

  // Prepared statements
  private stmtUpsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtCountKeys: Database.Statement;
  private stmtCountDomains: Database.Statement;
  private stmtLastUpdated: Database.Statement;
  private stmtAllDomains: Database.Statement;
  private stmtAllKeys: Database.Statement;

  constructor(db: Database.Database, config: UserModelConfig) {
    this.db = db;
    this.config = config;

    runUserModelMigration(db);

    // Prepare all statements
    this.stmtUpsert = db.prepare(`
      INSERT INTO user_profile (key, value, confidence, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        updated_at = datetime('now')
    `);

    this.stmtGet = db.prepare(`
      SELECT * FROM user_profile WHERE key = ?
    `);

    this.stmtCountKeys = db.prepare(`
      SELECT COUNT(*) AS total FROM user_profile
    `);

    this.stmtCountDomains = db.prepare(`
      SELECT COUNT(*) AS cnt FROM user_profile WHERE key LIKE 'domain:%'
    `);

    this.stmtLastUpdated = db.prepare(`
      SELECT MAX(updated_at) AS last FROM user_profile
    `);

    this.stmtAllDomains = db.prepare(`
      SELECT key, value, confidence FROM user_profile WHERE key LIKE 'domain:%' ORDER BY confidence DESC
    `);

    this.stmtAllKeys = db.prepare(`
      SELECT key, value FROM user_profile ORDER BY updated_at DESC
    `);

    this.log.info(`[user-model] Initialized for ${config.brainName}`);
  }

  /** Set the ThoughtStream for consciousness integration. */
  setThoughtStream(stream: ThoughtStream): void {
    this.ts = stream;
  }

  /**
   * Update profile from a tool interaction.
   * Tracks tool frequency per domain, infers skill levels.
   */
  updateFromInteraction(toolName: string, context: string | null, outcome: string): void {
    // Extract domain from tool name (e.g., "mcp.search" → "mcp", "trading.analyze" → "trading")
    const domain = toolName.includes('.') ? toolName.split('.')[0]! : 'general';

    // Update tool frequency
    const toolKey = `tool_freq:${toolName}`;
    const existing = this._getKey(toolKey);
    const currentCount = existing ? parseInt(existing, 10) : 0;
    const newCount = currentCount + 1;
    this._setKey(toolKey, String(newCount), Math.min(newCount / 20, 1.0));

    // Update domain usage count
    const domainKey = `domain_uses:${domain}`;
    const domainExisting = this._getKey(domainKey);
    const domainCount = domainExisting ? parseInt(domainExisting, 10) : 0;
    const newDomainCount = domainCount + 1;

    // Only count successful outcomes toward skill level
    const successKey = `domain_success:${domain}`;
    const successExisting = this._getKey(successKey);
    const successCount = successExisting ? parseInt(successExisting, 10) : 0;
    const newSuccessCount = outcome === 'success' ? successCount + 1 : successCount;

    this._setKey(domainKey, String(newDomainCount), Math.min(newDomainCount / 20, 1.0));
    this._setKey(successKey, String(newSuccessCount), Math.min(newSuccessCount / 20, 1.0));

    // Infer skill level based on successful uses
    const skillLevel = this.inferSkillLevel(newSuccessCount);
    this._setKey(`domain:${domain}`, skillLevel, Math.min(newSuccessCount / 15, 1.0));

    // Track active hour
    const hour = new Date().getHours();
    const hourKey = `active_hour:${hour}`;
    const hourExisting = this._getKey(hourKey);
    const hourCount = hourExisting ? parseInt(hourExisting, 10) : 0;
    this._setKey(hourKey, String(hourCount + 1), 0.5);

    // Track error patterns
    if (outcome === 'failure' && context) {
      const errorKey = `error_pattern:${domain}`;
      const patterns = this._getKey(errorKey);
      const patternList: string[] = patterns ? JSON.parse(patterns) : [];
      const snippet = context.substring(0, 100);
      if (!patternList.includes(snippet)) {
        patternList.push(snippet);
        if (patternList.length > 10) patternList.shift();
        this._setKey(errorKey, JSON.stringify(patternList), 0.5);
      }
    }

    this.ts?.emit(
      'user-model',
      'analyzing',
      `Updated profile: ${domain} (${skillLevel}), tool ${toolName}`,
      'routine',
    );
  }

  /** Build and return the full user profile. */
  getProfile(): UserProfile {
    // Skill domains
    const domainRows = this.stmtAllDomains.all() as ProfileRow[];
    const skillDomains = new Map<string, SkillLevel>();
    for (const row of domainRows) {
      const domainName = row.key.replace('domain:', '');
      skillDomains.set(domainName, row.value as SkillLevel);
    }

    // Top tools (by frequency)
    const allKeys = this.stmtAllKeys.all() as ProfileRow[];
    const toolFreqs: Array<{ tool: string; count: number }> = [];
    for (const row of allKeys) {
      if (row.key.startsWith('tool_freq:')) {
        toolFreqs.push({
          tool: row.key.replace('tool_freq:', ''),
          count: parseInt(row.value, 10),
        });
      }
    }
    toolFreqs.sort((a, b) => b.count - a.count);
    const topTools = toolFreqs.slice(0, 10).map(t => t.tool);

    // Active hours
    const activeHours: number[] = [];
    for (const row of allKeys) {
      if (row.key.startsWith('active_hour:')) {
        const hour = parseInt(row.key.replace('active_hour:', ''), 10);
        const count = parseInt(row.value, 10);
        if (count > 0) activeHours.push(hour);
      }
    }
    activeHours.sort((a, b) => a - b);

    // Error patterns
    const errorPatterns: string[] = [];
    for (const row of allKeys) {
      if (row.key.startsWith('error_pattern:')) {
        try {
          const patterns: string[] = JSON.parse(row.value);
          errorPatterns.push(...patterns);
        } catch {
          // Ignore malformed entries
        }
      }
    }

    return { skillDomains, topTools, activeHours, errorPatterns };
  }

  /** Set an explicit user preference. */
  setPreference(key: string, value: string): void {
    this._setKey(`pref:${key}`, value, 1.0);
  }

  /** Get a stored user preference, or null if not set. */
  getPreference(key: string): string | null {
    return this._getKey(`pref:${key}`);
  }

  /** Get model status summary. */
  getStatus(): UserModelStatus {
    const totalKeys = (this.stmtCountKeys.get() as { total: number }).total;
    const domains = (this.stmtCountDomains.get() as { cnt: number }).cnt;
    const lastUpdated = (this.stmtLastUpdated.get() as { last: string | null }).last;

    return {
      totalKeys,
      domains,
      lastUpdated,
    };
  }

  // ── Internal ──────────────────────────────────────────

  /** Store a key-value pair with confidence. */
  _setKey(key: string, value: string, confidence: number): void {
    this.stmtUpsert.run(key, value, confidence);
  }

  /** Retrieve a value by key, or null if not found. */
  _getKey(key: string): string | null {
    const row = this.stmtGet.get(key) as ProfileRow | undefined;
    return row ? row.value : null;
  }

  /** Infer skill level from successful interaction count. */
  private inferSkillLevel(successfulUses: number): SkillLevel {
    if (successfulUses > 10) return 'expert';
    if (successfulUses >= 3) return 'intermediate';
    return 'beginner';
  }
}
