/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompetitorService } from '../../../src/services/competitor.service.js';
import type { CompetitorRepository, CompetitorRecord, CompetitorPostRecord } from '../../../src/db/repositories/competitor.repository.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeCompetitor(overrides: Partial<CompetitorRecord> = {}): CompetitorRecord {
  return {
    id: 1,
    name: 'Rival Inc',
    platform: 'x',
    handle: '@rival',
    url: null,
    notes: null,
    active: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCompetitorPost(overrides: Partial<CompetitorPostRecord> = {}): CompetitorPostRecord {
  return {
    id: 1,
    competitor_id: 1,
    platform: 'x',
    content: 'Check out our product launch!',
    url: null,
    engagement_json: null,
    detected_at: '2026-01-15T12:00:00.000Z',
    created_at: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('CompetitorService', () => {
  let service: CompetitorService;
  let competitorRepo: {
    getByHandle: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    getActive: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    addPost: ReturnType<typeof vi.fn>;
    getPosts: ReturnType<typeof vi.fn>;
    countPosts: ReturnType<typeof vi.fn>;
    db: {
      prepare: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    competitorRepo = {
      getByHandle: vi.fn(),
      create: vi.fn(),
      getActive: vi.fn(),
      delete: vi.fn(),
      addPost: vi.fn(),
      getPosts: vi.fn(),
      countPosts: vi.fn(),
      db: {
        prepare: vi.fn(),
      },
    };

    service = new CompetitorService(competitorRepo as unknown as CompetitorRepository);
  });

  describe('addCompetitor', () => {
    it('should create a new competitor when handle does not exist', () => {
      competitorRepo.getByHandle.mockReturnValue(undefined);
      competitorRepo.create.mockReturnValue(10);

      const result = service.addCompetitor({
        name: 'New Rival',
        platform: 'x',
        handle: '@newrival',
      });

      expect(result).toEqual({ competitorId: 10, isNew: true });
      expect(competitorRepo.create).toHaveBeenCalledWith({
        name: 'New Rival',
        platform: 'x',
        handle: '@newrival',
      });
    });

    it('should return existing competitor when handle already exists', () => {
      const existing = makeCompetitor({ id: 5, handle: '@existing' });
      competitorRepo.getByHandle.mockReturnValue(existing);

      const result = service.addCompetitor({
        name: 'Existing',
        platform: 'x',
        handle: '@existing',
      });

      expect(result).toEqual({ competitorId: 5, isNew: false });
      expect(competitorRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('listCompetitors', () => {
    it('should return active competitors', () => {
      const competitors = [
        makeCompetitor({ id: 1, name: 'Active A' }),
        makeCompetitor({ id: 2, name: 'Active B' }),
      ];
      competitorRepo.getActive.mockReturnValue(competitors);

      const result = service.listCompetitors();

      expect(result).toEqual(competitors);
      expect(competitorRepo.getActive).toHaveBeenCalled();
    });

    it('should return empty array when no active competitors', () => {
      competitorRepo.getActive.mockReturnValue([]);

      expect(service.listCompetitors()).toEqual([]);
    });
  });

  describe('removeCompetitor', () => {
    it('should delegate to repo.delete', () => {
      service.removeCompetitor(42);

      expect(competitorRepo.delete).toHaveBeenCalledWith(42);
    });
  });

  describe('recordPost', () => {
    it('should record a post with engagement object', () => {
      competitorRepo.addPost.mockReturnValue(7);

      const engagement = { likes: 100, retweets: 50, replies: 10 };
      const result = service.recordPost({
        competitorId: 1,
        platform: 'x',
        content: 'Big announcement!',
        url: 'https://example.com/post',
        engagement,
      });

      expect(result).toBe(7);
      expect(competitorRepo.addPost).toHaveBeenCalledWith({
        competitor_id: 1,
        platform: 'x',
        content: 'Big announcement!',
        url: 'https://example.com/post',
        engagement_json: JSON.stringify(engagement),
      });
    });

    it('should record a post without engagement', () => {
      competitorRepo.addPost.mockReturnValue(8);

      const result = service.recordPost({
        competitorId: 1,
        platform: 'instagram',
        content: 'A beautiful sunset',
      });

      expect(result).toBe(8);
      expect(competitorRepo.addPost).toHaveBeenCalledWith({
        competitor_id: 1,
        platform: 'instagram',
        content: 'A beautiful sunset',
        url: undefined,
        engagement_json: undefined,
      });
    });
  });

  describe('getCompetitorPosts', () => {
    it('should delegate to repo.getPosts', () => {
      const posts = [makeCompetitorPost({ id: 1 }), makeCompetitorPost({ id: 2 })];
      competitorRepo.getPosts.mockReturnValue(posts);

      const result = service.getCompetitorPosts(1, 25);

      expect(result).toEqual(posts);
      expect(competitorRepo.getPosts).toHaveBeenCalledWith(1, 25);
    });

    it('should pass undefined limit when not provided', () => {
      competitorRepo.getPosts.mockReturnValue([]);

      service.getCompetitorPosts(1);

      expect(competitorRepo.getPosts).toHaveBeenCalledWith(1, undefined);
    });
  });

  describe('analyzeCompetitor', () => {
    it('should return zeroed stats when no posts exist', () => {
      competitorRepo.getPosts.mockReturnValue([]);

      const analysis = service.analyzeCompetitor(1);

      expect(analysis.totalPosts).toBe(0);
      expect(analysis.postsPerWeek).toBe(0);
      expect(analysis.avgEngagement).toBe(0);
      expect(analysis.topPost).toBeNull();
      expect(analysis.platforms).toEqual([]);
      expect(analysis.contentPatterns).toEqual({
        avgLength: 0,
        hasHashtags: 0,
        hasQuestions: 0,
        hasUrls: 0,
      });
    });

    it('should compute correct stats with posts', () => {
      const posts: CompetitorPostRecord[] = [
        makeCompetitorPost({
          id: 1,
          platform: 'x',
          content: 'Check out #launch! Any questions?',
          engagement_json: JSON.stringify({ likes: 100, retweets: 50 }),
          detected_at: '2026-01-01T00:00:00.000Z',
        }),
        makeCompetitorPost({
          id: 2,
          platform: 'instagram',
          content: 'Visit https://example.com for more',
          engagement_json: JSON.stringify({ likes: 200, comments: 30 }),
          detected_at: '2026-01-08T00:00:00.000Z',
        }),
      ];
      competitorRepo.getPosts.mockReturnValue(posts);

      const analysis = service.analyzeCompetitor(1);

      expect(analysis.totalPosts).toBe(2);
      // Span is exactly 7 days = 1 week, so postsPerWeek = 2/1 = 2
      expect(analysis.postsPerWeek).toBe(2);
      // Engagement scores: post1 = 100+50 = 150, post2 = 200+30 = 230
      // avg = (150+230) / 2 = 190
      expect(analysis.avgEngagement).toBe(190);
      // Top post is the one with highest engagement score (post2: 230)
      expect(analysis.topPost!.id).toBe(2);
      // Platforms
      expect(analysis.platforms).toContain('x');
      expect(analysis.platforms).toContain('instagram');
      // Content patterns
      // avgLength: ('Check out #launch! Any questions?'.length + 'Visit https://example.com for more'.length) / 2
      const len1 = 'Check out #launch! Any questions?'.length; // 33
      const len2 = 'Visit https://example.com for more'.length; // 34
      expect(analysis.contentPatterns.avgLength).toBe(Math.round((len1 + len2) / 2));
      // hasHashtags: 1 of 2 = 50%
      expect(analysis.contentPatterns.hasHashtags).toBe(50);
      // hasQuestions: 1 of 2 = 50%
      expect(analysis.contentPatterns.hasQuestions).toBe(50);
      // hasUrls: 1 of 2 = 50%
      expect(analysis.contentPatterns.hasUrls).toBe(50);
    });

    it('should handle posts with null engagement_json', () => {
      const posts: CompetitorPostRecord[] = [
        makeCompetitorPost({
          id: 1,
          content: 'No engagement data here',
          engagement_json: null,
          detected_at: '2026-01-01T00:00:00.000Z',
        }),
      ];
      competitorRepo.getPosts.mockReturnValue(posts);

      const analysis = service.analyzeCompetitor(1);

      expect(analysis.totalPosts).toBe(1);
      expect(analysis.avgEngagement).toBe(0);
      expect(analysis.topPost!.id).toBe(1);
    });
  });

  describe('compareWithSelf', () => {
    it('should return competitor vs self comparison', () => {
      // Set up competitor posts for analyzeCompetitor
      const posts: CompetitorPostRecord[] = [
        makeCompetitorPost({
          id: 1,
          content: 'Competitor post',
          engagement_json: JSON.stringify({ likes: 50 }),
          detected_at: '2026-01-01T00:00:00.000Z',
        }),
        makeCompetitorPost({
          id: 2,
          content: 'Another post',
          engagement_json: JSON.stringify({ likes: 30 }),
          detected_at: '2026-01-08T00:00:00.000Z',
        }),
      ];
      competitorRepo.getPosts.mockReturnValue(posts);

      // Mock the db.prepare calls used by compareWithSelf for self-stats
      const mockGet = vi.fn();
      competitorRepo.db.prepare.mockReturnValue({ get: mockGet });

      // First call: self count
      mockGet.mockReturnValueOnce({ count: 10 });
      // Second call: self avg engagement
      mockGet.mockReturnValueOnce({ avg: 120.5 });
      // Third call: self date range
      mockGet.mockReturnValueOnce({ earliest: '2026-01-01T00:00:00.000Z', latest: '2026-01-22T00:00:00.000Z' });

      const comparison = service.compareWithSelf(1);

      // Competitor: totalPosts=2, postsPerWeek=2 (span=1 week), avgEngagement=(50+30)/2=40
      expect(comparison.competitor.totalPosts).toBe(2);
      expect(comparison.competitor.avgEngagement).toBe(40);
      expect(comparison.competitor.postsPerWeek).toBe(2);

      // Self: totalPosts=10, avgEngagement=120.5
      expect(comparison.self.totalPosts).toBe(10);
      expect(comparison.self.avgEngagement).toBe(120.5);
      // Self postsPerWeek: 21 days = 3 weeks, 10/3 = 3.33
      expect(comparison.self.postsPerWeek).toBe(3.33);

      // Verdict should mention higher engagement for self and higher posting freq
      expect(comparison.verdict).toContain('engagement');
      expect(comparison.verdict).toContain('post');
    });

    it('should handle zero self posts', () => {
      competitorRepo.getPosts.mockReturnValue([]);

      const mockGet = vi.fn();
      competitorRepo.db.prepare.mockReturnValue({ get: mockGet });

      // Self count = 0
      mockGet.mockReturnValueOnce({ count: 0 });
      // Self avg engagement = null (no rows)
      mockGet.mockReturnValueOnce({ avg: null });

      const comparison = service.compareWithSelf(1);

      expect(comparison.self.totalPosts).toBe(0);
      expect(comparison.self.avgEngagement).toBe(0);
      expect(comparison.self.postsPerWeek).toBe(0);
      expect(comparison.verdict).toBeDefined();
    });
  });
});
