import Database from 'better-sqlite3';
import fs from 'node:fs';
import { getLogger } from '@timmeck/brain-core/utils/logger';

// ── Types ───────────────────────────────────────────

export interface ReposignalRepo {
  id: number;
  full_name: string;
  name: string;
  owner: string;
  description: string | null;
  language: string | null;
  topics: string | null;
  current_stars: number;
  current_forks: number;
  signal_score: number;
  signal_level: string;
  phase: string;
  first_seen_at: string;
  last_scanned_at: string | null;
}

export interface ReposignalHnMention {
  title: string;
  url: string;
  score: number;
  comment_count: number;
  repo_id: number | null;
}

export interface ReposignalImportOptions {
  /** Minimum signal level: 'noise' | 'watch' | 'signal' | 'breakout'. Default: 'watch' */
  minSignalLevel?: string;
  /** Maximum repos to import per run. Default: 5000 */
  batchSize?: number;
  /** Import HN mentions too. Default: true */
  includeHnMentions?: boolean;
  /** Record metrics for PredictionEngine. Default: true */
  recordMetrics?: boolean;
}

export interface ReposignalImportResult {
  dbPath: string;
  totalReposInDb: number;
  reposImported: number;
  discoveriesCreated: number;
  journalEntriesCreated: number;
  hnMentionsImported: number;
  metricsRecorded: number;
  skippedDuplicates: number;
  languageBreakdown: Record<string, number>;
  signalBreakdown: Record<string, number>;
  duration_ms: number;
}

// ── Constants ───────────────────────────────────────

const SIGNAL_LEVELS = ['noise', 'watch', 'signal', 'breakout'] as const;

function signalLevelIndex(level: string): number {
  return SIGNAL_LEVELS.indexOf(level as typeof SIGNAL_LEVELS[number]);
}

// ── Importer ────────────────────────────────────────

export class ReposignalImporter {
  private brainDb: Database.Database;
  private log = getLogger();
  private lastResult: ReposignalImportResult | null = null;

  constructor(brainDb: Database.Database) {
    this.brainDb = brainDb;
    this.ensureStateTable();
  }

  private ensureStateTable(): void {
    this.brainDb.exec(`
      CREATE TABLE IF NOT EXISTS reposignal_import_state (
        repo_full_name TEXT PRIMARY KEY,
        signal_score REAL NOT NULL,
        signal_level TEXT NOT NULL,
        imported_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  /** Import repos from a reposignal/aisurvival SQLite database. */
  import(dbPath: string, options: ReposignalImportOptions = {}): ReposignalImportResult {
    const start = Date.now();
    const minLevel = options.minSignalLevel ?? 'watch';
    const batchSize = options.batchSize ?? 5000;
    const includeHn = options.includeHnMentions !== false;
    const recordMetrics = options.recordMetrics !== false;

    if (!fs.existsSync(dbPath)) {
      throw new Error(`Reposignal DB not found: ${dbPath}`);
    }

    const extDb = new Database(dbPath, { readonly: true });

    const result: ReposignalImportResult = {
      dbPath,
      totalReposInDb: 0,
      reposImported: 0,
      discoveriesCreated: 0,
      journalEntriesCreated: 0,
      hnMentionsImported: 0,
      metricsRecorded: 0,
      skippedDuplicates: 0,
      languageBreakdown: {},
      signalBreakdown: {},
      duration_ms: 0,
    };

    try {
      // Count total repos
      result.totalReposInDb = (extDb.prepare('SELECT COUNT(*) as c FROM repositories').get() as { c: number }).c;

      // Fetch repos at or above minimum signal level
      const minLevelIdx = signalLevelIndex(minLevel);
      const allowedLevels = SIGNAL_LEVELS.filter((_, i) => i >= minLevelIdx);
      const placeholders = allowedLevels.map(() => '?').join(',');

      const repos = extDb.prepare(`
        SELECT id, full_name, name, owner, description, language, topics,
               current_stars, current_forks, signal_score, signal_level, phase,
               first_seen_at, last_scanned_at
        FROM repositories
        WHERE signal_level IN (${placeholders}) AND is_active = 1
        ORDER BY signal_score DESC
        LIMIT ?
      `).all(...allowedLevels, batchSize) as ReposignalRepo[];

      this.log.info(`[reposignal] Found ${repos.length} repos at ${minLevel}+ level (${result.totalReposInDb} total in DB)`);

      // Check which repos we already imported
      const alreadyImported = new Set<string>();
      const existing = this.brainDb.prepare('SELECT repo_full_name FROM reposignal_import_state').all() as Array<{ repo_full_name: string }>;
      for (const e of existing) alreadyImported.add(e.repo_full_name);

      // Prepare statements
      const insertDiscovery = this.brainDb.prepare(`
        INSERT INTO research_discoveries (type, title, description, confidence, impact, source, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertJournal = this.brainDb.prepare(`
        INSERT INTO research_journal (timestamp, type, title, content, tags, ref_ids, significance, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertState = this.brainDb.prepare(`
        INSERT OR REPLACE INTO reposignal_import_state (repo_full_name, signal_score, signal_level)
        VALUES (?, ?, ?)
      `);

      // Batch import repos
      const importBatch = this.brainDb.transaction(() => {
        for (const repo of repos) {
          // Track breakdown
          const lang = repo.language || 'unknown';
          result.languageBreakdown[lang] = (result.languageBreakdown[lang] || 0) + 1;
          result.signalBreakdown[repo.signal_level] = (result.signalBreakdown[repo.signal_level] || 0) + 1;

          // Skip duplicates
          if (alreadyImported.has(repo.full_name)) {
            result.skippedDuplicates++;
            continue;
          }

          // Create research discovery for signal+ repos
          const confidence = Math.min(repo.signal_score / 100, 1.0);
          const impact = repo.signal_level === 'breakout' ? 0.9 : repo.signal_level === 'signal' ? 0.7 : 0.4;

          const topics = this.parseTopics(repo.topics);
          const description = [
            repo.description || 'No description',
            `Language: ${lang}`,
            `Stars: ${repo.current_stars}, Forks: ${repo.current_forks}`,
            `Phase: ${repo.phase}`,
            topics.length > 0 ? `Topics: ${topics.join(', ')}` : '',
          ].filter(Boolean).join('\n');

          insertDiscovery.run(
            'reposignal_import',
            `[${repo.signal_level.toUpperCase()}] ${repo.full_name} — ${(repo.description || 'GitHub project').slice(0, 120)}`,
            description,
            confidence,
            impact,
            'reposignal',
            JSON.stringify({
              repo: repo.full_name,
              language: lang,
              stars: repo.current_stars,
              forks: repo.current_forks,
              signal_score: repo.signal_score,
              signal_level: repo.signal_level,
              phase: repo.phase,
              topics,
            }),
          );
          result.discoveriesCreated++;

          // Mark as imported
          insertState.run(repo.full_name, repo.signal_score, repo.signal_level);
          result.reposImported++;
        }

        // Create journal entries summarizing the import by language
        const langGroups = Object.entries(result.languageBreakdown)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 10);

        if (result.reposImported > 0) {
          const langSummary = langGroups.map(([lang, count]) => `${lang}: ${count}`).join(', ');
          insertJournal.run(
            Date.now(),
            'discovery',
            `Reposignal Import: ${result.reposImported} repos imported`,
            `Imported ${result.reposImported} trending repos from reposignal DB (${result.totalReposInDb} total tracked).\n` +
            `Signal breakdown: ${Object.entries(result.signalBreakdown).map(([k, v]) => `${k}: ${v}`).join(', ')}\n` +
            `Top languages: ${langSummary}`,
            JSON.stringify(['reposignal', 'import', 'tech-trends']),
            '[]',
            'notable',
            JSON.stringify({ reposImported: result.reposImported, languageBreakdown: result.languageBreakdown }),
          );
          result.journalEntriesCreated++;
        }

        // Create journal entries for top signal repos (breakout/signal)
        const topRepos = repos
          .filter(r => !alreadyImported.has(r.full_name) && (r.signal_level === 'breakout' || r.signal_level === 'signal'))
          .slice(0, 20);

        for (const repo of topRepos) {
          const topics = this.parseTopics(repo.topics);
          insertJournal.run(
            Date.now(),
            'discovery',
            `Trending: ${repo.full_name} (${repo.signal_level}, ${repo.signal_score.toFixed(1)} score)`,
            `${repo.description || 'No description'}\n` +
            `Language: ${repo.language || 'unknown'}, Stars: ${repo.current_stars}, Phase: ${repo.phase}`,
            JSON.stringify(['reposignal', repo.signal_level, repo.language || 'unknown', ...topics.slice(0, 3)]),
            '[]',
            repo.signal_level === 'breakout' ? 'breakthrough' : 'notable',
            JSON.stringify({ repo: repo.full_name, signal_score: repo.signal_score }),
          );
          result.journalEntriesCreated++;
        }
      });

      importBatch();

      // Import HN mentions
      if (includeHn) {
        result.hnMentionsImported = this.importHnMentions(extDb, insertJournal);
        result.journalEntriesCreated += result.hnMentionsImported;
      }

      // Record metrics for PredictionEngine
      if (recordMetrics) {
        result.metricsRecorded = this.recordImportMetrics(result);
      }

    } finally {
      extDb.close();
    }

    result.duration_ms = Date.now() - start;
    this.lastResult = result;
    this.log.info(`[reposignal] Import complete: ${result.reposImported} repos, ${result.discoveriesCreated} discoveries, ${result.journalEntriesCreated} journal entries in ${result.duration_ms}ms`);

    return result;
  }

  /** Import top HN mentions as journal entries. */
  private importHnMentions(extDb: Database.Database, insertJournal: Database.Statement): number {
    let count = 0;
    try {
      const mentions = extDb.prepare(`
        SELECT DISTINCT title, url, score, comment_count
        FROM hn_mentions
        WHERE score > 50
        ORDER BY score DESC
        LIMIT 100
      `).all() as ReposignalHnMention[];

      for (const m of mentions) {
        insertJournal.run(
          Date.now(),
          'discovery',
          `HN: ${m.title} (${m.score} pts, ${m.comment_count} comments)`,
          `High-engagement HN/Reddit post: ${m.title}\nScore: ${m.score}, Comments: ${m.comment_count}`,
          JSON.stringify(['reposignal', 'hn', 'social-signal']),
          '[]',
          m.score > 500 ? 'notable' : 'routine',
          JSON.stringify({ source: 'hn', score: m.score, comments: m.comment_count }),
        );
        count++;
      }
    } catch {
      this.log.debug('[reposignal] No HN mentions table or error reading it');
    }
    return count;
  }

  /** Record aggregated metrics into prediction_metrics table. */
  private recordImportMetrics(result: ReposignalImportResult): number {
    let count = 0;
    try {
      const insertMetric = this.brainDb.prepare(`
        INSERT INTO prediction_metrics (metric, value, timestamp, domain)
        VALUES (?, ?, ?, ?)
      `);
      const now = Date.now();

      insertMetric.run('reposignal_total_repos', result.totalReposInDb, now, 'metric');
      count++;
      insertMetric.run('reposignal_repos_imported', result.reposImported, now, 'metric');
      count++;

      // Record per-language counts
      for (const [lang, langCount] of Object.entries(result.languageBreakdown)) {
        if (langCount >= 10) {
          insertMetric.run(`reposignal_lang_${lang.toLowerCase()}`, langCount, now, 'metric');
          count++;
        }
      }

      // Record signal level counts
      for (const [level, levelCount] of Object.entries(result.signalBreakdown)) {
        insertMetric.run(`reposignal_${level}_count`, levelCount, now, 'metric');
        count++;
      }
    } catch (err) {
      this.log.debug('[reposignal] Error recording metrics:', err);
    }
    return count;
  }

  private parseTopics(topics: string | null): string[] {
    if (!topics) return [];
    try { return JSON.parse(topics); } catch { return []; }
  }

  getLastResult(): ReposignalImportResult | null {
    return this.lastResult;
  }

  /** Get import stats from state table. */
  getStats(): { totalImported: number; byLevel: Record<string, number>; lastImport: string | null } {
    const total = (this.brainDb.prepare('SELECT COUNT(*) as c FROM reposignal_import_state').get() as { c: number }).c;
    const levels = this.brainDb.prepare('SELECT signal_level, COUNT(*) as c FROM reposignal_import_state GROUP BY signal_level').all() as Array<{ signal_level: string; c: number }>;
    const last = this.brainDb.prepare('SELECT MAX(imported_at) as t FROM reposignal_import_state').get() as { t: string | null };

    const byLevel: Record<string, number> = {};
    for (const l of levels) byLevel[l.signal_level] = l.c;

    return { totalImported: total, byLevel, lastImport: last.t };
  }
}
