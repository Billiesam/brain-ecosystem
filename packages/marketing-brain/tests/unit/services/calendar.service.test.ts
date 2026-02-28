import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CalendarService } from '../../../src/services/calendar.service.js';

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
 * Seed enough posts to trigger a strong Monday timing pattern.
 * Uses 20 posts (8 high-engagement Monday, 12 low-engagement other days)
 * so the confidence formula produces values above the 0.5 threshold.
 */
function seedTimingData(db: Database.Database): void {
  // 8 high-engagement Monday posts
  const mondays = [
    '2026-01-05T10:00:00Z', '2026-01-12T10:00:00Z',
    '2026-01-19T10:00:00Z', '2026-01-26T10:00:00Z',
    '2026-02-02T10:00:00Z', '2026-02-09T10:00:00Z',
    '2026-02-16T10:00:00Z', '2026-02-23T10:00:00Z',
  ];
  for (let i = 0; i < 8; i++) {
    seed(
      db,
      { id: i + 1, platform: 'x', content: `mon${i}`, format: 'text', published_at: mondays[i]! },
      { likes: 80 + i * 2, comments: 20 + i, shares: 10 + i, impressions: 5000, clicks: 30, saves: 5 },
    );
  }

  // 12 low-engagement Wednesday/Thursday posts
  const lowDates = [
    '2026-01-07T10:00:00Z', '2026-01-14T10:00:00Z',
    '2026-01-21T10:00:00Z', '2026-01-28T10:00:00Z',
    '2026-02-04T10:00:00Z', '2026-02-11T10:00:00Z',
    '2026-02-18T10:00:00Z', '2026-02-25T10:00:00Z',
    '2026-01-08T10:00:00Z', '2026-01-15T10:00:00Z',
    '2026-01-22T10:00:00Z', '2026-01-29T10:00:00Z',
  ];
  for (let i = 0; i < 12; i++) {
    seed(
      db,
      { id: 9 + i, platform: 'x', content: `low${i}`, format: 'text', published_at: lowDates[i]! },
      { likes: 3 + (i % 3), comments: 1, impressions: 200, clicks: 2 },
    );
  }
}

describe('CalendarService', () => {
  let db: Database.Database;
  let service: CalendarService;

  beforeEach(() => {
    db = createDb();
    service = new CalendarService(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. suggestNextPostTime returns a suggestion with time, day, hour, reason, confidence ──

  it('suggestNextPostTime returns a suggestion with all required fields', () => {
    const suggestion = service.suggestNextPostTime();

    expect(suggestion).toBeDefined();
    expect(suggestion).toHaveProperty('time');
    expect(suggestion).toHaveProperty('day');
    expect(suggestion).toHaveProperty('hour');
    expect(suggestion).toHaveProperty('reason');
    expect(suggestion).toHaveProperty('confidence');

    expect(typeof suggestion.time).toBe('string');
    expect(typeof suggestion.day).toBe('string');
    expect(typeof suggestion.hour).toBe('number');
    expect(typeof suggestion.reason).toBe('string');
    expect(typeof suggestion.confidence).toBe('number');
  });

  // ── 2. suggestNextPostTime returns default when no post data ──

  it('suggestNextPostTime returns default when no post data', () => {
    const suggestion = service.suggestNextPostTime();

    expect(suggestion.confidence).toBe(0.3);
    expect(suggestion.reason).toContain('Default recommended time');
    expect(suggestion.reason).toContain('no learned patterns');
  });

  // ── 3. suggestNextPostTime uses learned patterns when data available ──

  it('suggestNextPostTime uses learned patterns when data is available', () => {
    seedTimingData(db);

    const suggestion = service.suggestNextPostTime();

    // When patterns are found, confidence should be higher than the 0.3 default
    expect(suggestion.confidence).toBeGreaterThan(0.3);
    // The reason should come from the extracted pattern (mentions Monday)
    expect(suggestion.day).toBe('Monday');
    expect(suggestion.reason).toContain('Monday');
  });

  // ── 4. getWeeklySchedule returns array of WeeklySlots ──

  it('getWeeklySchedule returns array of WeeklySlots', () => {
    const schedule = service.getWeeklySchedule();

    expect(Array.isArray(schedule)).toBe(true);
    expect(schedule.length).toBeGreaterThanOrEqual(1);

    for (const slot of schedule) {
      expect(slot).toHaveProperty('day');
      expect(slot).toHaveProperty('time');
      expect(slot).toHaveProperty('reason');
      expect(slot).toHaveProperty('confidence');
      expect(typeof slot.day).toBe('string');
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/); // e.g. "09:00"
      expect(typeof slot.reason).toBe('string');
      expect(typeof slot.confidence).toBe('number');
    }
  });

  // ── 5. getWeeklySchedule fills empty days with defaults ──

  it('getWeeklySchedule fills empty days with defaults when no patterns exist', () => {
    const schedule = service.getWeeklySchedule();

    // Without patterns it should use default times
    // Default x times: Tuesday 09:00, Wednesday 12:00, Thursday 10:00
    expect(schedule.length).toBeGreaterThanOrEqual(3);

    const defaultSlots = schedule.filter(s => s.reason.includes('Default recommended time'));
    expect(defaultSlots.length).toBeGreaterThanOrEqual(1);
  });

  // ── 6. getWeeklySchedule sorts by day of week ──

  it('getWeeklySchedule sorts by day of week', () => {
    const schedule = service.getWeeklySchedule();

    const dayOrder = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    for (let i = 1; i < schedule.length; i++) {
      const prevDayIdx = dayOrder.indexOf(schedule[i - 1]!.day);
      const curDayIdx = dayOrder.indexOf(schedule[i]!.day);
      expect(curDayIdx).toBeGreaterThanOrEqual(prevDayIdx);
    }
  });

  // ── 7. Default suggestion for 'x' platform uses x defaults ──

  it('default suggestion for x platform uses x defaults', () => {
    const suggestion = service.suggestNextPostTime('x');

    expect(suggestion.reason).toContain('Default recommended time');
    expect(suggestion.reason).toContain('x');
    // Default x time: day=2 (Tuesday), hour=9
    expect(suggestion.day).toBe('Tuesday');
    expect(suggestion.hour).toBe(9);
  });

  // ── 8. Default suggestion for 'linkedin' uses linkedin defaults ──

  it('default suggestion for linkedin platform uses linkedin defaults', () => {
    const suggestion = service.suggestNextPostTime('linkedin');

    expect(suggestion.reason).toContain('Default recommended time');
    expect(suggestion.reason).toContain('linkedin');
    // Default linkedin time: day=2 (Tuesday), hour=8
    expect(suggestion.day).toBe('Tuesday');
    expect(suggestion.hour).toBe(8);
  });
});
