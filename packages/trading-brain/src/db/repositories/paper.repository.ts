import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import type { PaperPosition, PaperClosedTrade, OHLCVCandle } from '../../paper/types.js';

interface BalanceRow {
  id: number;
  balance: number;
  equity: number;
  event: string;
  created_at: string;
}

interface PositionRow {
  id: number;
  symbol: string;
  side: string;
  entry_price: number;
  quantity: number;
  usdt_amount: number;
  current_price: number;
  pnl_pct: number;
  high_water_mark: number;
  signals_json: string | null;
  fingerprint: string | null;
  confidence: number;
  regime: string | null;
  opened_at: string;
}

interface TradeRow {
  id: number;
  symbol: string;
  side: string;
  entry_price: number;
  exit_price: number;
  quantity: number;
  usdt_amount: number;
  pnl_usdt: number;
  pnl_pct: number;
  exit_reason: string;
  signals_json: string | null;
  fingerprint: string | null;
  confidence: number;
  regime: string | null;
  opened_at: string;
  closed_at: string;
}

export class PaperRepository {
  private stmts: Record<string, Statement>;

  constructor(private db: Database.Database) {
    this.stmts = {
      // Balance
      getBalance: db.prepare('SELECT * FROM paper_balance ORDER BY id DESC LIMIT 1'),
      updateBalance: db.prepare('INSERT INTO paper_balance (balance, equity, event) VALUES (?, ?, ?)'),
      getBalanceHistory: db.prepare('SELECT * FROM paper_balance ORDER BY id DESC LIMIT ?'),

      // Positions
      createPosition: db.prepare(`
        INSERT INTO paper_positions (symbol, side, entry_price, quantity, usdt_amount, current_price, high_water_mark, signals_json, fingerprint, confidence, regime)
        VALUES (@symbol, @side, @entry_price, @quantity, @usdt_amount, @current_price, @high_water_mark, @signals_json, @fingerprint, @confidence, @regime)
      `),
      getOpenPositions: db.prepare('SELECT * FROM paper_positions ORDER BY opened_at DESC'),
      getPositionBySymbol: db.prepare('SELECT * FROM paper_positions WHERE symbol = ?'),
      updatePositionPrice: db.prepare('UPDATE paper_positions SET current_price = ?, pnl_pct = ?, high_water_mark = ? WHERE id = ?'),
      deletePosition: db.prepare('DELETE FROM paper_positions WHERE id = ?'),
      countPositions: db.prepare('SELECT COUNT(*) as count FROM paper_positions'),

      // Trades
      createTrade: db.prepare(`
        INSERT INTO paper_trades (symbol, side, entry_price, exit_price, quantity, usdt_amount, pnl_usdt, pnl_pct, exit_reason, signals_json, fingerprint, confidence, regime, opened_at)
        VALUES (@symbol, @side, @entry_price, @exit_price, @quantity, @usdt_amount, @pnl_usdt, @pnl_pct, @exit_reason, @signals_json, @fingerprint, @confidence, @regime, @opened_at)
      `),
      getRecentTrades: db.prepare('SELECT * FROM paper_trades ORDER BY closed_at DESC LIMIT ?'),
      countTrades: db.prepare('SELECT COUNT(*) as count FROM paper_trades'),
      getWinRate: db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins FROM paper_trades'),
      getTotalPnl: db.prepare('SELECT COALESCE(SUM(pnl_usdt), 0) as total FROM paper_trades'),

      // Price Cache
      savePrice: db.prepare(`
        INSERT INTO paper_price_cache (symbol, timestamp, open, high, low, close, volume)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      getPrices: db.prepare('SELECT * FROM paper_price_cache WHERE symbol = ? ORDER BY timestamp ASC'),
      getRecentPrices: db.prepare('SELECT * FROM paper_price_cache WHERE symbol = ? ORDER BY timestamp DESC LIMIT ?'),
      pruneOldPrices: db.prepare("DELETE FROM paper_price_cache WHERE timestamp < ?"),
      countPrices: db.prepare('SELECT COUNT(*) as count FROM paper_price_cache WHERE symbol = ?'),

      // Reset
      resetAll: db.prepare('DELETE FROM paper_positions'),
      resetTrades: db.prepare('DELETE FROM paper_trades'),
      resetBalance: db.prepare('DELETE FROM paper_balance'),
      resetPrices: db.prepare('DELETE FROM paper_price_cache'),
    };
  }

  // ─── Balance ────────────────────────────────────────────

  getBalance(): { balance: number; equity: number } {
    const row = this.stmts['getBalance']!.get() as BalanceRow | undefined;
    return { balance: row?.balance ?? 10000, equity: row?.equity ?? 10000 };
  }

  updateBalance(balance: number, equity: number, event: string): void {
    this.stmts['updateBalance']!.run(balance, equity, event);
  }

  getBalanceHistory(limit: number = 50): BalanceRow[] {
    return this.stmts['getBalanceHistory']!.all(limit) as BalanceRow[];
  }

  // ─── Positions ──────────────────────────────────────────

  createPosition(pos: PaperPosition): number {
    const result = this.stmts['createPosition']!.run({
      symbol: pos.symbol,
      side: pos.side,
      entry_price: pos.entryPrice,
      quantity: pos.quantity,
      usdt_amount: pos.usdtAmount,
      current_price: pos.currentPrice,
      high_water_mark: pos.highWaterMark,
      signals_json: pos.signalsJson,
      fingerprint: pos.fingerprint,
      confidence: pos.confidence,
      regime: pos.regime,
    });
    return result.lastInsertRowid as number;
  }

  getOpenPositions(): PaperPosition[] {
    const rows = this.stmts['getOpenPositions']!.all() as PositionRow[];
    return rows.map(r => this.rowToPosition(r));
  }

  getPositionBySymbol(symbol: string): PaperPosition | undefined {
    const row = this.stmts['getPositionBySymbol']!.get(symbol) as PositionRow | undefined;
    return row ? this.rowToPosition(row) : undefined;
  }

  updatePositionPrice(id: number, currentPrice: number, pnlPct: number, highWaterMark: number): void {
    this.stmts['updatePositionPrice']!.run(currentPrice, pnlPct, highWaterMark, id);
  }

  deletePosition(id: number): void {
    this.stmts['deletePosition']!.run(id);
  }

  countPositions(): number {
    return (this.stmts['countPositions']!.get() as { count: number }).count;
  }

  // ─── Trades ─────────────────────────────────────────────

  createTrade(trade: PaperClosedTrade): number {
    const result = this.stmts['createTrade']!.run({
      symbol: trade.symbol,
      side: trade.side,
      entry_price: trade.entryPrice,
      exit_price: trade.exitPrice,
      quantity: trade.quantity,
      usdt_amount: trade.usdtAmount,
      pnl_usdt: trade.pnlUsdt,
      pnl_pct: trade.pnlPct,
      exit_reason: trade.exitReason,
      signals_json: trade.signalsJson,
      fingerprint: trade.fingerprint,
      confidence: trade.confidence,
      regime: trade.regime,
      opened_at: trade.openedAt,
    });
    return result.lastInsertRowid as number;
  }

  getRecentTrades(limit: number = 20): PaperClosedTrade[] {
    const rows = this.stmts['getRecentTrades']!.all(limit) as TradeRow[];
    return rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side as 'long',
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      quantity: r.quantity,
      usdtAmount: r.usdt_amount,
      pnlUsdt: r.pnl_usdt,
      pnlPct: r.pnl_pct,
      exitReason: r.exit_reason,
      signalsJson: r.signals_json ?? '{}',
      fingerprint: r.fingerprint ?? '',
      confidence: r.confidence,
      regime: r.regime ?? 'unknown',
      openedAt: r.opened_at,
      closedAt: r.closed_at,
    }));
  }

  countTrades(): number {
    return (this.stmts['countTrades']!.get() as { count: number }).count;
  }

  getWinRate(): { total: number; wins: number; rate: number } {
    const row = this.stmts['getWinRate']!.get() as { total: number; wins: number };
    return {
      total: row.total,
      wins: row.wins ?? 0,
      rate: row.total > 0 ? (row.wins ?? 0) / row.total : 0,
    };
  }

  getTotalPnl(): number {
    return (this.stmts['getTotalPnl']!.get() as { total: number }).total;
  }

  // ─── Price Cache ────────────────────────────────────────

  savePrices(symbol: string, candles: OHLCVCandle[]): void {
    const insert = this.stmts['savePrice']!;
    const tx = this.db.transaction(() => {
      for (const c of candles) {
        insert.run(symbol, c.timestamp, c.open, c.high, c.low, c.close, c.volume);
      }
    });
    tx();
  }

  getPrices(symbol: string): OHLCVCandle[] {
    const rows = this.stmts['getPrices']!.all(symbol) as Array<{
      timestamp: number; open: number; high: number; low: number; close: number; volume: number;
    }>;
    return rows;
  }

  getRecentPrices(symbol: string, limit: number): OHLCVCandle[] {
    const rows = this.stmts['getRecentPrices']!.all(symbol, limit) as Array<{
      timestamp: number; open: number; high: number; low: number; close: number; volume: number;
    }>;
    return rows.reverse();
  }

  pruneOldPrices(beforeTimestamp: number): void {
    this.stmts['pruneOldPrices']!.run(beforeTimestamp);
  }

  countPrices(symbol: string): number {
    return (this.stmts['countPrices']!.get(symbol) as { count: number }).count;
  }

  // ─── Reset ──────────────────────────────────────────────

  reset(startingBalance: number): void {
    const tx = this.db.transaction(() => {
      this.stmts['resetAll']!.run();
      this.stmts['resetTrades']!.run();
      this.stmts['resetBalance']!.run();
      this.stmts['resetPrices']!.run();
      this.stmts['updateBalance']!.run(startingBalance, startingBalance, 'reset');
    });
    tx();
  }

  // ─── Helpers ────────────────────────────────────────────

  private rowToPosition(r: PositionRow): PaperPosition {
    return {
      id: r.id,
      symbol: r.symbol,
      side: r.side as 'long',
      entryPrice: r.entry_price,
      quantity: r.quantity,
      usdtAmount: r.usdt_amount,
      currentPrice: r.current_price,
      pnlPct: r.pnl_pct,
      highWaterMark: r.high_water_mark,
      signalsJson: r.signals_json ?? '{}',
      fingerprint: r.fingerprint ?? '',
      confidence: r.confidence,
      regime: r.regime ?? 'unknown',
      openedAt: r.opened_at,
    };
  }
}
