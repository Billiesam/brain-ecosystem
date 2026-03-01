import { getLogger } from '../utils/logger.js';
import type { CoinGeckoMarket, CoinGeckoTrending } from './types.js';

const log = getLogger();

/** AI/DeFi watchlist coin IDs for CoinGecko. */
const WATCHLIST_IDS = [
  // AI
  'render-token', 'fetch-ai', 'ocean-protocol', 'singularitynet', 'bittensor',
  'arkham', 'worldcoin-wld', 'numeraire', 'cortex',
  // DeFi
  'uniswap', 'aave', 'lido-dao', 'maker', 'compound-governance-token',
  'curve-dao-token', 'balancer', 'synthetix-network-token',
  // Infra
  'solana', 'avalanche-2', 'near', 'chainlink', 'polkadot', 'cosmos',
];

/**
 * Collect crypto market data from CoinGecko Free API.
 * Free tier: 10-50 calls/min, no auth needed.
 */
export class CryptoCollector {
  private aborted = false;

  abort(): void { this.aborted = true; }
  reset(): void { this.aborted = false; }

  /** Fetch trending coins from CoinGecko. */
  async collectTrending(): Promise<CoinGeckoTrending | null> {
    try {
      const res = await globalThis.fetch('https://api.coingecko.com/api/v3/search/trending', {
        headers: { 'User-Agent': 'brain-ecosystem-scanner' },
        signal: this.aborted ? AbortSignal.abort() : undefined,
      });
      if (!res.ok) {
        log.error(`[crypto-collector] Trending failed: ${res.status}`);
        return null;
      }
      return await res.json() as CoinGeckoTrending;
    } catch (err) {
      if (this.aborted) return null;
      log.error(`[crypto-collector] Error: ${(err as Error).message}`);
      return null;
    }
  }

  /** Fetch market data for watchlist coins. */
  async collectWatchlist(): Promise<CoinGeckoMarket[]> {
    return this.fetchMarkets(WATCHLIST_IDS);
  }

  /** Fetch top movers by market cap (top 250). */
  async collectTopMovers(limit = 250): Promise<CoinGeckoMarket[]> {
    const perPage = Math.min(limit, 250);
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=7d`;
    try {
      const res = await globalThis.fetch(url, {
        headers: { 'User-Agent': 'brain-ecosystem-scanner' },
        signal: this.aborted ? AbortSignal.abort() : undefined,
      });
      if (!res.ok) {
        log.error(`[crypto-collector] Top movers failed: ${res.status}`);
        return [];
      }
      return await res.json() as CoinGeckoMarket[];
    } catch (err) {
      if (this.aborted) return [];
      log.error(`[crypto-collector] Error: ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchMarkets(ids: string[]): Promise<CoinGeckoMarket[]> {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids.join(',')}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
    try {
      const res = await globalThis.fetch(url, {
        headers: { 'User-Agent': 'brain-ecosystem-scanner' },
        signal: this.aborted ? AbortSignal.abort() : undefined,
      });
      if (!res.ok) {
        log.error(`[crypto-collector] Watchlist failed: ${res.status}`);
        return [];
      }
      return await res.json() as CoinGeckoMarket[];
    } catch (err) {
      if (this.aborted) return [];
      log.error(`[crypto-collector] Error: ${(err as Error).message}`);
      return [];
    }
  }
}
