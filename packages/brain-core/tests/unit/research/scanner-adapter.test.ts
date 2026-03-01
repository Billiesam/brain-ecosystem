import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScannerDataMinerAdapter } from '../../../src/research/adapters/scanner-adapter.js';

function createScannerSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scanned_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      language TEXT,
      topics TEXT DEFAULT '[]',
      created_at TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      current_stars INTEGER DEFAULT 0,
      current_forks INTEGER DEFAULT 0,
      current_watchers INTEGER DEFAULT 0,
      current_issues INTEGER DEFAULT 0,
      signal_score REAL DEFAULT 0,
      signal_level TEXT DEFAULT 'noise',
      phase TEXT DEFAULT 'discovery',
      peak_signal_level TEXT,
      peak_level_since TEXT,
      star_velocity_24h INTEGER DEFAULT 0,
      star_velocity_7d INTEGER DEFAULT 0,
      star_acceleration REAL DEFAULT 0,
      last_scanned_at TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS crypto_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coingecko_id TEXT UNIQUE NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      current_price REAL,
      market_cap REAL,
      market_cap_rank INTEGER,
      price_change_24h REAL,
      price_change_7d REAL,
      total_volume REAL,
      signal_score REAL DEFAULT 0,
      signal_level TEXT DEFAULT 'noise',
      last_scanned_at TEXT,
      is_active INTEGER DEFAULT 1
    );
  `);
}

function insertRepo(db: Database.Database, opts: {
  github_id: number; full_name: string; language?: string; signal_score?: number;
  signal_level?: string; phase?: string; current_stars?: number;
  star_velocity_24h?: number; last_scanned_at?: string;
}): void {
  db.prepare(`
    INSERT INTO scanned_repos (github_id, full_name, name, owner, url, language, signal_score, signal_level, phase, current_stars, star_velocity_24h, last_scanned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.github_id, opts.full_name, opts.full_name.split('/')[1], opts.full_name.split('/')[0],
    `https://github.com/${opts.full_name}`,
    opts.language ?? 'TypeScript', opts.signal_score ?? 30, opts.signal_level ?? 'noise',
    opts.phase ?? 'discovery', opts.current_stars ?? 100, opts.star_velocity_24h ?? 5,
    opts.last_scanned_at ?? new Date().toISOString(),
  );
}

function insertCrypto(db: Database.Database, opts: {
  coingecko_id: string; symbol: string; name: string;
  price_change_24h?: number; signal_level?: string; last_scanned_at?: string;
}): void {
  db.prepare(`
    INSERT INTO crypto_tokens (coingecko_id, symbol, name, price_change_24h, signal_level, last_scanned_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.coingecko_id, opts.symbol, opts.name,
    opts.price_change_24h ?? 2.5, opts.signal_level ?? 'noise',
    opts.last_scanned_at ?? new Date().toISOString(),
  );
}

describe('ScannerDataMinerAdapter', () => {
  let db: Database.Database;
  const adapter = new ScannerDataMinerAdapter();

  beforeEach(() => {
    db = new Database(':memory:');
    createScannerSchema(db);
  });

  it('has correct name', () => {
    expect(adapter.name).toBe('scanner');
  });

  describe('mineObservations', () => {
    it('mines language stats', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', language: 'TypeScript', signal_score: 40, current_stars: 200 });
      insertRepo(db, { github_id: 2, full_name: 'b/two', language: 'TypeScript', signal_score: 60, current_stars: 400 });
      insertRepo(db, { github_id: 3, full_name: 'c/three', language: 'Rust', signal_score: 50, current_stars: 300 });

      const obs = adapter.mineObservations(db, 0);
      const ts = obs.find(o => o.event_type === 'repo:language_stats' && (o.metrics as Record<string, unknown>).language === 'TypeScript');
      expect(ts).toBeDefined();
      expect(ts!.category).toBe('tool_usage');
      expect(ts!.metrics.count).toBe(2);
      expect(ts!.metrics.avg_score).toBeCloseTo(50);
      expect(ts!.metrics.avg_stars).toBeCloseTo(300);
    });

    it('mines signal level stats', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', signal_level: 'breakout' });
      insertRepo(db, { github_id: 2, full_name: 'b/two', signal_level: 'breakout' });
      insertRepo(db, { github_id: 3, full_name: 'c/three', signal_level: 'noise' });

      const obs = adapter.mineObservations(db, 0);
      const breakout = obs.find(o => o.event_type === 'repo:level_stats' && (o.metrics as Record<string, unknown>).signal_level === 'breakout');
      expect(breakout).toBeDefined();
      expect(breakout!.category).toBe('resolution_rate');
      expect(breakout!.metrics.count).toBe(2);
    });

    it('mines phase stats', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', phase: 'growth', current_stars: 500 });
      insertRepo(db, { github_id: 2, full_name: 'b/two', phase: 'growth', current_stars: 1000 });

      const obs = adapter.mineObservations(db, 0);
      const growth = obs.find(o => o.event_type === 'repo:phase_stats' && (o.metrics as Record<string, unknown>).phase === 'growth');
      expect(growth).toBeDefined();
      expect(growth!.metrics.count).toBe(2);
      expect(growth!.metrics.avg_stars).toBeCloseTo(750);
    });

    it('mines crypto market stats', () => {
      insertCrypto(db, { coingecko_id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', price_change_24h: 5.0 });
      insertCrypto(db, { coingecko_id: 'ethereum', symbol: 'ETH', name: 'Ethereum', price_change_24h: -15.0 });

      const obs = adapter.mineObservations(db, 0);
      const crypto = obs.find(o => o.event_type === 'crypto:market_stats');
      expect(crypto).toBeDefined();
      expect(crypto!.category).toBe('cross_brain');
      expect(crypto!.metrics.count).toBe(2);
      expect(crypto!.metrics.movers).toBe(1); // ETH has |change| > 10
    });

    it('returns empty array for empty tables', () => {
      const obs = adapter.mineObservations(db, 0);
      expect(obs).toEqual([]);
    });
  });

  describe('mineCausalEvents', () => {
    it('mines velocity spikes', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/rocket', star_velocity_24h: 100, signal_score: 65 });
      insertRepo(db, { github_id: 2, full_name: 'b/slow', star_velocity_24h: 5 });

      const events = adapter.mineCausalEvents(db, 0);
      const spikes = events.filter(e => e.type === 'repo:velocity_spike');
      expect(spikes).toHaveLength(1);
      expect(spikes[0].source).toBe('scanner');
      expect((spikes[0].data as Record<string, unknown>).velocity).toBe(100);
    });

    it('mines high score repos', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/hot', signal_score: 70, signal_level: 'breakout' });
      insertRepo(db, { github_id: 2, full_name: 'b/cold', signal_score: 20 });

      const events = adapter.mineCausalEvents(db, 0);
      const highScore = events.filter(e => e.type === 'repo:high_score');
      expect(highScore).toHaveLength(1);
      expect((highScore[0].data as Record<string, unknown>).score).toBe(70);
    });

    it('mines crypto price moves', () => {
      insertCrypto(db, { coingecko_id: 'sol', symbol: 'SOL', name: 'Solana', price_change_24h: 25.0 });
      insertCrypto(db, { coingecko_id: 'btc', symbol: 'BTC', name: 'Bitcoin', price_change_24h: 2.0 });

      const events = adapter.mineCausalEvents(db, 0);
      const moves = events.filter(e => e.type === 'crypto:price_move');
      expect(moves).toHaveLength(1);
      expect((moves[0].data as Record<string, unknown>).symbol).toBe('SOL');
    });

    it('returns empty for no qualifying data', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/normal', star_velocity_24h: 5, signal_score: 20 });
      const events = adapter.mineCausalEvents(db, 0);
      expect(events).toEqual([]);
    });
  });

  describe('mineMetrics', () => {
    it('mines repo aggregate metrics', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', signal_level: 'breakout', signal_score: 70, star_velocity_24h: 80 });
      insertRepo(db, { github_id: 2, full_name: 'b/two', signal_level: 'signal', signal_score: 50, star_velocity_24h: 20 });
      insertRepo(db, { github_id: 3, full_name: 'c/three', signal_level: 'noise', signal_score: 10, star_velocity_24h: 2 });

      const metrics = adapter.mineMetrics(db, 0);
      const total = metrics.find(m => m.name === 'scanner_total_repos');
      expect(total).toBeDefined();
      expect(total!.value).toBe(3);

      const breakouts = metrics.find(m => m.name === 'scanner_breakout_count');
      expect(breakouts!.value).toBe(1);

      const signals = metrics.find(m => m.name === 'scanner_signal_count');
      expect(signals!.value).toBe(1);

      const avgScore = metrics.find(m => m.name === 'scanner_avg_score');
      expect(avgScore!.value).toBeCloseTo(43.33, 1);

      const avgVelocity = metrics.find(m => m.name === 'scanner_avg_velocity');
      expect(avgVelocity!.value).toBeCloseTo(34);
    });

    it('mines crypto average change', () => {
      insertCrypto(db, { coingecko_id: 'btc', symbol: 'BTC', name: 'Bitcoin', price_change_24h: 10.0 });
      insertCrypto(db, { coingecko_id: 'eth', symbol: 'ETH', name: 'Ethereum', price_change_24h: -4.0 });

      const metrics = adapter.mineMetrics(db, 0);
      const cryptoAvg = metrics.find(m => m.name === 'scanner_crypto_avg_change');
      expect(cryptoAvg).toBeDefined();
      expect(cryptoAvg!.value).toBeCloseTo(3.0);
    });
  });

  describe('mineHypothesisObservations', () => {
    it('mines repos by language', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', language: 'Go', signal_score: 45 });
      insertRepo(db, { github_id: 2, full_name: 'b/two', language: 'Go', signal_score: 55 });

      const obs = adapter.mineHypothesisObservations(db, 0);
      const goObs = obs.find(o => o.type === 'repo:by_language' && o.metadata?.language === 'Go');
      expect(goObs).toBeDefined();
      expect(goObs!.source).toBe('scanner');
      expect(goObs!.value).toBe(2);
      expect(goObs!.metadata!.avg_score).toBeCloseTo(50);
    });

    it('mines repos by phase', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', phase: 'mature', current_stars: 5000 });

      const obs = adapter.mineHypothesisObservations(db, 0);
      const mature = obs.find(o => o.type === 'repo:by_phase' && o.metadata?.phase === 'mature');
      expect(mature).toBeDefined();
      expect(mature!.value).toBe(1);
    });

    it('mines crypto by signal level', () => {
      insertCrypto(db, { coingecko_id: 'btc', symbol: 'BTC', name: 'Bitcoin', signal_level: 'signal' });
      insertCrypto(db, { coingecko_id: 'eth', symbol: 'ETH', name: 'Ethereum', signal_level: 'signal' });

      const obs = adapter.mineHypothesisObservations(db, 0);
      const signalLevel = obs.find(o => o.type === 'crypto:by_level' && o.metadata?.level === 'signal');
      expect(signalLevel).toBeDefined();
      expect(signalLevel!.value).toBe(2);
    });
  });

  describe('mineCrossDomainEvents', () => {
    it('mines repo batch summary', () => {
      insertRepo(db, { github_id: 1, full_name: 'a/one', signal_level: 'breakout', language: 'TypeScript' });
      insertRepo(db, { github_id: 2, full_name: 'b/two', signal_level: 'signal', language: 'TypeScript' });
      insertRepo(db, { github_id: 3, full_name: 'c/three', signal_level: 'watch', language: 'Rust' });

      const events = adapter.mineCrossDomainEvents(db, 0);
      const repoBatch = events.find(e => e.eventType === 'scanner:repo_batch');
      expect(repoBatch).toBeDefined();
      expect(repoBatch!.brain).toBe('scanner');
      expect(repoBatch!.data!.total).toBe(3);
      expect(repoBatch!.data!.breakouts).toBe(1);
      expect(repoBatch!.data!.signals).toBe(1);
      expect(repoBatch!.data!.watches).toBe(1);
      expect(repoBatch!.data!.top_language).toBe('TypeScript');
    });

    it('mines crypto batch summary', () => {
      insertCrypto(db, { coingecko_id: 'btc', symbol: 'BTC', name: 'Bitcoin', price_change_24h: 5.0 });
      insertCrypto(db, { coingecko_id: 'sol', symbol: 'SOL', name: 'Solana', price_change_24h: 15.0 });

      const events = adapter.mineCrossDomainEvents(db, 0);
      const cryptoBatch = events.find(e => e.eventType === 'scanner:crypto_batch');
      expect(cryptoBatch).toBeDefined();
      expect(cryptoBatch!.data!.total).toBe(2);
      expect(cryptoBatch!.data!.avg_change_24h).toBeCloseTo(10.0);
      expect(cryptoBatch!.data!.movers_count).toBe(1);
    });

    it('returns empty for no data', () => {
      const events = adapter.mineCrossDomainEvents(db, 0);
      expect(events).toEqual([]);
    });
  });

  describe('timestamp filtering', () => {
    it('only mines repos scanned after since timestamp', () => {
      const old = '2020-01-01T00:00:00.000Z';
      const recent = new Date().toISOString();
      insertRepo(db, { github_id: 1, full_name: 'a/old', last_scanned_at: old });
      insertRepo(db, { github_id: 2, full_name: 'b/new', last_scanned_at: recent });

      // Use a since timestamp between old and recent
      const sinceTs = new Date('2023-01-01').getTime();
      const obs = adapter.mineObservations(db, sinceTs);
      // Should only include the recent one
      const langObs = obs.filter(o => o.event_type === 'repo:language_stats');
      expect(langObs).toHaveLength(1);
      expect(langObs[0].metrics.count).toBe(1);
    });
  });

  describe('graceful handling of missing tables', () => {
    it('returns empty arrays when tables do not exist', () => {
      const emptyDb = new Database(':memory:');
      expect(adapter.mineObservations(emptyDb, 0)).toEqual([]);
      expect(adapter.mineCausalEvents(emptyDb, 0)).toEqual([]);
      expect(adapter.mineMetrics(emptyDb, 0)).toEqual([]);
      expect(adapter.mineHypothesisObservations(emptyDb, 0)).toEqual([]);
      expect(adapter.mineCrossDomainEvents(emptyDb, 0)).toEqual([]);
    });
  });
});
