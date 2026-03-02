import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';
import type { KnowledgeDistiller } from '../research/knowledge-distiller.js';
import type { HypothesisEngine } from '../hypothesis/engine.js';
import type { ResearchJournal } from '../research/journal.js';

// ── Types ───────────────────────────────────────────────

export interface TeachingPackage {
  id?: number;
  targetBrain: string;
  principles: Array<{ statement: string; confidence: number }>;
  antiPatterns: Array<{ statement: string; confidence: number }>;
  strategies: Array<{ id: string; description: string }>;
  experiments: Array<{ name: string; hypothesis: string; conclusion: string }>;
  journalInsights: string[];
  principlesCount: number;
  antipatternsCount: number;
  strategiesCount: number;
  experimentsCount: number;
  createdAt: string;
  effectivenessScore: number | null;
}

export interface TeachEngineStatus {
  totalPackages: number;
  avgEffectiveness: number;
  recentPackages: TeachingPackage[];
}

// ── Migration ───────────────────────────────────────────

export function runTeachEngineMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teaching_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_brain TEXT NOT NULL,
      package_json TEXT NOT NULL DEFAULT '{}',
      principles_count INTEGER NOT NULL DEFAULT 0,
      antipatterns_count INTEGER NOT NULL DEFAULT 0,
      strategies_count INTEGER NOT NULL DEFAULT 0,
      experiments_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      effectiveness_score REAL DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teaching_packages_target ON teaching_packages(target_brain);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class TeachEngine {
  private db: Database.Database;
  private log = getLogger();
  private thoughtStream: ThoughtStream | null = null;
  private distiller: KnowledgeDistiller | null = null;
  private hypothesisEngine: HypothesisEngine | null = null;
  private journal: ResearchJournal | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    runTeachEngineMigration(db);
  }

  setThoughtStream(stream: ThoughtStream): void {
    this.thoughtStream = stream;
  }

  setKnowledgeDistiller(distiller: KnowledgeDistiller): void {
    this.distiller = distiller;
  }

  setHypothesisEngine(engine: HypothesisEngine): void {
    this.hypothesisEngine = engine;
  }

  setJournal(journal: ResearchJournal): void {
    this.journal = journal;
  }

  /** Create a teaching package for another brain. */
  createPackage(targetBrain: string): TeachingPackage {
    // 1. Top 20 Principles (by confidence) from KnowledgeDistiller
    const principles: TeachingPackage['principles'] = [];
    if (this.distiller) {
      const ps = this.distiller.getPrinciples(undefined, 20);
      for (const p of ps) {
        principles.push({ statement: p.statement, confidence: p.confidence });
      }
    }

    // 2. Top 10 Anti-Patterns from KnowledgeDistiller
    const antiPatterns: TeachingPackage['antiPatterns'] = [];
    if (this.distiller) {
      const aps = this.distiller.getAntiPatterns(undefined, 10);
      for (const ap of aps) {
        antiPatterns.push({ statement: ap.statement, confidence: ap.confidence });
      }
    }

    // 3. Top 5 Strategies from KnowledgeDistiller (query DB directly)
    const strategies: TeachingPackage['strategies'] = [];
    try {
      const rows = this.db.prepare(`
        SELECT id, description FROM knowledge_strategies
        ORDER BY effectiveness DESC LIMIT 5
      `).all() as Array<{ id: string; description: string }>;
      for (const r of rows) {
        strategies.push({ id: r.id, description: r.description });
      }
    } catch { /* knowledge_strategies table might not exist */ }

    // 4. Top 5 experiment results from HypothesisEngine (confirmed with evidence)
    const experiments: TeachingPackage['experiments'] = [];
    if (this.hypothesisEngine) {
      try {
        const confirmed = this.hypothesisEngine.list('confirmed', 5);
        for (const h of confirmed) {
          experiments.push({
            name: `Hypothesis #${h.id}`,
            hypothesis: h.statement,
            conclusion: `Confirmed with confidence ${h.confidence.toFixed(2)} (evidence: ${h.evidence_for} for, ${h.evidence_against} against)`,
          });
        }
      } catch { /* hypotheses table might not exist */ }
    }

    // 5. Key Journal insights (search for 'breakthrough' significance entries, take top 5 titles)
    const journalInsights: string[] = [];
    if (this.journal) {
      try {
        const entries = this.journal.getEntries(undefined, 100);
        const breakthroughs = entries.filter(e => e.significance === 'breakthrough' || e.significance === 'paradigm_shift');
        for (const e of breakthroughs.slice(0, 5)) {
          journalInsights.push(e.title);
        }
      } catch { /* journal table might not exist */ }
    }

    // 6. Package everything
    const pkg: TeachingPackage = {
      targetBrain,
      principles,
      antiPatterns,
      strategies,
      experiments,
      journalInsights,
      principlesCount: principles.length,
      antipatternsCount: antiPatterns.length,
      strategiesCount: strategies.length,
      experimentsCount: experiments.length,
      createdAt: new Date().toISOString(),
      effectivenessScore: null,
    };

    const packageJson = JSON.stringify({
      principles: pkg.principles,
      antiPatterns: pkg.antiPatterns,
      strategies: pkg.strategies,
      experiments: pkg.experiments,
      journalInsights: pkg.journalInsights,
    });

    const result = this.db.prepare(`
      INSERT INTO teaching_packages (target_brain, package_json, principles_count, antipatterns_count, strategies_count, experiments_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      targetBrain, packageJson,
      pkg.principlesCount, pkg.antipatternsCount,
      pkg.strategiesCount, pkg.experimentsCount,
    );

    pkg.id = result.lastInsertRowid as number;

    // 7. Emit thought
    this.thoughtStream?.emit(
      'teach',
      'reflecting',
      `Created teaching package for "${targetBrain}": ${principles.length} principles, ${antiPatterns.length} anti-patterns, ${strategies.length} strategies, ${experiments.length} experiments`,
      principles.length > 5 ? 'notable' : 'routine',
    );

    this.log.info(`[teach] Created package #${pkg.id} for ${targetBrain}: ${principles.length}P, ${antiPatterns.length}AP, ${strategies.length}S, ${experiments.length}E`);

    return pkg;
  }

  /** Get a teaching package by id. */
  getPackage(id: number): TeachingPackage | null {
    const row = this.db.prepare('SELECT * FROM teaching_packages WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.toTeachingPackage(row);
  }

  /** List recent teaching packages. */
  listPackages(limit = 20): TeachingPackage[] {
    const rows = this.db.prepare(`
      SELECT * FROM teaching_packages ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.toTeachingPackage(r));
  }

  /** Rate the effectiveness of a teaching package. */
  rateEffectiveness(id: number, score: number): void {
    const clamped = Math.max(0, Math.min(1, score));
    this.db.prepare(`
      UPDATE teaching_packages SET effectiveness_score = ? WHERE id = ?
    `).run(clamped, id);
    this.log.debug(`[teach] Rated package #${id} effectiveness: ${clamped.toFixed(2)}`);
  }

  /** Get status summary. */
  getStatus(): TeachEngineStatus {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM teaching_packages').get() as { c: number }).c;
    const avgRow = this.db.prepare('SELECT AVG(effectiveness_score) as avg FROM teaching_packages WHERE effectiveness_score IS NOT NULL').get() as { avg: number | null };
    const recentPackages = this.listPackages(5);

    return {
      totalPackages: total,
      avgEffectiveness: avgRow.avg ?? 0,
      recentPackages,
    };
  }

  // ── Private ─────────────────────────────────────────────

  private toTeachingPackage(row: Record<string, unknown>): TeachingPackage {
    const packageData = JSON.parse((row.package_json as string) || '{}');

    return {
      id: row.id as number,
      targetBrain: row.target_brain as string,
      principles: packageData.principles ?? [],
      antiPatterns: packageData.antiPatterns ?? [],
      strategies: packageData.strategies ?? [],
      experiments: packageData.experiments ?? [],
      journalInsights: packageData.journalInsights ?? [],
      principlesCount: row.principles_count as number,
      antipatternsCount: row.antipatterns_count as number,
      strategiesCount: row.strategies_count as number,
      experimentsCount: row.experiments_count as number,
      createdAt: row.created_at as string,
      effectivenessScore: row.effectiveness_score as number | null,
    };
  }
}
