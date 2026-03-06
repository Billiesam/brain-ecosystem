import { describe, it, expect, vi } from 'vitest';
import { DecisionEngine } from '../decision-engine.js';
import type { PaperConfig, PaperPosition, IndicatorResult } from '../types.js';

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
  cryptoIds: [],
  stockSymbols: [],
};

function createMockSignalService() {
  return {
    getConfidence: vi.fn().mockReturnValue(0),
    getSignalWeights: vi.fn().mockReturnValue({ rsi: 0.5, macd: 0.5 }),
  };
}

describe('DecisionEngine', () => {
  describe('Cold-Start Confidence', () => {
    it('should use 0.3 threshold when confidence is 0 (cold start)', () => {
      const signalService = createMockSignalService();
      signalService.getConfidence.mockReturnValue(0); // Cold start: no data

      const engine = new DecisionEngine(mockConfig, signalService as any);

      // With strong bullish divergence (RSI < 30 && MACD > 0), should still enter
      const indicators: IndicatorResult = {
        rsi14: 25, // Low RSI
        macd: { line: 0.5, signal: 0.3, histogram: 0.2 }, // Positive MACD
        trendScore: 1,
        volatility: 40,
      };

      const prices = new Map([['bitcoin', 50000]]);
      const indicatorMap = new Map([['bitcoin', indicators]]);

      const entries = engine.checkEntries(['bitcoin'], prices, indicatorMap, new Set());

      // Should find an entry because bullish divergence bypasses confidence threshold
      expect(entries.length).toBe(1);
    });

    it('should not enter in cold start without strong technical signal', () => {
      const signalService = createMockSignalService();
      signalService.getConfidence.mockReturnValue(0);

      const engine = new DecisionEngine(mockConfig, signalService as any);

      // Weak signals: RSI in neutral zone, no strong trend
      const indicators: IndicatorResult = {
        rsi14: 50,
        macd: { line: -0.1, signal: -0.2, histogram: 0.1 },
        trendScore: 0.5,
        volatility: 45,
      };

      const prices = new Map([['bitcoin', 50000]]);
      const indicatorMap = new Map([['bitcoin', indicators]]);

      const entries = engine.checkEntries(['bitcoin'], prices, indicatorMap, new Set());

      // Should NOT enter: no strong technical signal and confidence is 0
      expect(entries.length).toBe(0);
    });
  });

  describe('Exit conditions', () => {
    it('should trigger stop loss at -2.5%', () => {
      const signalService = createMockSignalService();
      const engine = new DecisionEngine(mockConfig, signalService as any);

      const position: PaperPosition = {
        id: 1,
        symbol: 'bitcoin',
        side: 'long',
        entryPrice: 50000,
        quantity: 0.01,
        usdtAmount: 500,
        currentPrice: 48700,
        pnlPct: -2.6,
        highWaterMark: 50000,
        signalsJson: '{}',
        fingerprint: 'abc',
        confidence: 0.7,
        regime: 'bullish_trend',
        openedAt: new Date().toISOString(),
      };

      const prices = new Map([['bitcoin', 48700]]);
      const exits = engine.checkExits([position], prices);

      expect(exits.length).toBe(1);
      expect(exits[0]!.reason).toBe('stop_loss');
    });

    it('should trigger time exit after 24 hours', () => {
      const signalService = createMockSignalService();
      const engine = new DecisionEngine(mockConfig, signalService as any);

      const oldDate = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); // 25 hours ago

      const position: PaperPosition = {
        id: 1,
        symbol: 'bitcoin',
        side: 'long',
        entryPrice: 50000,
        quantity: 0.01,
        usdtAmount: 500,
        currentPrice: 50100,
        pnlPct: 0.2,
        highWaterMark: 50100,
        signalsJson: '{}',
        fingerprint: 'abc',
        confidence: 0.7,
        regime: 'bullish_trend',
        openedAt: oldDate,
      };

      const prices = new Map([['bitcoin', 50100]]);
      const exits = engine.checkExits([position], prices);

      expect(exits.length).toBe(1);
      expect(exits[0]!.reason).toBe('time_exit');
    });
  });

  describe('Regime detection', () => {
    it('should detect bullish trend', () => {
      const signalService = createMockSignalService();
      const engine = new DecisionEngine(mockConfig, signalService as any);

      expect(engine.detectRegime({ rsi14: 60, macd: { line: 1, signal: 0.5, histogram: 0.5 }, trendScore: 3, volatility: 30 })).toBe('bullish_trend');
    });

    it('should detect bearish trend', () => {
      const signalService = createMockSignalService();
      const engine = new DecisionEngine(mockConfig, signalService as any);

      expect(engine.detectRegime({ rsi14: 30, macd: { line: -1, signal: -0.5, histogram: -0.5 }, trendScore: -3, volatility: 30 })).toBe('bearish_trend');
    });

    it('should detect volatile market', () => {
      const signalService = createMockSignalService();
      const engine = new DecisionEngine(mockConfig, signalService as any);

      expect(engine.detectRegime({ rsi14: 50, macd: { line: 0, signal: 0, histogram: 0 }, trendScore: 0, volatility: 70 })).toBe('volatile');
    });
  });
});
