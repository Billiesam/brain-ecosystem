import { getLogger } from '../utils/logger.js';
import type { GitHubRepo, GitHubSearchResult, ScannerConfig } from './types.js';

const log = getLogger();

const TRENDING_LANGUAGES = [
  'TypeScript', 'Python', 'Rust', 'Go', 'JavaScript',
  'C++', 'Java', 'Kotlin', 'Swift', 'Zig',
  'C#', 'Ruby', 'Elixir',
];

/**
 * Collect emerging and trending repos from GitHub Search API.
 * Respects rate limits (30 req/min for authenticated, 10 for unauthed).
 */
export class GitHubCollector {
  private token: string;
  private minStarsEmerging: number;
  private minStarsTrending: number;
  private aborted = false;

  constructor(config: Pick<ScannerConfig, 'githubToken' | 'minStarsEmerging' | 'minStarsTrending'>) {
    this.token = config.githubToken;
    this.minStarsEmerging = config.minStarsEmerging;
    this.minStarsTrending = config.minStarsTrending;
  }

  abort(): void { this.aborted = true; }
  reset(): void { this.aborted = false; }

  /** Fetch emerging repos: created in last 7 days with stars > threshold. */
  async collectEmerging(): Promise<GitHubRepo[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];
    const query = `created:>${sevenDaysAgo} stars:>${this.minStarsEmerging}`;
    return this.searchAll(query, 300);
  }

  /** Fetch trending repos: pushed in last 3 days with stars > threshold, per language. */
  async collectTrending(): Promise<GitHubRepo[]> {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString().split('T')[0];
    const all: GitHubRepo[] = [];
    const seen = new Set<number>();

    for (const lang of TRENDING_LANGUAGES) {
      if (this.aborted) break;
      const query = `pushed:>${threeDaysAgo} stars:>${this.minStarsTrending} language:${lang}`;
      const repos = await this.search(query, 1, 30);
      for (const r of repos) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          all.push(r);
        }
      }
      // Delay between language searches to respect rate limits
      await sleep(1200);
    }

    return all;
  }

  /** Search with pagination up to maxResults. */
  private async searchAll(query: string, maxResults: number): Promise<GitHubRepo[]> {
    const all: GitHubRepo[] = [];
    const perPage = 100;
    const maxPages = Math.ceil(maxResults / perPage);

    for (let page = 1; page <= maxPages; page++) {
      if (this.aborted) break;
      const repos = await this.search(query, page, perPage);
      all.push(...repos);
      if (repos.length < perPage) break;
      await sleep(1500);
    }

    return all;
  }

  /** Single search API call. */
  private async search(query: string, page: number, perPage: number): Promise<GitHubRepo[]> {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'brain-ecosystem-scanner',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const res = await fetch(url, { headers, signal: this.aborted ? AbortSignal.abort() : undefined });

      if (res.status === 403 || res.status === 429) {
        const reset = res.headers.get('x-ratelimit-reset');
        const waitMs = reset ? (Number(reset) * 1000 - Date.now()) : 60_000;
        log.warn(`[github-collector] Rate limited, waiting ${Math.ceil(waitMs / 1000)}s`);
        await sleep(Math.min(waitMs, 120_000));
        return this.search(query, page, perPage);
      }

      if (!res.ok) {
        log.error(`[github-collector] Search failed: ${res.status} ${res.statusText}`);
        return [];
      }

      const data = await res.json() as GitHubSearchResult;
      return data.items ?? [];
    } catch (err) {
      if (this.aborted) return [];
      log.error(`[github-collector] Error: ${(err as Error).message}`);
      return [];
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
