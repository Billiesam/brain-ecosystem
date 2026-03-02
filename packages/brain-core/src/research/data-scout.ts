import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export interface ScoutDiscovery {
  id?: number;
  source: string;
  title: string;
  url: string;
  description: string;
  relevanceScore: number;
  metadata: Record<string, unknown>;
  discoveredAt: string;
  imported: boolean;
}

export interface ScoutAdapter {
  name: string;
  scout(): Promise<ScoutDiscovery[]>;
  isEnabled(): boolean;
}

export interface DataScoutStatus {
  totalDiscoveries: number;
  importedCount: number;
  bySource: Record<string, number>;
  recentDiscoveries: ScoutDiscovery[];
}

// ── Migration ───────────────────────────────────────────

export function runDataScoutMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scout_discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      relevance_score REAL NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      discovered_at TEXT DEFAULT (datetime('now')),
      imported INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_scout_source ON scout_discoveries(source);
    CREATE INDEX IF NOT EXISTS idx_scout_relevance ON scout_discoveries(relevance_score DESC);
  `);
}

// ── DataScout ───────────────────────────────────────────

export class DataScout {
  private db: Database.Database;
  private adapters: ScoutAdapter[];
  private thoughtStream: ThoughtStream | null = null;
  private log = getLogger();

  constructor(db: Database.Database, adapters: ScoutAdapter[] = []) {
    this.db = db;
    this.adapters = adapters;
    runDataScoutMigration(db);
  }

  setThoughtStream(stream: ThoughtStream): void {
    this.thoughtStream = stream;
  }

  addAdapter(adapter: ScoutAdapter): void {
    this.adapters.push(adapter);
    this.log.info(`[data-scout] Added adapter: ${adapter.name}`);
  }

  /** Run all enabled adapters, deduplicate, persist new discoveries. */
  async scout(): Promise<ScoutDiscovery[]> {
    const allDiscoveries: ScoutDiscovery[] = [];

    for (const adapter of this.adapters) {
      if (!adapter.isEnabled()) continue;

      try {
        const discoveries = await adapter.scout();
        let newCount = 0;

        for (const discovery of discoveries) {
          if (this.isDuplicate(discovery.source, discovery.title)) continue;

          this.db.prepare(`
            INSERT INTO scout_discoveries (source, title, url, description, relevance_score, metadata)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            discovery.source,
            discovery.title,
            discovery.url,
            discovery.description,
            discovery.relevanceScore,
            JSON.stringify(discovery.metadata),
          );

          allDiscoveries.push(discovery);
          newCount++;
        }

        if (newCount > 0) {
          this.log.info(`[data-scout] ${adapter.name}: ${newCount} new discoveries`);
          this.thoughtStream?.emit(
            'data-scout', 'discovering',
            `DataScout ${adapter.name}: found ${newCount} new items`,
            newCount >= 5 ? 'notable' : 'routine',
            { adapter: adapter.name, count: newCount },
          );
        }
      } catch (err) {
        this.log.error(`[data-scout] Error in adapter ${adapter.name}: ${(err as Error).message}`);
      }
    }

    return allDiscoveries;
  }

  /** Get discoveries, optionally filtered by source. */
  getDiscoveries(source?: string, limit = 20): ScoutDiscovery[] {
    if (source) {
      return (this.db.prepare(
        'SELECT * FROM scout_discoveries WHERE source = ? ORDER BY relevance_score DESC LIMIT ?',
      ).all(source, limit) as Array<Record<string, unknown>>).map(r => this.toDiscovery(r));
    }
    return (this.db.prepare(
      'SELECT * FROM scout_discoveries ORDER BY relevance_score DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>).map(r => this.toDiscovery(r));
  }

  /** Mark a discovery as imported. */
  markImported(id: number): void {
    this.db.prepare('UPDATE scout_discoveries SET imported = 1 WHERE id = ?').run(id);
  }

  /** Get status summary. */
  getStatus(): DataScoutStatus {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM scout_discoveries').get() as { c: number }).c;
    const imported = (this.db.prepare('SELECT COUNT(*) as c FROM scout_discoveries WHERE imported = 1').get() as { c: number }).c;

    const sourceRows = this.db.prepare(
      'SELECT source, COUNT(*) as c FROM scout_discoveries GROUP BY source',
    ).all() as Array<{ source: string; c: number }>;
    const bySource: Record<string, number> = {};
    for (const row of sourceRows) {
      bySource[row.source] = row.c;
    }

    const recent = this.getDiscoveries(undefined, 10);

    return {
      totalDiscoveries: total,
      importedCount: imported,
      bySource,
      recentDiscoveries: recent,
    };
  }

  // ── Private ──────────────────────────────────────────────

  private isDuplicate(source: string, title: string): boolean {
    const row = this.db.prepare(
      'SELECT id FROM scout_discoveries WHERE source = ? AND title = ? LIMIT 1',
    ).get(source, title) as { id: number } | undefined;
    return !!row;
  }

  private toDiscovery(row: Record<string, unknown>): ScoutDiscovery {
    return {
      id: row.id as number,
      source: row.source as string,
      title: row.title as string,
      url: row.url as string,
      description: row.description as string,
      relevanceScore: row.relevance_score as number,
      metadata: JSON.parse((row.metadata as string) || '{}'),
      discoveredAt: row.discovered_at as string,
      imported: (row.imported as number) === 1,
    };
  }
}

// ── Adapters ──────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * GitHubTrendingAdapter — Discovers trending GitHub repositories.
 */
export class GitHubTrendingAdapter implements ScoutAdapter {
  readonly name = 'github-trending';

  isEnabled(): boolean {
    return true;
  }

  async scout(): Promise<ScoutDiscovery[]> {
    try {
      const res = await fetch(
        'https://api.github.com/search/repositories?q=stars:>100+pushed:>2024-01-01&sort=stars&order=desc&per_page=10',
        {
          headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'brain-ecosystem',
          },
        },
      );

      if (!res.ok) return [];

      const data = await res.json() as { items?: Array<{
        full_name: string;
        description: string | null;
        stargazers_count: number;
        html_url: string;
        language: string | null;
        topics?: string[];
      }> };

      if (!data.items) return [];

      return data.items.map(repo => ({
        source: this.name,
        title: repo.full_name,
        url: repo.html_url,
        description: repo.description || '',
        relevanceScore: Math.min(1, repo.stargazers_count / 50000),
        metadata: {
          stars: repo.stargazers_count,
          language: repo.language,
          topics: repo.topics ?? [],
        },
        discoveredAt: new Date().toISOString(),
        imported: false,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * NpmStatsAdapter — Discovers trending npm packages.
 */
export class NpmStatsAdapter implements ScoutAdapter {
  readonly name = 'npm-stats';

  isEnabled(): boolean {
    return true;
  }

  async scout(): Promise<ScoutDiscovery[]> {
    try {
      const res = await fetch(
        'https://registry.npmjs.org/-/v1/search?text=typescript+ai&size=10',
        {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'brain-ecosystem',
          },
        },
      );

      if (!res.ok) return [];

      const data = await res.json() as { objects?: Array<{
        package: {
          name: string;
          description?: string;
          version: string;
          links?: { npm?: string };
        };
        searchScore?: number;
      }> };

      if (!data.objects) return [];

      return data.objects.map(obj => ({
        source: this.name,
        title: obj.package.name,
        url: obj.package.links?.npm || `https://www.npmjs.com/package/${obj.package.name}`,
        description: obj.package.description || '',
        relevanceScore: Math.min(1, obj.searchScore ?? 0),
        metadata: {
          version: obj.package.version,
          searchScore: obj.searchScore,
        },
        discoveredAt: new Date().toISOString(),
        imported: false,
      }));
    } catch {
      return [];
    }
  }
}

/**
 * HackerNewsAdapter — Discovers top Hacker News stories.
 */
export class HackerNewsAdapter implements ScoutAdapter {
  readonly name = 'hackernews';

  isEnabled(): boolean {
    return true;
  }

  async scout(): Promise<ScoutDiscovery[]> {
    try {
      const topRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
      if (!topRes.ok) return [];

      const ids = await topRes.json() as number[];
      if (!Array.isArray(ids)) return [];

      const topIds = ids.slice(0, 10);
      const discoveries: ScoutDiscovery[] = [];

      for (const id of topIds) {
        try {
          await sleep(200);
          const itemRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
          if (!itemRes.ok) continue;

          const item = await itemRes.json() as {
            title?: string;
            url?: string;
            score?: number;
            by?: string;
            type?: string;
          };

          if (!item || !item.title) continue;

          discoveries.push({
            source: this.name,
            title: item.title,
            url: item.url || `https://news.ycombinator.com/item?id=${id}`,
            description: `Score: ${item.score ?? 0} | By: ${item.by ?? 'unknown'}`,
            relevanceScore: Math.min(1, (item.score ?? 0) / 500),
            metadata: {
              hnId: id,
              score: item.score,
              by: item.by,
              type: item.type,
            },
            discoveredAt: new Date().toISOString(),
            imported: false,
          });
        } catch {
          // Skip individual item failures
        }
      }

      return discoveries;
    } catch {
      return [];
    }
  }
}
