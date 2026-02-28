import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PatternExtractor } from '../../../src/learning/pattern-extractor.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      platform TEXT,
      content TEXT,
      format TEXT,
      hashtags TEXT,
      published_at TEXT,
      status TEXT DEFAULT 'published'
    );
    CREATE TABLE engagement (
      id INTEGER PRIMARY KEY,
      post_id INTEGER,
      likes INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      saves INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/** Helper: insert a post and its engagement in one call. */
function seed(
  db: Database.Database,
  post: {
    id: number;
    platform: string;
    content: string;
    format: string;
    hashtags?: string | null;
    published_at: string;
    status?: string;
  },
  eng: {
    likes?: number;
    comments?: number;
    shares?: number;
    impressions?: number;
    clicks?: number;
    saves?: number;
    timestamp?: string;
  },
): void {
  db.prepare(
    `INSERT INTO posts (id, platform, content, format, hashtags, published_at, status)
     VALUES (@id, @platform, @content, @format, @hashtags, @published_at, @status)`,
  ).run({
    id: post.id,
    platform: post.platform,
    content: post.content,
    format: post.format,
    hashtags: post.hashtags ?? null,
    published_at: post.published_at,
    status: post.status ?? 'published',
  });

  db.prepare(
    `INSERT INTO engagement (post_id, likes, comments, shares, impressions, clicks, saves, timestamp)
     VALUES (@post_id, @likes, @comments, @shares, @impressions, @clicks, @saves, @timestamp)`,
  ).run({
    post_id: post.id,
    likes: eng.likes ?? 0,
    comments: eng.comments ?? 0,
    shares: eng.shares ?? 0,
    impressions: eng.impressions ?? 0,
    clicks: eng.clicks ?? 0,
    saves: eng.saves ?? 0,
    timestamp: eng.timestamp ?? post.published_at,
  });
}

/**
 * Seed a large dataset with clear timing (Monday), format (video), platform (x),
 * and content (question) signals. Uses 20 posts total so the confidence formula
 * produces values above 0.5.
 *
 * Posts 1-5: Monday / x / video / questions / high engagement
 * Posts 6-10: Monday / x / video / questions / high engagement
 * Posts 11-20: Wednesday / reddit / text / statements / low engagement
 */
function seedRichDataset(db: Database.Database): void {
  // ---- HIGH-engagement: Monday / x / video / questions ----
  // Mondays in Jan-Feb 2026: Jan 5, 12, 19, 26, Feb 2, 9, 16, 23
  const highDates = [
    '2026-01-05T10:00:00Z', // Mon
    '2026-01-12T10:00:00Z', // Mon
    '2026-01-19T10:00:00Z', // Mon
    '2026-01-26T10:00:00Z', // Mon
    '2026-02-02T10:00:00Z', // Mon
    '2026-02-09T10:00:00Z', // Mon
    '2026-02-16T10:00:00Z', // Mon
    '2026-02-23T10:00:00Z', // Mon
  ];

  for (let i = 0; i < 8; i++) {
    seed(
      db,
      {
        id: i + 1,
        platform: 'x',
        content: `What do you think about topic ${i}?`,
        format: 'video',
        hashtags: '#marketing #growth',
        published_at: highDates[i]!,
      },
      { likes: 80 + i * 2, comments: 20 + i, shares: 10 + i, impressions: 5000, clicks: 30, saves: 5 },
    );
  }

  // ---- LOW-engagement: Wednesday / reddit / text / statements ----
  // Wednesdays in Jan-Feb 2026: Jan 7, 14, 21, 28, Feb 4, 11, 18, 25
  const lowDates = [
    '2026-01-07T10:00:00Z', // Wed
    '2026-01-14T10:00:00Z', // Wed
    '2026-01-21T10:00:00Z', // Wed
    '2026-01-28T10:00:00Z', // Wed
    '2026-02-04T10:00:00Z', // Wed
    '2026-02-11T10:00:00Z', // Wed
    '2026-02-18T10:00:00Z', // Wed
    '2026-02-25T10:00:00Z', // Wed
    '2026-01-08T10:00:00Z', // Thu
    '2026-01-15T10:00:00Z', // Thu
    '2026-01-22T10:00:00Z', // Thu
    '2026-01-29T10:00:00Z', // Thu
  ];

  for (let i = 0; i < 12; i++) {
    seed(
      db,
      {
        id: 9 + i,
        platform: 'reddit',
        content: `Just sharing an update number ${i}.`,
        format: 'text',
        published_at: lowDates[i]!,
      },
      { likes: 3 + (i % 3), comments: 1, impressions: 200, clicks: 2 },
    );
  }
}

describe('PatternExtractor', () => {
  let db: Database.Database;
  let extractor: PatternExtractor;

  beforeEach(() => {
    db = createDb();
    extractor = new PatternExtractor(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. Returns empty array when fewer than 3 posts ──

  it('returns empty array when fewer than 3 posts', () => {
    seed(db, { id: 1, platform: 'x', content: 'hello', format: 'text', published_at: '2026-01-06T10:00:00Z' }, { likes: 50, comments: 10 });
    seed(db, { id: 2, platform: 'x', content: 'world', format: 'text', published_at: '2026-01-07T10:00:00Z' }, { likes: 40, comments: 8 });

    const patterns = extractor.extractPatterns();
    expect(patterns).toEqual([]);
  });

  // ── 2. Detects timing patterns (posts on a specific day outperform) ──

  it('detects timing patterns when posts on a specific day outperform', () => {
    seedRichDataset(db);

    const patterns = extractor.extractPatterns();
    const timingPatterns = patterns.filter(p => p.category === 'timing');
    expect(timingPatterns.length).toBeGreaterThanOrEqual(1);

    const mondayPattern = timingPatterns.find(p => p.pattern.includes('Monday'));
    expect(mondayPattern).toBeDefined();
    expect(mondayPattern!.multiplier).toBeGreaterThan(1.3);
    expect(mondayPattern!.sampleSize).toBeGreaterThanOrEqual(3);
  });

  // ── 3. Detects format patterns (video outperforms text) ──

  it('detects format patterns when video outperforms text', () => {
    seedRichDataset(db);

    const patterns = extractor.extractPatterns();
    const formatPatterns = patterns.filter(p => p.category === 'format');
    expect(formatPatterns.length).toBeGreaterThanOrEqual(1);

    const videoPattern = formatPatterns.find(p => p.pattern.includes('video'));
    expect(videoPattern).toBeDefined();
    expect(videoPattern!.multiplier).toBeGreaterThanOrEqual(1.2);
  });

  // ── 4. Detects platform patterns (x outperforms reddit) ──

  it('detects platform patterns when x outperforms reddit', () => {
    seedRichDataset(db);

    const patterns = extractor.extractPatterns();
    const platformPatterns = patterns.filter(p => p.category === 'platform');
    expect(platformPatterns.length).toBeGreaterThanOrEqual(1);

    const xPattern = platformPatterns.find(p => p.pattern.includes('x outperforms'));
    expect(xPattern).toBeDefined();
    expect(xPattern!.multiplier).toBeGreaterThanOrEqual(1.2);
  });

  // ── 5. Detects content patterns (questions get more engagement) ──

  it('detects content patterns when questions get more engagement', () => {
    seedRichDataset(db);

    const patterns = extractor.extractPatterns();
    const contentPatterns = patterns.filter(p => p.category === 'content');
    expect(contentPatterns.length).toBeGreaterThanOrEqual(1);

    const questionPattern = contentPatterns.find(p => p.pattern.includes('questions'));
    expect(questionPattern).toBeDefined();
    expect(questionPattern!.multiplier).toBeGreaterThanOrEqual(1.2);
  });

  // ── 6. Filters out patterns with fewer than 3 samples ──

  it('filters out patterns with fewer than 3 samples', () => {
    // 2 video posts (not enough for format pattern) with high engagement
    seed(db, { id: 1, platform: 'x', content: 'vid1', format: 'video', published_at: '2026-01-05T10:00:00Z' }, { likes: 100, comments: 30, shares: 15 });
    seed(db, { id: 2, platform: 'x', content: 'vid2', format: 'video', published_at: '2026-01-06T10:00:00Z' }, { likes: 110, comments: 35, shares: 18 });

    // 6 text posts with low engagement so total > 3
    for (let i = 3; i <= 8; i++) {
      seed(
        db,
        { id: i, platform: 'x', content: `txt${i}`, format: 'text', published_at: `2026-01-${String(i + 4).padStart(2, '0')}T10:00:00Z` },
        { likes: 5, comments: 1 },
      );
    }

    const patterns = extractor.extractPatterns();

    // 'video' only has 2 samples so it should be filtered out
    const videoPattern = patterns.find(p => p.pattern.includes('video'));
    expect(videoPattern).toBeUndefined();
  });

  // ── 7. Filters out patterns with confidence below 0.5 ──

  it('filters out patterns with confidence below 0.5', () => {
    // 3 posts on one platform with slightly above-average engagement
    seed(db, { id: 1, platform: 'x', content: 'a1', format: 'text', published_at: '2026-01-05T10:00:00Z' }, { likes: 12, comments: 2 });
    seed(db, { id: 2, platform: 'x', content: 'a2', format: 'text', published_at: '2026-01-06T10:00:00Z' }, { likes: 13, comments: 2 });
    seed(db, { id: 3, platform: 'x', content: 'a3', format: 'text', published_at: '2026-01-07T10:00:00Z' }, { likes: 11, comments: 2 });

    // 10 posts on another platform with slightly below-average engagement
    for (let i = 4; i <= 13; i++) {
      seed(
        db,
        { id: i, platform: 'reddit', content: `b${i}`, format: 'text', published_at: `2026-01-${String(i + 4).padStart(2, '0')}T10:00:00Z` },
        { likes: 9, comments: 2 },
      );
    }

    const patterns = extractor.extractPatterns();

    // All returned patterns should have confidence >= 0.5
    for (const p of patterns) {
      expect(p.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  // ── 8. Returns patterns with correct structure ──

  it('returns patterns with correct structure', () => {
    seedRichDataset(db);

    const patterns = extractor.extractPatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(1);

    for (const p of patterns) {
      expect(p).toHaveProperty('pattern');
      expect(p).toHaveProperty('category');
      expect(p).toHaveProperty('confidence');
      expect(p).toHaveProperty('sampleSize');
      expect(p).toHaveProperty('avgEngagement');
      expect(p).toHaveProperty('baselineEngagement');
      expect(p).toHaveProperty('multiplier');

      expect(typeof p.pattern).toBe('string');
      expect(['timing', 'format', 'content', 'platform']).toContain(p.category);
      expect(typeof p.confidence).toBe('number');
      expect(p.confidence).toBeGreaterThanOrEqual(0.5);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(typeof p.sampleSize).toBe('number');
      expect(p.sampleSize).toBeGreaterThanOrEqual(3);
      expect(typeof p.avgEngagement).toBe('number');
      expect(typeof p.baselineEngagement).toBe('number');
      expect(typeof p.multiplier).toBe('number');
      expect(p.multiplier).toBeGreaterThanOrEqual(1);
    }
  });
});
