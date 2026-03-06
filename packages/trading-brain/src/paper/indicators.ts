import type { OHLCVCandle, IndicatorResult } from './types.js';

/**
 * Wilder's smoothed RSI.
 */
export function calcRSI(candles: OHLCVCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 50;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder smoothing
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i]!.close - candles[i - 1]!.close;
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * MACD (12, 26, 9): line, signal, histogram.
 */
export function calcMACD(
  candles: OHLCVCandle[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): { line: number; signal: number; histogram: number } {
  if (candles.length < slowPeriod + signalPeriod) {
    return { line: 0, signal: 0, histogram: 0 };
  }

  const closes = candles.map(c => c.close);
  const emaFast = calcEMA(closes, fastPeriod);
  const emaSlow = calcEMA(closes, slowPeriod);

  const macdLine: number[] = [];
  const startIdx = slowPeriod - 1;
  for (let i = startIdx; i < closes.length; i++) {
    const fastIdx = i - (closes.length - emaFast.length);
    const slowIdx = i - (closes.length - emaSlow.length);
    if (fastIdx >= 0 && slowIdx >= 0) {
      macdLine.push(emaFast[fastIdx]! - emaSlow[slowIdx]!);
    }
  }

  if (macdLine.length < signalPeriod) {
    return { line: macdLine[macdLine.length - 1] ?? 0, signal: 0, histogram: 0 };
  }

  const signalLine = calcEMA(macdLine, signalPeriod);
  const line = macdLine[macdLine.length - 1]!;
  const signal = signalLine[signalLine.length - 1]!;

  return { line, signal, histogram: line - signal };
}

/**
 * Trend score: SMA(10) vs SMA(30) crossover.
 * Returns -5 to +5 range based on distance.
 */
export function calcTrendScore(candles: OHLCVCandle[]): number {
  if (candles.length < 30) return 0;

  const closes = candles.map(c => c.close);
  const sma10 = calcSMA(closes, 10);
  const sma30 = calcSMA(closes, 30);

  if (sma30 === 0) return 0;
  const diff = ((sma10 - sma30) / sma30) * 100;

  // Clamp to -5..+5
  return Math.max(-5, Math.min(5, diff));
}

/**
 * ATR-based volatility as percentage of close price.
 */
export function calcVolatility(candles: OHLCVCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 30;

  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close),
    );
    atrSum += tr;
  }

  const atr = atrSum / period;
  const lastClose = candles[candles.length - 1]!.close;
  if (lastClose === 0) return 30;

  return (atr / lastClose) * 100;
}

/**
 * Calculate all indicators for a set of candles.
 */
export function calcAllIndicators(candles: OHLCVCandle[]): IndicatorResult {
  return {
    rsi14: calcRSI(candles, 14),
    macd: calcMACD(candles),
    trendScore: calcTrendScore(candles),
    volatility: calcVolatility(candles),
  };
}

// ─── Helpers ────────────────────────────────────────────

function calcEMA(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  result.push(sum / period);

  for (let i = period; i < values.length; i++) {
    result.push(values[i]! * k + result[result.length - 1]! * (1 - k));
  }

  return result;
}

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return 0;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i]!;
  }
  return sum / period;
}
