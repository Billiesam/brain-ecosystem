import { getLogger } from '../utils/logger.js';
import type { HnHit, HnSearchResult } from './types.js';

const log = getLogger();

/**
 * Collect GitHub-related posts from HackerNews via Algolia API.
 * Free, no auth required, generous rate limits.
 */
export class HnCollector {
  private aborted = false;

  abort(): void { this.aborted = true; }
  reset(): void { this.aborted = false; }

  /** Search HN for GitHub repos on frontpage (last 24h). */
  async collectFrontpage(): Promise<HnHit[]> {
    const oneDayAgo = Math.floor((Date.now() - 86_400_000) / 1000);
    const url = `https://hn.algolia.com/api/v1/search?query=github.com&tags=story&numericFilters=created_at_i>${oneDayAgo}&hitsPerPage=100`;
    return this.fetch(url);
  }

  /** Cross-reference: search HN for a specific repo name. */
  async searchRepo(repoFullName: string): Promise<HnHit[]> {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(repoFullName)}&tags=story&hitsPerPage=20`;
    return this.fetch(url);
  }

  /** Batch cross-reference: search HN for multiple repos. */
  async crossReference(repoNames: string[]): Promise<Map<string, HnHit[]>> {
    const results = new Map<string, HnHit[]>();
    for (const name of repoNames) {
      if (this.aborted) break;
      const hits = await this.searchRepo(name);
      if (hits.length > 0) {
        results.set(name, hits);
      }
      // Be polite to Algolia API
      await new Promise(r => setTimeout(r, 200));
    }
    return results;
  }

  private async fetch(url: string): Promise<HnHit[]> {
    try {
      const res = await globalThis.fetch(url, {
        headers: { 'User-Agent': 'brain-ecosystem-scanner' },
        signal: this.aborted ? AbortSignal.abort() : undefined,
      });

      if (!res.ok) {
        log.error(`[hn-collector] Fetch failed: ${res.status} ${res.statusText}`);
        return [];
      }

      const data = await res.json() as HnSearchResult;
      return data.hits ?? [];
    } catch (err) {
      if (this.aborted) return [];
      log.error(`[hn-collector] Error: ${(err as Error).message}`);
      return [];
    }
  }
}
