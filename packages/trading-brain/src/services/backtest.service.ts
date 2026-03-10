import type { TradeRepository, TradeRecord } from '../db/repositories/trade.repository.js';
import type { SignalService } from './signal.service.js';
import type { SynapseManager } from '../synapses/synapse-manager.js';
import { fingerprintSimilarity } from '../signals/fingerprint.js';
import { getLogger } from '../utils/logger.js';
import type { OHLCVCandle } from '../paper/types.js';
import type { ForgeStrategy, StrategyRule, StrategyForge } from '@timmeck/brain-core';

export interface BacktestOptions {
  pair?: string;
  regime?: string;
  timeframe?: string;
  botType?: string;
  fromDate?: string;
  toDate?: string;
  signalFilter?: string;
}

export interface PairRegimeStats {
  wins: number;
  losses: number;
  profitPct: number;
}

export interface EquityPoint {
  tradeIndex: number;
  cumulativePct: number;
}

export interface BacktestResult {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalProfitPct: number;
  avgProfitPct: number;
  avgWinPct: number;
  avgLossPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  sharpeRatio: number;
  bestTrade: number;
  worstTrade: number;
  tradesByPair: Map<string, PairRegimeStats>;
  tradesByRegime: Map<string, PairRegimeStats>;
  equityCurve: EquityPoint[];
}

export interface SignalComparison {
  fingerprint1: string;
  fingerprint2: string;
  stats1: { wins: number; losses: number; winRate: number; avgProfitPct: number; sampleSize: number };
  stats2: { wins: number; losses: number; winRate: number; avgProfitPct: number; sampleSize: number };
  similarity: number;
  verdict: string;
}

export interface StrategyBacktestOptions {
  strategyId: number;
  pair?: string;
  days?: number;
  initialCapital?: number;
}

export interface StrategyBacktestResult {
  strategyId: number;
  strategyName: string;
  pair: string;
  days: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  profitFactor: number;
  avgReturnPct: number;
  equityCurve: EquityPoint[];
}

export interface RankedSignal {
  fingerprint: string;
  wins: number;
  losses: number;
  winRate: number;
  avgProfitPct: number;
  sampleSize: number;
  synapseWeight: number | null;
}

export class BacktestService {
  private logger = getLogger();

  constructor(
    private tradeRepo: TradeRepository,
    private signalService: SignalService,
    private synapseManager: SynapseManager,
  ) {}

  /**
   * Run a backtest on existing historical trades in the DB.
   * Filters trades by the given options and computes performance statistics.
   */
  runBacktest(options: BacktestOptions = {}): BacktestResult {
    const trades = this.filterTrades(options);

    this.logger.info(`Backtest: ${trades.length} trades matched filters`);

    if (trades.length === 0) {
      return this.emptyResult();
    }

    // Sort by created_at ascending for equity curve
    trades.sort((a, b) => a.created_at.localeCompare(b.created_at));

    const wins = trades.filter(t => t.win === 1);
    const losses = trades.filter(t => t.win === 0);

    const totalProfitPct = trades.reduce((sum, t) => sum + t.profit_pct, 0);
    const winProfits = wins.map(t => t.profit_pct);
    const lossProfits = losses.map(t => t.profit_pct);

    const avgWinPct = winProfits.length > 0
      ? winProfits.reduce((s, v) => s + v, 0) / winProfits.length
      : 0;
    const avgLossPct = lossProfits.length > 0
      ? lossProfits.reduce((s, v) => s + v, 0) / lossProfits.length
      : 0;

    const grossWins = winProfits.reduce((s, v) => s + v, 0);
    const grossLosses = Math.abs(lossProfits.reduce((s, v) => s + v, 0));

    // Equity curve + max drawdown
    const equityCurve: EquityPoint[] = [];
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (let i = 0; i < trades.length; i++) {
      cumulative += trades[i]!.profit_pct;
      equityCurve.push({ tradeIndex: i, cumulativePct: cumulative });

      if (cumulative > peak) peak = cumulative;
      const drawdown = peak - cumulative;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Sharpe ratio (simplified: mean return / stddev of returns)
    const returns = trades.map(t => t.profit_pct);
    const meanReturn = totalProfitPct / trades.length;
    const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
    const stddev = Math.sqrt(variance);
    const sharpeRatio = stddev > 0 ? meanReturn / stddev : 0;

    // Best / worst trade
    const profitValues = trades.map(t => t.profit_pct);
    const bestTrade = Math.max(...profitValues);
    const worstTrade = Math.min(...profitValues);

    // Trades by pair
    const tradesByPair = new Map<string, PairRegimeStats>();
    for (const t of trades) {
      const key = t.pair;
      const entry = tradesByPair.get(key) ?? { wins: 0, losses: 0, profitPct: 0 };
      if (t.win === 1) entry.wins++;
      else entry.losses++;
      entry.profitPct += t.profit_pct;
      tradesByPair.set(key, entry);
    }

    // Trades by regime
    const tradesByRegime = new Map<string, PairRegimeStats>();
    for (const t of trades) {
      const key = t.regime ?? 'unknown';
      const entry = tradesByRegime.get(key) ?? { wins: 0, losses: 0, profitPct: 0 };
      if (t.win === 1) entry.wins++;
      else entry.losses++;
      entry.profitPct += t.profit_pct;
      tradesByRegime.set(key, entry);
    }

    const result: BacktestResult = {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: wins.length / trades.length,
      totalProfitPct,
      avgProfitPct: totalProfitPct / trades.length,
      avgWinPct,
      avgLossPct,
      maxDrawdownPct: maxDrawdown,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      sharpeRatio,
      bestTrade,
      worstTrade,
      tradesByPair,
      tradesByRegime,
      equityCurve,
    };

    this.logger.info(
      `Backtest complete: ${result.totalTrades} trades | WR: ${(result.winRate * 100).toFixed(1)}% | ` +
      `PF: ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)} | ` +
      `Sharpe: ${result.sharpeRatio.toFixed(2)} | MaxDD: ${result.maxDrawdownPct.toFixed(2)}%`,
    );

    return result;
  }

  /**
   * Compare two signal fingerprint patterns head-to-head.
   */
  compareSignals(fingerprint1: string, fingerprint2: string): SignalComparison {
    const trades1 = this.tradeRepo.getByFingerprint(fingerprint1);
    const trades2 = this.tradeRepo.getByFingerprint(fingerprint2);

    const stats1 = this.computeSignalStats(trades1);
    const stats2 = this.computeSignalStats(trades2);

    const similarity = fingerprintSimilarity(fingerprint1, fingerprint2);

    let verdict: string;
    if (stats1.sampleSize < 5 || stats2.sampleSize < 5) {
      verdict = 'insufficient data — need at least 5 trades per signal for a meaningful comparison';
    } else if (stats1.winRate > stats2.winRate + 0.1 && stats1.avgProfitPct > stats2.avgProfitPct) {
      verdict = `${fingerprint1} outperforms (higher win rate and avg profit)`;
    } else if (stats2.winRate > stats1.winRate + 0.1 && stats2.avgProfitPct > stats1.avgProfitPct) {
      verdict = `${fingerprint2} outperforms (higher win rate and avg profit)`;
    } else if (stats1.avgProfitPct > stats2.avgProfitPct) {
      verdict = `${fingerprint1} has better average profit, but win rates are close`;
    } else if (stats2.avgProfitPct > stats1.avgProfitPct) {
      verdict = `${fingerprint2} has better average profit, but win rates are close`;
    } else {
      verdict = 'signals perform similarly — no clear winner';
    }

    this.logger.info(`Signal comparison: ${fingerprint1} vs ${fingerprint2} → ${verdict}`);

    return { fingerprint1, fingerprint2, stats1, stats2, similarity, verdict };
  }

  /**
   * Find top N signal patterns by win rate, requiring a minimum sample size.
   */
  findBestSignals(options: { minSampleSize?: number; topN?: number; pair?: string; regime?: string } = {}): RankedSignal[] {
    const { minSampleSize = 5, topN = 20, pair, regime } = options;

    // Group all trades by fingerprint
    let trades = this.tradeRepo.getAll();
    if (pair) trades = trades.filter(t => t.pair === pair);
    if (regime) trades = trades.filter(t => t.regime === regime);

    const grouped = new Map<string, TradeRecord[]>();
    for (const t of trades) {
      const arr = grouped.get(t.fingerprint) ?? [];
      arr.push(t);
      grouped.set(t.fingerprint, arr);
    }

    const ranked: RankedSignal[] = [];
    for (const [fp, fpTrades] of grouped) {
      if (fpTrades.length < minSampleSize) continue;

      const stats = this.computeSignalStats(fpTrades);
      const synapse = this.synapseManager.getByFingerprint(fp);

      ranked.push({
        fingerprint: fp,
        wins: stats.wins,
        losses: stats.losses,
        winRate: stats.winRate,
        avgProfitPct: stats.avgProfitPct,
        sampleSize: stats.sampleSize,
        synapseWeight: synapse?.weight ?? null,
      });
    }

    ranked.sort((a, b) => {
      // Primary: win rate, secondary: avg profit
      if (Math.abs(a.winRate - b.winRate) > 0.01) return b.winRate - a.winRate;
      return b.avgProfitPct - a.avgProfitPct;
    });

    const result = ranked.slice(0, topN);

    this.logger.info(`findBestSignals: ${result.length} signals found (min sample: ${minSampleSize})`);

    return result;
  }

  private filterTrades(options: BacktestOptions): TradeRecord[] {
    let trades = this.tradeRepo.getAll();

    if (options.pair) {
      trades = trades.filter(t => t.pair === options.pair);
    }
    if (options.regime) {
      trades = trades.filter(t => t.regime === options.regime);
    }
    if (options.botType) {
      trades = trades.filter(t => t.bot_type === options.botType);
    }
    if (options.fromDate) {
      trades = trades.filter(t => t.created_at >= options.fromDate!);
    }
    if (options.toDate) {
      trades = trades.filter(t => t.created_at <= options.toDate!);
    }
    if (options.signalFilter) {
      trades = trades.filter(t => {
        const sim = fingerprintSimilarity(t.fingerprint, options.signalFilter!);
        return sim >= 0.5;
      });
    }

    return trades;
  }

  private computeSignalStats(trades: TradeRecord[]): {
    wins: number;
    losses: number;
    winRate: number;
    avgProfitPct: number;
    sampleSize: number;
  } {
    const wins = trades.filter(t => t.win === 1).length;
    const losses = trades.filter(t => t.win === 0).length;
    const total = trades.length;
    const totalProfit = trades.reduce((s, t) => s + t.profit_pct, 0);

    return {
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      avgProfitPct: total > 0 ? totalProfit / total : 0,
      sampleSize: total,
    };
  }

  /**
   * Run a strategy backtest on historical OHLCV candle data.
   * Evaluates strategy rules against each candle to simulate trades.
   */
  runStrategyBacktest(
    strategy: ForgeStrategy,
    candles: OHLCVCandle[],
    options: { pair?: string; initialCapital?: number } = {},
  ): StrategyBacktestResult {
    const pair = options.pair ?? 'BTC/USDT';
    const initialCapital = options.initialCapital ?? 10_000;

    if (candles.length === 0) {
      return {
        strategyId: strategy.id, strategyName: strategy.name, pair,
        days: 0, totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        totalReturnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0,
        profitFactor: 0, avgReturnPct: 0, equityCurve: [],
      };
    }

    const trades: Array<{ returnPct: number; win: boolean }> = [];
    let position: { entryPrice: number; entryIndex: number } | null = null;

    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1]!;
      const curr = candles[i]!;

      if (!position) {
        // Evaluate entry rules
        if (this.evaluateRules(strategy.rules, 'entry', prev, curr)) {
          position = { entryPrice: curr.close, entryIndex: i };
        }
      } else {
        // Evaluate exit rules or simple take-profit/stop-loss
        const returnPct = ((curr.close - position.entryPrice) / position.entryPrice) * 100;
        const holdBars = i - position.entryIndex;

        if (this.evaluateRules(strategy.rules, 'exit', prev, curr) || holdBars >= 24 || returnPct > 5 || returnPct < -3) {
          trades.push({ returnPct, win: returnPct > 0 });
          position = null;
        }
      }
    }

    // Close any open position at end
    if (position && candles.length > 0) {
      const lastClose = candles[candles.length - 1]!.close;
      const returnPct = ((lastClose - position.entryPrice) / position.entryPrice) * 100;
      trades.push({ returnPct, win: returnPct > 0 });
    }

    if (trades.length === 0) {
      return {
        strategyId: strategy.id, strategyName: strategy.name, pair,
        days: Math.round((candles[candles.length - 1]!.timestamp - candles[0]!.timestamp) / 86_400_000),
        totalTrades: 0, wins: 0, losses: 0, winRate: 0,
        totalReturnPct: 0, sharpeRatio: 0, maxDrawdownPct: 0,
        profitFactor: 0, avgReturnPct: 0, equityCurve: [],
      };
    }

    const wins = trades.filter(t => t.win).length;
    const losses = trades.length - wins;
    const returns = trades.map(t => t.returnPct);
    const totalReturnPct = returns.reduce((s, r) => s + r, 0);
    const avgReturnPct = totalReturnPct / trades.length;

    // Equity curve + max drawdown
    const equityCurve: EquityPoint[] = [];
    let cum = 0; let peak = 0; let maxDD = 0;
    for (let i = 0; i < trades.length; i++) {
      cum += trades[i]!.returnPct;
      equityCurve.push({ tradeIndex: i, cumulativePct: cum });
      if (cum > peak) peak = cum;
      const dd = peak - cum;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe ratio
    const variance = returns.reduce((s, r) => s + (r - avgReturnPct) ** 2, 0) / returns.length;
    const stddev = Math.sqrt(variance);
    const sharpeRatio = stddev > 0 ? avgReturnPct / stddev : 0;

    // Profit factor
    const grossWins = returns.filter(r => r > 0).reduce((s, r) => s + r, 0);
    const grossLosses = Math.abs(returns.filter(r => r < 0).reduce((s, r) => s + r, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    const days = Math.round((candles[candles.length - 1]!.timestamp - candles[0]!.timestamp) / 86_400_000);

    return {
      strategyId: strategy.id, strategyName: strategy.name, pair, days,
      totalTrades: trades.length, wins, losses,
      winRate: wins / trades.length,
      totalReturnPct, sharpeRatio, maxDrawdownPct: maxDD,
      profitFactor, avgReturnPct, equityCurve,
    };
  }

  /** Evaluate strategy rules for entry/exit signals based on candle data. */
  private evaluateRules(rules: StrategyRule[], type: 'entry' | 'exit', prev: OHLCVCandle, curr: OHLCVCandle): boolean {
    const relevant = rules.filter(r => {
      const action = r.action.toLowerCase();
      if (type === 'entry') return action.includes('buy') || action.includes('enter') || action.includes('long');
      return action.includes('sell') || action.includes('exit') || action.includes('close');
    });

    if (relevant.length === 0) {
      // Fallback: simple momentum entry, time-based exit
      if (type === 'entry') return curr.close > prev.close && curr.volume > prev.volume;
      return false;
    }

    // Evaluate conditions against price data
    for (const rule of relevant) {
      const cond = rule.condition.toLowerCase();
      let matches = false;

      if (cond.includes('price_above') || cond.includes('breakout')) {
        matches = curr.close > prev.high;
      } else if (cond.includes('price_below') || cond.includes('breakdown')) {
        matches = curr.close < prev.low;
      } else if (cond.includes('volume') && cond.includes('increase')) {
        matches = curr.volume > prev.volume * 1.5;
      } else if (cond.includes('momentum') || cond.includes('trend')) {
        matches = curr.close > prev.close;
      } else {
        // Default: use confidence as probability
        matches = Math.random() < rule.confidence;
      }

      if (matches) return true;
    }

    return false;
  }

  private emptyResult(): BacktestResult {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalProfitPct: 0,
      avgProfitPct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      maxDrawdownPct: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      bestTrade: 0,
      worstTrade: 0,
      tradesByPair: new Map(),
      tradesByRegime: new Map(),
      equityCurve: [],
    };
  }
}
