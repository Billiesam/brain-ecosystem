import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations/index.js';
import { SchedulerRepository } from '../../../src/db/repositories/scheduler.repository.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  createLogger: vi.fn(),
}));

describe('SchedulerRepository', () => {
  let db: Database.Database;
  let repo: SchedulerRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new SchedulerRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should create a scheduled post and return its id', () => {
    const id = repo.create({
      platform: 'x',
      content: 'Hello scheduled world',
      scheduled_at: '2026-06-01T10:00:00Z',
    });
    expect(id).toBe(1);
  });

  it('should retrieve a scheduled post by id', () => {
    const id = repo.create({
      platform: 'linkedin',
      content: 'Check out our article',
      format: 'link',
      hashtags: '#marketing,#growth',
      scheduled_at: '2026-06-01T12:00:00Z',
      webhook_url: 'https://example.com/hook',
    });

    const post = repo.getById(id);
    expect(post).toBeDefined();
    expect(post!.platform).toBe('linkedin');
    expect(post!.content).toBe('Check out our article');
    expect(post!.format).toBe('link');
    expect(post!.hashtags).toBe('#marketing,#growth');
    expect(post!.status).toBe('pending');
    expect(post!.published_at).toBeNull();
    expect(post!.webhook_url).toBe('https://example.com/hook');
  });

  it('should return undefined for non-existent id', () => {
    expect(repo.getById(999)).toBeUndefined();
  });

  it('should return all posts via getAll ordered by scheduled_at DESC', () => {
    repo.create({ platform: 'x', content: 'Post A', scheduled_at: '2026-06-01T08:00:00Z' });
    repo.create({ platform: 'x', content: 'Post B', scheduled_at: '2026-06-02T08:00:00Z' });
    repo.create({ platform: 'reddit', content: 'Post C', scheduled_at: '2026-06-03T08:00:00Z' });

    const all = repo.getAll();
    expect(all).toHaveLength(3);
    // Ordered by scheduled_at DESC, so Post C first
    expect(all[0]!.content).toBe('Post C');
    expect(all[2]!.content).toBe('Post A');
  });

  it('should return only pending posts via getPending ordered by scheduled_at ASC', () => {
    const id1 = repo.create({ platform: 'x', content: 'Pending 1', scheduled_at: '2026-06-02T10:00:00Z' });
    const id2 = repo.create({ platform: 'x', content: 'Pending 2', scheduled_at: '2026-06-01T10:00:00Z' });
    const id3 = repo.create({ platform: 'x', content: 'Published', scheduled_at: '2026-06-03T10:00:00Z' });

    repo.markPublished(id3);

    const pending = repo.getPending();
    expect(pending).toHaveLength(2);
    // Ordered by scheduled_at ASC, so Pending 2 (June 1) first
    expect(pending[0]!.content).toBe('Pending 2');
    expect(pending[1]!.content).toBe('Pending 1');
  });

  it('should return due posts where scheduled_at is in the past', () => {
    // Post scheduled in the past (should be due)
    repo.create({ platform: 'x', content: 'Due post', scheduled_at: '2020-01-01T00:00:00Z' });
    // Post scheduled far in the future (should not be due)
    repo.create({ platform: 'x', content: 'Future post', scheduled_at: '2099-12-31T23:59:59Z' });

    const due = repo.getDue();
    expect(due).toHaveLength(1);
    expect(due[0]!.content).toBe('Due post');
  });

  it('should filter posts by status via getByStatus', () => {
    const id1 = repo.create({ platform: 'x', content: 'A', scheduled_at: '2026-06-01T10:00:00Z' });
    const id2 = repo.create({ platform: 'x', content: 'B', scheduled_at: '2026-06-02T10:00:00Z' });
    const id3 = repo.create({ platform: 'x', content: 'C', scheduled_at: '2026-06-03T10:00:00Z' });

    repo.markPublished(id1);
    repo.cancel(id2);

    const published = repo.getByStatus('published');
    expect(published).toHaveLength(1);
    expect(published[0]!.content).toBe('A');

    const cancelled = repo.getByStatus('cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.content).toBe('B');

    const pending = repo.getByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.content).toBe('C');
  });

  it('should set status to published and published_at via markPublished', () => {
    const id = repo.create({ platform: 'x', content: 'To publish', scheduled_at: '2026-06-01T10:00:00Z' });

    repo.markPublished(id);

    const post = repo.getById(id);
    expect(post!.status).toBe('published');
    expect(post!.published_at).not.toBeNull();
  });

  it('should set status to cancelled via cancel', () => {
    const id = repo.create({ platform: 'x', content: 'To cancel', scheduled_at: '2026-06-01T10:00:00Z' });

    repo.cancel(id);

    const post = repo.getById(id);
    expect(post!.status).toBe('cancelled');
  });

  it('should remove a post via delete', () => {
    const id = repo.create({ platform: 'x', content: 'To delete', scheduled_at: '2026-06-01T10:00:00Z' });

    repo.delete(id);

    expect(repo.getById(id)).toBeUndefined();
  });

  it('should return correct count via countPending', () => {
    expect(repo.countPending()).toBe(0);

    repo.create({ platform: 'x', content: 'P1', scheduled_at: '2026-06-01T10:00:00Z' });
    repo.create({ platform: 'x', content: 'P2', scheduled_at: '2026-06-02T10:00:00Z' });
    const id3 = repo.create({ platform: 'x', content: 'P3', scheduled_at: '2026-06-03T10:00:00Z' });

    expect(repo.countPending()).toBe(3);

    repo.markPublished(id3);
    expect(repo.countPending()).toBe(2);
  });

  it('should update fields via update', () => {
    const id = repo.create({ platform: 'x', content: 'Original', scheduled_at: '2026-06-01T10:00:00Z' });

    repo.update(id, { scheduled_at: '2026-07-01T14:00:00Z', content: 'Updated' });

    const post = repo.getById(id);
    expect(post!.scheduled_at).toBe('2026-07-01T14:00:00Z');
    expect(post!.content).toBe('Updated');
  });
});
