import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      balance REAL NOT NULL,
      equity REAL NOT NULL,
      event TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paper_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'long',
      entry_price REAL NOT NULL,
      quantity REAL NOT NULL,
      usdt_amount REAL NOT NULL,
      current_price REAL NOT NULL,
      pnl_pct REAL NOT NULL DEFAULT 0,
      high_water_mark REAL NOT NULL,
      signals_json TEXT,
      fingerprint TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      regime TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_paper_positions_symbol ON paper_positions(symbol);

    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL DEFAULT 'long',
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      quantity REAL NOT NULL,
      usdt_amount REAL NOT NULL,
      pnl_usdt REAL NOT NULL,
      pnl_pct REAL NOT NULL,
      exit_reason TEXT NOT NULL,
      signals_json TEXT,
      fingerprint TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      regime TEXT,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_paper_trades_symbol ON paper_trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_paper_trades_closed_at ON paper_trades(closed_at);

    CREATE TABLE IF NOT EXISTS paper_price_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_paper_price_symbol ON paper_price_cache(symbol);
    CREATE INDEX IF NOT EXISTS idx_paper_price_ts ON paper_price_cache(symbol, timestamp);
  `);

  // Insert initial balance
  db.prepare(`
    INSERT INTO paper_balance (balance, equity, event) VALUES (10000, 10000, 'initial')
  `).run();
}
