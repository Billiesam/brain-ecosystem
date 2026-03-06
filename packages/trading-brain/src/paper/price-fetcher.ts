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

  // Rate limiting
  private consecutiveErrors = 0;
  private readonly MAX_CONSECUTIVE_ERRORS = 5;
  private backoffMs = 0;

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
    if (this.backoffMs > 0) await this.delay(this.backoffMs);

    try {
      const ids = this.config.cryptoIds.join(',');
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
      const response = await fetch(url);

      if (!response.ok) {
        this.recordError();
        this.logger.warn(`CoinGecko price fetch failed: ${response.status}`);
        return;
      }

      const data = await response.json() as CoinGeckoPrice;
      for (const [id, priceData] of Object.entries(data)) {
        if (priceData?.usd) {
          this.priceCache.set(id, priceData.usd);
        }
      }

      this.recordSuccess();
      this.logger.debug(`Fetched ${Object.keys(data).length} crypto prices`);
    } catch (err) {
      this.recordError();
      this.logger.warn(`CoinGecko price error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async fetchStockPrices(): Promise<void> {
    if (this.config.stockSymbols.length === 0) return;
    if (this.backoffMs > 0) await this.delay(this.backoffMs);

    for (const symbol of this.config.stockSymbols) {
      try {
        // Rate limit: 500ms between Yahoo calls
        await this.delay(500);

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=5m`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'TradingBrain/1.0' },
        });

        if (!response.ok) {
          this.recordError();
          this.logger.warn(`Yahoo Finance ${symbol}: ${response.status}`);
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

        this.recordSuccess();
      } catch (err) {
        this.recordError();
        this.logger.warn(`Yahoo ${symbol} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.debug(`Fetched stock prices for ${this.config.stockSymbols.length} symbols`);
  }

  private async fetchOHLCVData(): Promise<void> {
    if (this.backoffMs > 0) await this.delay(this.backoffMs);

    // Crypto OHLCV from CoinGecko
    for (const id of this.config.cryptoIds) {
      try {
        // Rate limit: 1.5s between CoinGecko OHLCV calls
        await this.delay(1500);

        const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=1`;
        const response = await fetch(url);

        if (!response.ok) {
          this.recordError();
          this.logger.warn(`CoinGecko OHLCV ${id}: ${response.status}`);
          continue;
        }

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

        this.recordSuccess();
      } catch (err) {
        this.recordError();
        this.logger.warn(`CoinGecko OHLCV ${id} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Stock OHLCV from Yahoo
    for (const symbol of this.config.stockSymbols) {
      try {
        // Rate limit: 500ms between Yahoo calls
        await this.delay(500);

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=5m`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'TradingBrain/1.0' },
        });

        if (!response.ok) {
          this.recordError();
          this.logger.warn(`Yahoo OHLCV ${symbol}: ${response.status}`);
          continue;
        }

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

        this.recordSuccess();
      } catch (err) {
        this.recordError();
        this.logger.warn(`Yahoo OHLCV ${symbol} error: ${err instanceof Error ? err.message : String(err)}`);
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private recordError(): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
      this.backoffMs = Math.min(30_000, 2_000 * Math.pow(2, this.consecutiveErrors - this.MAX_CONSECUTIVE_ERRORS));
      this.logger.warn(`API rate limit backoff: ${this.backoffMs}ms after ${this.consecutiveErrors} consecutive errors`);
    }
  }

  private recordSuccess(): void {
    this.consecutiveErrors = 0;
    this.backoffMs = 0;
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
