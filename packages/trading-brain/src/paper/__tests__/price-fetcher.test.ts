import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PriceFetcher } from '../price-fetcher.js';
import type { PaperConfig } from '../types.js';

const mockConfig: PaperConfig = {
  enabled: true,
  intervalMs: 300_000,
  startingBalance: 10_000,
  maxPositionPct: 5,
  maxPositions: 10,
  stopLossPct: -2.5,
  takeProfitPct: 4,
  trailingStopActivation: 3,
  trailingStopDistance: 1.5,
  confidenceThreshold: 0.60,
  scoreThreshold: 80,
  timeExitHours: 24,
  cryptoIds: ['bitcoin'],
  stockSymbols: ['AAPL'],
};

function createMockRepo() {
  return {
    getRecentPrices: vi.fn().mockReturnValue([]),
    savePrices: vi.fn(),
    pruneOldPrices: vi.fn(),
  };
}

describe('PriceFetcher', () => {
  describe('Rate limiting', () => {
    it('should have rate limiting properties initialized', () => {
      const repo = createMockRepo();
      const fetcher = new PriceFetcher(mockConfig, repo as any);

      // Verify internal state
      expect((fetcher as any).consecutiveErrors).toBe(0);
      expect((fetcher as any).backoffMs).toBe(0);
      expect((fetcher as any).MAX_CONSECUTIVE_ERRORS).toBe(5);
    });

    it('should track consecutive errors and compute backoff', () => {
      const repo = createMockRepo();
      const fetcher = new PriceFetcher(mockConfig, repo as any);

      // Simulate errors
      for (let i = 0; i < 5; i++) {
        (fetcher as any).recordError();
      }

      expect((fetcher as any).consecutiveErrors).toBe(5);
      expect((fetcher as any).backoffMs).toBeGreaterThan(0);
    });

    it('should reset error tracking on success', () => {
      const repo = createMockRepo();
      const fetcher = new PriceFetcher(mockConfig, repo as any);

      // Simulate errors then success
      for (let i = 0; i < 5; i++) {
        (fetcher as any).recordError();
      }
      expect((fetcher as any).consecutiveErrors).toBe(5);

      (fetcher as any).recordSuccess();
      expect((fetcher as any).consecutiveErrors).toBe(0);
      expect((fetcher as any).backoffMs).toBe(0);
    });

    it('should cap backoff at 30 seconds', () => {
      const repo = createMockRepo();
      const fetcher = new PriceFetcher(mockConfig, repo as any);

      // Simulate many errors
      for (let i = 0; i < 20; i++) {
        (fetcher as any).recordError();
      }

      expect((fetcher as any).backoffMs).toBeLessThanOrEqual(30_000);
    });
  });

  describe('Cache', () => {
    it('should load candle cache from database on construction', () => {
      const repo = createMockRepo();
      repo.getRecentPrices.mockReturnValue([
        { timestamp: 1000, open: 50000, high: 51000, low: 49000, close: 50500, volume: 100 },
      ]);

      const fetcher = new PriceFetcher(mockConfig, repo as any);

      expect(repo.getRecentPrices).toHaveBeenCalled();
      expect(fetcher.getCandles('bitcoin').length).toBe(1);
      expect(fetcher.getPrice('bitcoin')).toBe(50500);
    });

    it('should return all configured symbols', () => {
      const repo = createMockRepo();
      const fetcher = new PriceFetcher(mockConfig, repo as any);

      const symbols = fetcher.getAllSymbols();
      expect(symbols).toContain('bitcoin');
      expect(symbols).toContain('AAPL');
    });
  });
});
