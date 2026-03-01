import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../src/db/migrations/index.js';
import { CompetitorRepository } from '../../../src/db/repositories/competitor.repository.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  createLogger: vi.fn(),
}));

describe('CompetitorRepository', () => {
  let db: Database.Database;
  let repo: CompetitorRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    repo = new CompetitorRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should create a competitor and get it by ID', () => {
    const id = repo.create({ name: 'Rival Inc', platform: 'x', handle: '@rival' });
    const competitor = repo.getById(id);
    expect(competitor).toBeDefined();
    expect(competitor!.name).toBe('Rival Inc');
    expect(competitor!.platform).toBe('x');
    expect(competitor!.handle).toBe('@rival');
    expect(competitor!.active).toBe(1);
  });

  it('should return incrementing IDs on create', () => {
    const id1 = repo.create({ name: 'Comp A', platform: 'x', handle: '@compA' });
    const id2 = repo.create({ name: 'Comp B', platform: 'x', handle: '@compB' });
    const id3 = repo.create({ name: 'Comp C', platform: 'instagram', handle: '@compC' });
    expect(id1).toBe(1);
    expect(id2).toBe(2);
    expect(id3).toBe(3);
  });

  it('should return all competitors via getAll', () => {
    repo.create({ name: 'Comp A', platform: 'x', handle: '@a' });
    repo.create({ name: 'Comp B', platform: 'x', handle: '@b' });
    repo.create({ name: 'Comp C', platform: 'instagram', handle: '@c' });

    const all = repo.getAll();
    expect(all).toHaveLength(3);
  });

  it('should return only active competitors via getActive', () => {
    const id1 = repo.create({ name: 'Active One', platform: 'x', handle: '@active1' });
    const id2 = repo.create({ name: 'Inactive One', platform: 'x', handle: '@inactive1' });
    repo.update(id2, { active: 0 });

    const active = repo.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.name).toBe('Active One');
  });

  it('should find a competitor by handle via getByHandle', () => {
    repo.create({ name: 'Handle Test', platform: 'instagram', handle: '@handletest' });

    const found = repo.getByHandle('instagram', '@handletest');
    expect(found).toBeDefined();
    expect(found!.name).toBe('Handle Test');
    expect(found!.platform).toBe('instagram');
  });

  it('should return undefined for non-existent handle', () => {
    const result = repo.getByHandle('x', '@doesnotexist');
    expect(result).toBeUndefined();
  });

  it('should update name', () => {
    const id = repo.create({ name: 'Old Name', platform: 'x', handle: '@old' });
    repo.update(id, { name: 'New Name' });
    const updated = repo.getById(id);
    expect(updated!.name).toBe('New Name');
  });

  it('should update handle', () => {
    const id = repo.create({ name: 'Test', platform: 'x', handle: '@before' });
    repo.update(id, { handle: '@after' });
    const updated = repo.getById(id);
    expect(updated!.handle).toBe('@after');
  });

  it('should update active flag', () => {
    const id = repo.create({ name: 'Deactivate Me', platform: 'x', handle: '@deact' });
    repo.update(id, { active: 0 });
    const updated = repo.getById(id);
    expect(updated!.active).toBe(0);
  });

  it('should delete a competitor', () => {
    const id = repo.create({ name: 'To Delete', platform: 'x', handle: '@delete' });
    expect(repo.getById(id)).toBeDefined();
    repo.delete(id);
    expect(repo.getById(id)).toBeUndefined();
  });

  it('should add a competitor post via addPost', () => {
    const compId = repo.create({ name: 'Poster', platform: 'x', handle: '@poster' });
    const postId = repo.addPost({
      competitor_id: compId,
      platform: 'x',
      content: 'Check out our new product!',
      url: 'https://example.com/post/1',
      engagement_json: JSON.stringify({ likes: 100, retweets: 50 }),
    });
    expect(postId).toBe(1);
  });

  it('should return posts for a specific competitor via getPosts', () => {
    const comp1 = repo.create({ name: 'Comp 1', platform: 'x', handle: '@comp1' });
    const comp2 = repo.create({ name: 'Comp 2', platform: 'x', handle: '@comp2' });

    repo.addPost({ competitor_id: comp1, platform: 'x', content: 'Post from comp1 #1' });
    repo.addPost({ competitor_id: comp1, platform: 'x', content: 'Post from comp1 #2' });
    repo.addPost({ competitor_id: comp2, platform: 'x', content: 'Post from comp2 #1' });

    const posts1 = repo.getPosts(comp1);
    expect(posts1).toHaveLength(2);
    expect(posts1.every(p => p.competitor_id === comp1)).toBe(true);

    const posts2 = repo.getPosts(comp2);
    expect(posts2).toHaveLength(1);
  });

  it('should filter posts by platform via getPostsByPlatform', () => {
    const compId = repo.create({ name: 'Multi', platform: 'x', handle: '@multi' });

    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Tweet 1' });
    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Tweet 2' });
    repo.addPost({ competitor_id: compId, platform: 'instagram', content: 'Insta post' });

    const xPosts = repo.getPostsByPlatform('x');
    expect(xPosts).toHaveLength(2);

    const instaPosts = repo.getPostsByPlatform('instagram');
    expect(instaPosts).toHaveLength(1);
    expect(instaPosts[0]!.content).toBe('Insta post');
  });

  it('should return recent posts via getRecentPosts', () => {
    const compId = repo.create({ name: 'Recent', platform: 'x', handle: '@recent' });

    // Posts created with default detected_at = datetime('now') should be within 7 days
    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Fresh post 1' });
    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Fresh post 2' });

    const recent = repo.getRecentPosts(7);
    expect(recent).toHaveLength(2);
  });

  it('should count posts for a competitor via countPosts', () => {
    const compId = repo.create({ name: 'Counter', platform: 'x', handle: '@counter' });
    expect(repo.countPosts(compId)).toBe(0);

    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Post 1' });
    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Post 2' });
    repo.addPost({ competitor_id: compId, platform: 'x', content: 'Post 3' });

    expect(repo.countPosts(compId)).toBe(3);
  });
});
