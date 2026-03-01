import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ReposignalImporter } from '../../../src/services/reposignal-importer.js';

// ── Helpers ─────────────────────────────────────────

function createBrainDb(): Database.Database {
  const db = new Database(':memory:');
  // Create tables the importer writes to
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_discoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0,
      impact REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS research_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      ref_ids TEXT NOT NULL DEFAULT '[]',
      significance TEXT NOT NULL DEFAULT 'routine',
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS prediction_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      timestamp INTEGER NOT NULL,
      domain TEXT NOT NULL DEFAULT 'metric'
    );
  `);
  return db;
}

function createReposignalDb(tmpDir: string): string {
  const dbPath = path.join(tmpDir, 'reposignal-test.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER,
      full_name TEXT NOT NULL,
      name TEXT NOT NULL,
      owner TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      language TEXT,
      topics TEXT,
      created_at TEXT,
      first_seen_at TEXT NOT NULL,
      current_stars INTEGER DEFAULT 0,
      current_forks INTEGER DEFAULT 0,
      current_watchers INTEGER DEFAULT 0,
      current_issues INTEGER DEFAULT 0,
      signal_score REAL DEFAULT 0,
      signal_level TEXT DEFAULT 'noise',
      phase TEXT DEFAULT 'unknown',
      last_scanned_at TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE hn_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT,
      score INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      repo_id INTEGER,
      posted_at TEXT,
      detected_at TEXT
    );
  `);

  // Insert test repos
  const insertRepo = db.prepare(`
    INSERT INTO repositories (full_name, name, owner, url, description, language, topics, current_stars, current_forks, signal_score, signal_level, phase, first_seen_at, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)
  `);

  insertRepo.run('vercel/next.js', 'next.js', 'vercel', 'https://github.com/vercel/next.js', 'The React Framework', 'TypeScript', '["react","framework"]', 120000, 25000, 80.5, 'breakout', 'mainstream');
  insertRepo.run('facebook/react', 'react', 'facebook', 'https://github.com/facebook/react', 'A JavaScript library for building UIs', 'JavaScript', '["ui","library"]', 220000, 45000, 70.2, 'signal', 'mainstream');
  insertRepo.run('denoland/deno', 'deno', 'denoland', 'https://github.com/denoland/deno', 'A modern runtime for JavaScript and TypeScript', 'Rust', '["runtime"]', 95000, 5000, 55.3, 'signal', 'early_adopter');
  insertRepo.run('some/tool', 'tool', 'some', 'https://github.com/some/tool', 'A small tool', 'Go', null, 500, 20, 35.0, 'watch', 'discovery');
  insertRepo.run('tiny/lib', 'lib', 'tiny', 'https://github.com/tiny/lib', 'Tiny library', 'Python', null, 50, 2, 10.0, 'noise', 'discovery');

  // Insert HN mentions
  const insertHn = db.prepare(`INSERT INTO hn_mentions (title, url, score, comment_count) VALUES (?, ?, ?, ?)`);
  insertHn.run('Next.js 15 is amazing', 'https://news.ycombinator.com/1', 500, 200);
  insertHn.run('React Server Components deep dive', 'https://news.ycombinator.com/2', 100, 50);
  insertHn.run('Small post nobody cares about', 'https://news.ycombinator.com/3', 10, 3);

  db.close();
  return dbPath;
}

// ── Tests ───────────────────────────────────────────

describe('ReposignalImporter', () => {
  let brainDb: Database.Database;
  let tmpDir: string;
  let reposignalDbPath: string;

  beforeEach(() => {
    brainDb = createBrainDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reposignal-test-'));
    reposignalDbPath = createReposignalDb(tmpDir);
  });

  afterEach(() => {
    brainDb.close();
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  describe('import()', () => {
    it('should import repos at watch+ level by default', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath);

      expect(result.totalReposInDb).toBe(5);
      // watch+ means: breakout(1) + signal(2) + watch(1) = 4 repos, noise excluded
      expect(result.reposImported).toBe(4);
      expect(result.discoveriesCreated).toBe(4);
    });

    it('should respect minSignalLevel filter', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath, { minSignalLevel: 'signal' });

      // signal+ means: breakout(1) + signal(2) = 3 repos
      expect(result.reposImported).toBe(3);
    });

    it('should create research discoveries with correct data', () => {
      const importer = new ReposignalImporter(brainDb);
      importer.import(reposignalDbPath, { minSignalLevel: 'breakout' });

      const discoveries = brainDb.prepare('SELECT * FROM research_discoveries WHERE type = ?').all('reposignal_import') as Array<Record<string, unknown>>;
      expect(discoveries.length).toBe(1);
      expect(discoveries[0].title).toContain('vercel/next.js');
      expect(discoveries[0].title).toContain('BREAKOUT');
      expect(discoveries[0].source).toBe('reposignal');

      const data = JSON.parse(discoveries[0].data as string);
      expect(data.stars).toBe(120000);
      expect(data.language).toBe('TypeScript');
      expect(data.signal_level).toBe('breakout');
    });

    it('should create journal entries for top repos', () => {
      const importer = new ReposignalImporter(brainDb);
      importer.import(reposignalDbPath);

      const journals = brainDb.prepare("SELECT * FROM research_journal WHERE title LIKE 'Trending:%'").all();
      // breakout + signal repos get individual journal entries
      expect(journals.length).toBeGreaterThanOrEqual(3);
    });

    it('should create summary journal entry', () => {
      const importer = new ReposignalImporter(brainDb);
      importer.import(reposignalDbPath);

      const summaries = brainDb.prepare("SELECT * FROM research_journal WHERE title LIKE 'Reposignal Import:%'").all();
      expect(summaries.length).toBe(1);
    });

    it('should skip duplicates on second import', () => {
      const importer = new ReposignalImporter(brainDb);
      const first = importer.import(reposignalDbPath);
      const second = importer.import(reposignalDbPath);

      expect(first.reposImported).toBe(4);
      expect(second.reposImported).toBe(0);
      expect(second.skippedDuplicates).toBe(4);
    });

    it('should import HN mentions with score > 50', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath, { includeHnMentions: true });

      // Only 2 HN mentions have score > 50
      expect(result.hnMentionsImported).toBe(2);
    });

    it('should skip HN mentions when disabled', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath, { includeHnMentions: false });

      expect(result.hnMentionsImported).toBe(0);
    });

    it('should record metrics for PredictionEngine', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath);

      expect(result.metricsRecorded).toBeGreaterThan(0);

      const metrics = brainDb.prepare('SELECT * FROM prediction_metrics').all();
      expect(metrics.length).toBeGreaterThan(0);
    });

    it('should track language breakdown', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath);

      expect(result.languageBreakdown).toBeDefined();
      expect(result.languageBreakdown['TypeScript']).toBe(1);
      expect(result.languageBreakdown['Rust']).toBe(1);
    });

    it('should track signal breakdown', () => {
      const importer = new ReposignalImporter(brainDb);
      const result = importer.import(reposignalDbPath);

      expect(result.signalBreakdown['breakout']).toBe(1);
      expect(result.signalBreakdown['signal']).toBe(2);
      expect(result.signalBreakdown['watch']).toBe(1);
    });

    it('should throw if DB path does not exist', () => {
      const importer = new ReposignalImporter(brainDb);
      expect(() => importer.import('/nonexistent/path.db')).toThrow('Reposignal DB not found');
    });
  });

  describe('getStats()', () => {
    it('should return stats after import', () => {
      const importer = new ReposignalImporter(brainDb);
      importer.import(reposignalDbPath);

      const stats = importer.getStats();
      expect(stats.totalImported).toBe(4);
      expect(stats.byLevel['breakout']).toBe(1);
      expect(stats.byLevel['signal']).toBe(2);
      expect(stats.lastImport).toBeTruthy();
    });

    it('should return zero stats before any import', () => {
      const importer = new ReposignalImporter(brainDb);
      const stats = importer.getStats();
      expect(stats.totalImported).toBe(0);
      expect(stats.lastImport).toBeNull();
    });
  });

  describe('getLastResult()', () => {
    it('should return null before import', () => {
      const importer = new ReposignalImporter(brainDb);
      expect(importer.getLastResult()).toBeNull();
    });

    it('should return last result after import', () => {
      const importer = new ReposignalImporter(brainDb);
      importer.import(reposignalDbPath);

      const result = importer.getLastResult();
      expect(result).toBeTruthy();
      expect(result!.reposImported).toBe(4);
      expect(result!.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
