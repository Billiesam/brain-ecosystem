import type { PaperConfig, OHLCVCandle } from './types.js';
import type { PaperRepository } from '../db/repositories/paper.repository.js';
import { getLogger } from '../utils/logger.js';

interface CoinGeckoPrice {
  [id: string]: { usd: number };
}

interface YahooChartResult {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: number[];
          high?: number[];
          low?: number[];
          close?: number[];
          volume?: number[];
        }>;
      };
    }>;
  };
}

export class PriceFetcher {
  private priceCache = new Map<string, number>();
  private candleCache = new Map<string, OHLCVCandle[]>();
  private lastOHLCVFetch = 0;
  private readonly OHLCV_INTERVAL = 900_000; // 15 minutes
  private logger = getLogger();

  constructor(
    private config: PaperConfig,
    private repo: PaperRepository,
  ) {
    this.loadCacheFromDb();
  }

  /**
   * Fetch all prices (current spot + OHLCV if stale).
   */
  async fetchAll(): Promise<Map<string, number>> {
    await Promise.all([
      this.fetchCryptoPrices(),
      this.fetchStockPrices(),
    ]);

    // Refresh OHLCV candles periodically
    if (Date.now() - this.lastOHLCVFetch > this.OHLCV_INTERVAL) {
      await this.fetchOHLCVData();
      this.lastOHLCVFetch = Date.now();
    }

    return this.priceCache;
  }

  getPrice(symbol: string): number | undefined {
    return this.priceCache.get(symbol);
  }

  getCandles(symbol: string): OHLCVCandle[] {
    return this.candleCache.get(symbol) ?? [];
  }

  getAllSymbols(): string[] {
    return [
      ...this.config.cryptoIds,
      ...this.config.stockSymbols,
    ];
  }

  private async fetchCryptoPrices(): Promise<void> {
    if (this.config.cryptoIds.length === 0) return;

    try {
      const ids = this.config.cryptoIds.join(',');
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
      const response = await fetch(url);

      if (!response.ok) {
        this.logger.warn(`CoinGecko price fetch failed: ${response.status}`);
        return;
      }

      const data = await response.json() as CoinGeckoPrice;
      for (const [id, priceData] of Object.entries(data)) {
        if (priceData?.usd) {
          this.priceCache.set(id, priceData.usd);
        }
      }

      this.logger.debug(`Fetched ${Object.keys(data).length} crypto prices`);
    } catch (err) {
      this.logger.warn(`CoinGecko price error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fetchStockPrices(): Promise<void> {
    if (this.config.stockSymbols.length === 0) return;

    for (const symbol of this.config.stockSymbols) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=5m`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'TradingBrain/1.0' },
        });

        if (!response.ok) {
          this.logger.debug(`Yahoo Finance ${symbol}: ${response.status}`);
          continue;
        }

        const data = await response.json() as YahooChartResult;
        const result = data?.chart?.result?.[0];
        const quotes = result?.indicators?.quote?.[0];
        const closes = quotes?.close;

        if (closes && closes.length > 0) {
          // Get last valid close
          for (let i = closes.length - 1; i >= 0; i--) {
            if (closes[i] != null) {
              this.priceCache.set(symbol, closes[i]!);
              break;
            }
          }
        }
      } catch (err) {
        this.logger.debug(`Yahoo ${symbol} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.debug(`Fetched stock prices for ${this.config.stockSymbols.length} symbols`);
  }

  private async fetchOHLCVData(): Promise<void> {
    // Crypto OHLCV from CoinGecko
    for (const id of this.config.cryptoIds) {
      try {
        const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`;
        const response = await fetch(url);

        if (!response.ok) continue;

        const data = await response.json() as number[][];
        if (!Array.isArray(data)) continue;

        const candles: OHLCVCandle[] = data.map(d => ({
          timestamp: d[0]!,
          open: d[1]!,
          high: d[2]!,
          low: d[3]!,
          close: d[4]!,
          volume: 0,
        }));

        if (candles.length > 0) {
          this.candleCache.set(id, this.mergeCandles(id, candles));
          this.repo.savePrices(id, candles);
        }
      } catch {
        // Skip silently
      }
    }

    // Stock OHLCV from Yahoo
    for (const symbol of this.config.stockSymbols) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=5m`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'TradingBrain/1.0' },
        });

        if (!response.ok) continue;

        const data = await response.json() as YahooChartResult;
        const result = data?.chart?.result?.[0];
        if (!result?.timestamp) continue;

        const quotes = result.indicators?.quote?.[0];
        if (!quotes) continue;

        const candles: OHLCVCandle[] = [];
        for (let i = 0; i < result.timestamp.length; i++) {
          const o = quotes.open?.[i];
          const h = quotes.high?.[i];
          const l = quotes.low?.[i];
          const c = quotes.close?.[i];
          const v = quotes.volume?.[i];
          if (o != null && h != null && l != null && c != null) {
            candles.push({
              timestamp: result.timestamp[i]! * 1000,
              open: o, high: h, low: l, close: c, volume: v ?? 0,
            });
          }
        }

        if (candles.length > 0) {
          this.candleCache.set(symbol, this.mergeCandles(symbol, candles));
          this.repo.savePrices(symbol, candles);
        }
      } catch {
        // Skip silently
      }
    }

    // Prune old cache
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    this.repo.pruneOldPrices(twoDaysAgo);

    this.logger.debug('OHLCV data refreshed');
  }

  private mergeCandles(symbol: string, newCandles: OHLCVCandle[]): OHLCVCandle[] {
    const existing = this.candleCache.get(symbol) ?? [];
    const lastTs = existing.length > 0 ? existing[existing.length - 1]!.timestamp : 0;
    const fresh = newCandles.filter(c => c.timestamp > lastTs);
    const merged = [...existing, ...fresh];
    // Keep last 500 candles
    return merged.slice(-500);
  }

  private loadCacheFromDb(): void {
    const allSymbols = this.getAllSymbols();
    for (const symbol of allSymbols) {
      const cached = this.repo.getRecentPrices(symbol, 500);
      if (cached.length > 0) {
        this.candleCache.set(symbol, cached);
        this.priceCache.set(symbol, cached[cached.length - 1]!.close);
      }
    }
  }
}
