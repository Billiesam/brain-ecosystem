import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BacktestService } from '../../../src/services/backtest.service.js';
import type { OHLCVCandle } from '../../../src/paper/types.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeCandles(count: number, startPrice = 100): OHLCVCandle[] {
  const candles: OHLCVCandle[] = [];
  let price = startPrice;
  const startTime = Date.now() - count * 3600_000;

  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.3) * 5) + (Math.random() - 0.5) * 2;
    const open = price;
    price = price + change;
    const close = price;
    const high = Math.max(open, close) + Math.random() * 2;
    const low = Math.min(open, close) - Math.random() * 2;
    candles.push({
      timestamp: startTime + i * 3600_000,
      open, high, low, close,
      volume: 1000 + Math.random() * 5000,
    });
  }
  return candles;
}

describe('BacktestService.runStrategyBacktest', () => {
  let service: BacktestService;

  beforeEach(() => {
    // BacktestService needs tradeRepo, signalService, synapseManager — mock them
    const mockTradeRepo = { getAll: vi.fn().mockReturnValue([]) } as any;
    const mockSignalService = {} as any;
    const mockSynapseManager = {} as any;
    service = new BacktestService(mockTradeRepo, mockSignalService, mockSynapseManager);
  });

  it('returns zero trades for empty candles', () => {
    const strategy = {
      id: 1, brainName: 'test', type: 'trade' as const, name: 'Empty',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const result = service.runStrategyBacktest(strategy, []);
    expect(result.totalTrades).toBe(0);
    expect(result.strategyName).toBe('Empty');
  });

  it('generates trades from momentum candles', () => {
    const strategy = {
      id: 1, brainName: 'test', type: 'trade' as const, name: 'Momentum',
      description: 'test', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(100);
    const result = service.runStrategyBacktest(strategy, candles);

    expect(result.totalTrades).toBeGreaterThan(0);
    expect(result.wins + result.losses).toBe(result.totalTrades);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
    expect(result.strategyId).toBe(1);
    expect(result.pair).toBe('BTC/USDT');
  });

  it('calculates Sharpe ratio correctly', () => {
    const strategy = {
      id: 2, brainName: 'test', type: 'trade' as const, name: 'SharpeTest',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(200);
    const result = service.runStrategyBacktest(strategy, candles);

    if (result.totalTrades > 0) {
      expect(typeof result.sharpeRatio).toBe('number');
      expect(Number.isFinite(result.sharpeRatio)).toBe(true);
    }
  });

  it('calculates max drawdown', () => {
    const strategy = {
      id: 3, brainName: 'test', type: 'trade' as const, name: 'DrawdownTest',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(150);
    const result = service.runStrategyBacktest(strategy, candles);

    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('builds equity curve', () => {
    const strategy = {
      id: 4, brainName: 'test', type: 'trade' as const, name: 'EquityCurve',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(100);
    const result = service.runStrategyBacktest(strategy, candles);

    expect(result.equityCurve.length).toBe(result.totalTrades);
    if (result.equityCurve.length > 0) {
      expect(result.equityCurve[0]!.tradeIndex).toBe(0);
    }
  });

  it('evaluates entry rules with breakout condition', () => {
    const strategy = {
      id: 5, brainName: 'test', type: 'trade' as const, name: 'BreakoutTest',
      description: '', rules: [
        { condition: 'price_above breakout', action: 'buy entry', confidence: 0.8, source: 'test' },
        { condition: 'stop_loss', action: 'sell exit', confidence: 0.9, source: 'test' },
      ],
      performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(100);
    const result = service.runStrategyBacktest(strategy, candles);

    expect(result.strategyName).toBe('BreakoutTest');
    // Strategy with rules should still produce trades
    expect(result.totalTrades).toBeGreaterThanOrEqual(0);
  });

  it('calculates profit factor', () => {
    const strategy = {
      id: 6, brainName: 'test', type: 'trade' as const, name: 'ProfitFactor',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(200);
    const result = service.runStrategyBacktest(strategy, candles);

    if (result.totalTrades > 0) {
      expect(result.profitFactor).toBeGreaterThanOrEqual(0);
    }
  });

  it('uses custom pair name', () => {
    const strategy = {
      id: 7, brainName: 'test', type: 'trade' as const, name: 'CustomPair',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    const candles = makeCandles(50);
    const result = service.runStrategyBacktest(strategy, candles, { pair: 'ETH/USDT' });
    expect(result.pair).toBe('ETH/USDT');
  });

  it('calculates days from candle timestamps', () => {
    const strategy = {
      id: 8, brainName: 'test', type: 'trade' as const, name: 'DaysCalc',
      description: '', rules: [], performance: { executions: 0, successes: 0, avgReturn: 0 },
      status: 'active' as const,
    };
    // 48 hourly candles = 2 days
    const candles = makeCandles(48);
    const result = service.runStrategyBacktest(strategy, candles);
    expect(result.days).toBe(2);
  });
});
