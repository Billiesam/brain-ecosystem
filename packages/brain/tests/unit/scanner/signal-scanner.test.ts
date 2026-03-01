import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SignalScanner, runScannerMigration } from '@timmeck/brain-core';

describe('SignalScanner', () => {
  let db: Database.Database;
  let scanner: SignalScanner;

  beforeEach(() => {
    db = new Database(':memory:');
    scanner = new SignalScanner(db, {
      enabled: false, // Don't start timer
      githubToken: '',
      scanIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    scanner.stop();
    db.close();
  });

  describe('migration', () => {
    it('should create all required tables', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `).all() as Array<{ name: string }>;
      const names = tables.map(t => t.name);
      expect(names).toContain('scanned_repos');
      expect(names).toContain('repo_daily_stats');
      expect(names).toContain('hn_mentions');
      expect(names).toContain('crypto_tokens');
      expect(names).toContain('scanner_state');
    });

    it('should be idempotent', () => {
      expect(() => runScannerMigration(db)).not.toThrow();
      expect(() => runScannerMigration(db)).not.toThrow();
    });
  });

  describe('getStatus', () => {
    it('should return status with zero repos initially', () => {
      const status = scanner.getStatus();
      expect(status.running).toBe(false);
      expect(status.total_repos).toBe(0);
      expect(status.total_active).toBe(0);
      expect(status.by_level).toEqual({ breakout: 0, signal: 0, watch: 0, noise: 0 });
    });
  });

  describe('repo CRUD', () => {
    it('should insert and retrieve repos', () => {
      // Manually insert a test repo
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, description, language, topics, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(123, 'test/repo', 'repo', 'test', 'https://github.com/test/repo', 'A test repo', 'TypeScript', '["ai"]', 500, 60, 'signal', 1);

      const signals = scanner.getSignals('signal');
      expect(signals.length).toBe(1);
      expect(signals[0].full_name).toBe('test/repo');
      expect(signals[0].topics).toEqual(['ai']);
    });

    it('should search repos by query', () => {
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, description, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'langchain/langchain', 'langchain', 'langchain', 'https://github.com/langchain/langchain', 'LLM framework', 'Python', 50000, 75, 'breakout', 1);

      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, description, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 'other/repo', 'repo', 'other', 'https://github.com/other/repo', 'Something else', 'Rust', 100, 30, 'watch', 1);

      const results = scanner.searchRepos('langchain');
      expect(results.length).toBe(1);
      expect(results[0].full_name).toBe('langchain/langchain');
    });

    it('should search repos by language', () => {
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'a/b', 'b', 'a', 'url', 'Rust', 100, 50, 'watch', 1);
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 'c/d', 'd', 'c', 'url', 'Python', 200, 60, 'signal', 1);

      const rustOnly = scanner.searchRepos('', 'Rust');
      expect(rustOnly.length).toBe(1);
      expect(rustOnly[0].language).toBe('Rust');
    });

    it('should get trending by velocity', () => {
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, current_stars, star_velocity_24h, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'slow/repo', 'repo', 'slow', 'url', 100, 2, 30, 'watch', 1);
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, current_stars, star_velocity_24h, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 'fast/repo', 'repo', 'fast', 'url', 1000, 100, 70, 'breakout', 1);

      const trending = scanner.getTrending(10);
      expect(trending[0].full_name).toBe('fast/repo');
      expect(trending[0].star_velocity_24h).toBe(100);
    });

    it('should get repo with daily stats', () => {
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(42, 'owner/repo', 'repo', 'owner', 'url', 500, 45, 'watch', 1);

      const repoId = (db.prepare('SELECT id FROM scanned_repos WHERE github_id = 42').get() as { id: number }).id;
      db.prepare(`
        INSERT INTO repo_daily_stats (repo_id, date, stars, forks)
        VALUES (?, ?, ?, ?)
      `).run(repoId, '2025-03-01', 490, 40);
      db.prepare(`
        INSERT INTO repo_daily_stats (repo_id, date, stars, forks)
        VALUES (?, ?, ?, ?)
      `).run(repoId, '2025-03-02', 500, 42);

      const result = scanner.getRepo(42);
      expect(result).not.toBeNull();
      expect(result!.full_name).toBe('owner/repo');
      expect(result!.daily_stats.length).toBe(2);
    });

    it('should return null for non-existent repo', () => {
      expect(scanner.getRepo(999999)).toBeNull();
    });
  });

  describe('dedup', () => {
    it('should handle duplicate github_id gracefully', () => {
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(100, 'test/repo', 'repo', 'test', 'url', 500, 40, 'watch', 1);

      // Unique constraint prevents dupes
      expect(() => {
        db.prepare(`
          INSERT INTO scanned_repos (github_id, full_name, name, owner, url, current_stars, signal_score, signal_level, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(100, 'test/repo', 'repo', 'test', 'url', 600, 45, 'watch', 1);
      }).toThrow();
    });
  });

  describe('HN mentions', () => {
    it('should store and retrieve HN mentions', () => {
      db.prepare(`
        INSERT INTO hn_mentions (hn_id, title, url, score, comment_count, author)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(123, 'Show HN: Cool Repo', 'https://github.com/cool/repo', 200, 150, 'testuser');

      const mentions = scanner.getHnMentions();
      expect(mentions.length).toBe(1);
      expect(mentions[0].title).toBe('Show HN: Cool Repo');
      expect(mentions[0].score).toBe(200);
    });
  });

  describe('crypto tokens', () => {
    it('should store and retrieve crypto tokens', () => {
      db.prepare(`
        INSERT INTO crypto_tokens (coingecko_id, symbol, name, current_price, price_change_24h, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('bitcoin', 'btc', 'Bitcoin', 50000, 2.5, 65, 'signal', 1);

      const tokens = scanner.getCryptoTokens();
      expect(tokens.length).toBe(1);
      expect(tokens[0].symbol).toBe('btc');
      expect(tokens[0].signal_score).toBe(65);
    });

    it('should get crypto trending by price change', () => {
      db.prepare(`
        INSERT INTO crypto_tokens (coingecko_id, symbol, name, price_change_24h, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('stable', 'stbl', 'Stable', 0.1, 20, 'noise', 1);
      db.prepare(`
        INSERT INTO crypto_tokens (coingecko_id, symbol, name, price_change_24h, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('volatile', 'vol', 'Volatile', 25.0, 60, 'signal', 1);

      const trending = scanner.getCryptoTrending();
      expect(trending[0].symbol).toBe('vol');
    });
  });

  describe('stats', () => {
    it('should return aggregated stats', () => {
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(1, 'a/b', 'b', 'a', 'url', 'TypeScript', 100, 60, 'signal', 1);
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(2, 'c/d', 'd', 'c', 'url', 'Python', 200, 75, 'breakout', 1);
      db.prepare(`
        INSERT INTO scanned_repos (github_id, full_name, name, owner, url, language, current_stars, signal_score, signal_level, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(3, 'e/f', 'f', 'e', 'url', 'TypeScript', 50, 20, 'noise', 1);

      const stats = scanner.getStats();
      expect(stats.total_repos).toBe(3);
      expect(stats.active_repos).toBe(3);
      expect((stats.by_language as Array<{ language: string; count: number }>).find(l => l.language === 'TypeScript')?.count).toBe(2);
      expect((stats.by_level as Array<{ signal_level: string; count: number }>).find(l => l.signal_level === 'breakout')?.count).toBe(1);
    });
  });

  describe('config', () => {
    it('should get and update config', () => {
      const config = scanner.getConfig();
      expect(config.enabled).toBe(false);
      expect(config.scanIntervalMs).toBe(999_999);

      const updated = scanner.updateConfig({ minStarsEmerging: 50 });
      expect(updated.minStarsEmerging).toBe(50);
    });
  });
});
