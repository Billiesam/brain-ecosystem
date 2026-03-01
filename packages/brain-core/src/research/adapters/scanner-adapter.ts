import type Database from 'better-sqlite3';
import type { DataMinerAdapter, MinedObservation, MinedCausalEvent, MinedMetric, MinedHypothesisObservation, MinedCrossDomainEvent } from '../data-miner.js';

/**
 * DataMiner adapter for the Signal Scanner.
 * Mines: scanned_repos, crypto_tokens.
 */
export class ScannerDataMinerAdapter implements DataMinerAdapter {
  readonly name = 'scanner';

  mineObservations(db: Database.Database, since: number): MinedObservation[] {
    const observations: MinedObservation[] = [];

    // Language distribution
    const languages = safeAll<{ language: string; cnt: number; avg_score: number; avg_stars: number }>(
      db,
      `SELECT language, COUNT(*) as cnt, AVG(signal_score) as avg_score, AVG(current_stars) as avg_stars
       FROM scanned_repos WHERE last_scanned_at > ? AND language IS NOT NULL GROUP BY language`,
      [isoFromTs(since)],
    );
    for (const l of languages) {
      observations.push({
        category: 'tool_usage',
        event_type: 'repo:language_stats',
        metrics: { language: l.language, count: l.cnt, avg_score: l.avg_score, avg_stars: l.avg_stars },
      });
    }

    // Signal level distribution
    const levels = safeAll<{ signal_level: string; cnt: number; avg_score: number }>(
      db,
      `SELECT signal_level, COUNT(*) as cnt, AVG(signal_score) as avg_score
       FROM scanned_repos WHERE last_scanned_at > ? GROUP BY signal_level`,
      [isoFromTs(since)],
    );
    for (const l of levels) {
      observations.push({
        category: 'resolution_rate',
        event_type: 'repo:level_stats',
        metrics: { signal_level: l.signal_level, count: l.cnt, avg_score: l.avg_score },
      });
    }

    // Phase distribution
    const phases = safeAll<{ phase: string; cnt: number; avg_stars: number }>(
      db,
      `SELECT phase, COUNT(*) as cnt, AVG(current_stars) as avg_stars
       FROM scanned_repos WHERE last_scanned_at > ? GROUP BY phase`,
      [isoFromTs(since)],
    );
    for (const p of phases) {
      observations.push({
        category: 'tool_usage',
        event_type: 'repo:phase_stats',
        metrics: { phase: p.phase, count: p.cnt, avg_stars: p.avg_stars },
      });
    }

    // Crypto market stats
    const crypto = safeGet<{ cnt: number; avg_change: number; movers: number }>(
      db,
      `SELECT COUNT(*) as cnt,
              AVG(price_change_24h) as avg_change,
              SUM(CASE WHEN ABS(price_change_24h) > 10 THEN 1 ELSE 0 END) as movers
       FROM crypto_tokens WHERE last_scanned_at > ?`,
      [isoFromTs(since)],
    );
    if (crypto && crypto.cnt > 0) {
      observations.push({
        category: 'cross_brain',
        event_type: 'crypto:market_stats',
        metrics: { count: crypto.cnt, avg_price_change: crypto.avg_change ?? 0, movers: crypto.movers ?? 0 },
      });
    }

    return observations;
  }

  mineCausalEvents(db: Database.Database, since: number): MinedCausalEvent[] {
    const events: MinedCausalEvent[] = [];

    // Velocity spikes — repos with star_velocity_24h > 50
    const velocitySpikes = safeAll<{ id: number; full_name: string; star_velocity_24h: number; signal_score: number }>(
      db,
      `SELECT id, full_name, star_velocity_24h, signal_score
       FROM scanned_repos WHERE last_scanned_at > ? AND star_velocity_24h > 50 LIMIT 200`,
      [isoFromTs(since)],
    );
    for (const r of velocitySpikes) {
      events.push({
        source: 'scanner',
        type: 'repo:velocity_spike',
        data: { repoId: r.id, fullName: r.full_name, velocity: r.star_velocity_24h, score: r.signal_score },
      });
    }

    // High score repos — signal_score >= 55
    const highScore = safeAll<{ id: number; full_name: string; signal_score: number; signal_level: string }>(
      db,
      `SELECT id, full_name, signal_score, signal_level
       FROM scanned_repos WHERE last_scanned_at > ? AND signal_score >= 55 LIMIT 200`,
      [isoFromTs(since)],
    );
    for (const r of highScore) {
      events.push({
        source: 'scanner',
        type: 'repo:high_score',
        data: { repoId: r.id, fullName: r.full_name, score: r.signal_score, level: r.signal_level },
      });
    }

    // Crypto price moves — ABS(price_change_24h) > 10
    const priceMoves = safeAll<{ id: number; symbol: string; name: string; price_change_24h: number }>(
      db,
      `SELECT id, symbol, name, price_change_24h
       FROM crypto_tokens WHERE last_scanned_at > ? AND ABS(price_change_24h) > 10 LIMIT 100`,
      [isoFromTs(since)],
    );
    for (const c of priceMoves) {
      events.push({
        source: 'scanner',
        type: 'crypto:price_move',
        data: { tokenId: c.id, symbol: c.symbol, name: c.name, priceChange24h: c.price_change_24h },
      });
    }

    return events;
  }

  mineMetrics(db: Database.Database, since: number): MinedMetric[] {
    const metrics: MinedMetric[] = [];

    const totals = safeGet<{ total: number; breakouts: number; signals: number; avg_score: number; avg_velocity: number }>(
      db,
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN signal_level = 'breakout' THEN 1 ELSE 0 END) as breakouts,
              SUM(CASE WHEN signal_level = 'signal' THEN 1 ELSE 0 END) as signals,
              AVG(signal_score) as avg_score,
              AVG(star_velocity_24h) as avg_velocity
       FROM scanned_repos WHERE last_scanned_at > ?`,
      [isoFromTs(since)],
    );
    if (totals) {
      metrics.push({ name: 'scanner_total_repos', value: totals.total });
      metrics.push({ name: 'scanner_breakout_count', value: totals.breakouts ?? 0 });
      metrics.push({ name: 'scanner_signal_count', value: totals.signals ?? 0 });
      metrics.push({ name: 'scanner_avg_score', value: totals.avg_score ?? 0 });
      metrics.push({ name: 'scanner_avg_velocity', value: totals.avg_velocity ?? 0 });
    }

    const cryptoAvg = safeGet<{ avg_change: number }>(
      db,
      `SELECT AVG(price_change_24h) as avg_change FROM crypto_tokens WHERE last_scanned_at > ?`,
      [isoFromTs(since)],
    );
    if (cryptoAvg?.avg_change != null) {
      metrics.push({ name: 'scanner_crypto_avg_change', value: cryptoAvg.avg_change });
    }

    return metrics;
  }

  mineHypothesisObservations(db: Database.Database, since: number): MinedHypothesisObservation[] {
    const observations: MinedHypothesisObservation[] = [];

    // Repos by language
    const byLanguage = safeAll<{ language: string; cnt: number; avg_score: number }>(
      db,
      `SELECT language, COUNT(*) as cnt, AVG(signal_score) as avg_score
       FROM scanned_repos WHERE last_scanned_at > ? AND language IS NOT NULL GROUP BY language`,
      [isoFromTs(since)],
    );
    for (const l of byLanguage) {
      observations.push({
        source: 'scanner',
        type: 'repo:by_language',
        value: l.cnt,
        metadata: { language: l.language, avg_score: l.avg_score },
      });
    }

    // Repos by phase
    const byPhase = safeAll<{ phase: string; cnt: number; avg_stars: number }>(
      db,
      `SELECT phase, COUNT(*) as cnt, AVG(current_stars) as avg_stars
       FROM scanned_repos WHERE last_scanned_at > ? GROUP BY phase`,
      [isoFromTs(since)],
    );
    for (const p of byPhase) {
      observations.push({
        source: 'scanner',
        type: 'repo:by_phase',
        value: p.cnt,
        metadata: { phase: p.phase, avg_stars: p.avg_stars },
      });
    }

    // Crypto by signal level
    const byLevel = safeAll<{ signal_level: string; cnt: number }>(
      db,
      `SELECT signal_level, COUNT(*) as cnt
       FROM crypto_tokens WHERE last_scanned_at > ? GROUP BY signal_level`,
      [isoFromTs(since)],
    );
    for (const l of byLevel) {
      observations.push({
        source: 'scanner',
        type: 'crypto:by_level',
        value: l.cnt,
        metadata: { level: l.signal_level },
      });
    }

    return observations;
  }

  mineCrossDomainEvents(db: Database.Database, since: number): MinedCrossDomainEvent[] {
    const events: MinedCrossDomainEvent[] = [];

    // Repo batch summary
    const repoBatch = safeGet<{ total: number; breakouts: number; signals: number; watches: number; avg_score: number }>(
      db,
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN signal_level = 'breakout' THEN 1 ELSE 0 END) as breakouts,
              SUM(CASE WHEN signal_level = 'signal' THEN 1 ELSE 0 END) as signals,
              SUM(CASE WHEN signal_level = 'watch' THEN 1 ELSE 0 END) as watches,
              AVG(signal_score) as avg_score
       FROM scanned_repos WHERE last_scanned_at > ?`,
      [isoFromTs(since)],
    );
    if (repoBatch && repoBatch.total > 0) {
      const topLang = safeGet<{ language: string }>(
        db,
        `SELECT language FROM scanned_repos WHERE last_scanned_at > ? AND language IS NOT NULL
         GROUP BY language ORDER BY COUNT(*) DESC LIMIT 1`,
        [isoFromTs(since)],
      );
      events.push({
        brain: 'scanner',
        eventType: 'scanner:repo_batch',
        data: {
          total: repoBatch.total,
          breakouts: repoBatch.breakouts ?? 0,
          signals: repoBatch.signals ?? 0,
          watches: repoBatch.watches ?? 0,
          avg_score: repoBatch.avg_score ?? 0,
          top_language: topLang?.language ?? 'unknown',
        },
      });
    }

    // Crypto batch summary
    const cryptoBatch = safeGet<{ total: number; avg_change_24h: number; movers_count: number }>(
      db,
      `SELECT COUNT(*) as total,
              AVG(price_change_24h) as avg_change_24h,
              SUM(CASE WHEN ABS(price_change_24h) > 10 THEN 1 ELSE 0 END) as movers_count
       FROM crypto_tokens WHERE last_scanned_at > ?`,
      [isoFromTs(since)],
    );
    if (cryptoBatch && cryptoBatch.total > 0) {
      events.push({
        brain: 'scanner',
        eventType: 'scanner:crypto_batch',
        data: {
          total: cryptoBatch.total,
          avg_change_24h: cryptoBatch.avg_change_24h ?? 0,
          movers_count: cryptoBatch.movers_count ?? 0,
        },
      });
    }

    return events;
  }
}

// ── Helpers ─────────────────────────────────────────────

function isoFromTs(ts: number): string {
  return ts > 0 ? new Date(ts).toISOString() : '1970-01-01T00:00:00.000Z';
}

function safeAll<T>(db: Database.Database, sql: string, params: unknown[]): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function safeGet<T>(db: Database.Database, sql: string, params: unknown[]): T | undefined {
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } catch {
    return undefined;
  }
}
