/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentGeneratorService } from '../../../src/services/content-generator.service.js';
import type { RuleRepository } from '../../../src/db/repositories/rule.repository.js';
import type { TemplateRepository } from '../../../src/db/repositories/template.repository.js';
import type { CalendarService } from '../../../src/services/calendar.service.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/learning/pattern-extractor.js', () => ({
  PatternExtractor: vi.fn().mockImplementation(() => ({
    extractPatterns: vi.fn().mockReturnValue([]),
  })),
}));

describe('ContentGeneratorService', () => {
  let service: ContentGeneratorService;
  let mockDb: {
    prepare: ReturnType<typeof vi.fn>;
  };
  let ruleRepo: {
    listActive: ReturnType<typeof vi.fn>;
  };
  let templateRepo: {
    listByPlatform: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
  };
  let calendarService: {
    suggestNextPostTime: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    };

    ruleRepo = {
      listActive: vi.fn().mockReturnValue([]),
    };

    templateRepo = {
      listByPlatform: vi.fn().mockReturnValue([]),
      listAll: vi.fn().mockReturnValue([]),
    };

    calendarService = {
      suggestNextPostTime: vi.fn().mockReturnValue({
        time: '2026-06-03T09:00:00Z',
        day: 'Wednesday',
        hour: 9,
        reason: 'Default recommended time',
        confidence: 0.3,
      }),
    };

    service = new ContentGeneratorService(
      mockDb as any,
      ruleRepo as unknown as RuleRepository,
      templateRepo as unknown as TemplateRepository,
      calendarService as unknown as CalendarService,
    );
  });

  describe('generateDraft', () => {
    it('should return a ContentDraft with all expected fields', () => {
      const draft = service.generateDraft('x');

      expect(draft).toHaveProperty('platform', 'x');
      expect(draft).toHaveProperty('suggestedFormat');
      expect(draft).toHaveProperty('suggestedTime');
      expect(draft.suggestedTime).toHaveProperty('time');
      expect(draft.suggestedTime).toHaveProperty('day');
      expect(draft.suggestedTime).toHaveProperty('hour');
      expect(draft.suggestedTime).toHaveProperty('reason');
      expect(draft.suggestedTime).toHaveProperty('confidence');
      expect(draft).toHaveProperty('contentGuidelines');
      expect(draft).toHaveProperty('templateSuggestion');
      expect(draft).toHaveProperty('hashtagSuggestions');
      expect(draft).toHaveProperty('estimatedEngagement');
      expect(draft).toHaveProperty('patterns');
      expect(draft).toHaveProperty('confidence');
    });

    it('should use calendarService.suggestNextPostTime for suggested time', () => {
      calendarService.suggestNextPostTime.mockReturnValue({
        time: '2026-06-05T14:00:00Z',
        day: 'Friday',
        hour: 14,
        reason: 'Afternoon posts perform best',
        confidence: 0.85,
      });

      const draft = service.generateDraft('linkedin');

      expect(calendarService.suggestNextPostTime).toHaveBeenCalledWith('linkedin');
      expect(draft.suggestedTime.time).toBe('2026-06-05T14:00:00Z');
      expect(draft.suggestedTime.day).toBe('Friday');
      expect(draft.suggestedTime.hour).toBe(14);
      expect(draft.suggestedTime.reason).toBe('Afternoon posts perform best');
      expect(draft.suggestedTime.confidence).toBe(0.85);
    });

    it('should use ruleRepo.listActive for content guidelines', () => {
      ruleRepo.listActive.mockReturnValue([
        { id: 1, pattern: 'use_hashtags', recommendation: 'Always include hashtags', confidence: 0.9, trigger_count: 5, success_count: 4, active: 1 },
        { id: 2, pattern: 'short_content', recommendation: 'Keep posts under 280 chars', confidence: 0.7, trigger_count: 3, success_count: 2, active: 1 },
      ]);

      const draft = service.generateDraft('x');

      expect(ruleRepo.listActive).toHaveBeenCalled();
      expect(draft.contentGuidelines).toHaveLength(2);
      expect(draft.contentGuidelines[0]).toContain('use_hashtags');
      expect(draft.contentGuidelines[0]).toContain('Always include hashtags');
      expect(draft.contentGuidelines[0]).toContain('90%');
      expect(draft.contentGuidelines[1]).toContain('short_content');
    });

    it('should pick a platform-specific template from templateRepo', () => {
      templateRepo.listByPlatform.mockReturnValue([
        { id: 1, name: 'Thread Template', structure: 'Hook -> Body -> CTA', example: 'Example thread', platform: 'x', avg_engagement: 100, use_count: 5 },
      ]);

      const draft = service.generateDraft('x');

      expect(templateRepo.listByPlatform).toHaveBeenCalledWith('x', 1);
      expect(draft.templateSuggestion).not.toBeNull();
      expect(draft.templateSuggestion!.name).toBe('Thread Template');
      expect(draft.templateSuggestion!.structure).toBe('Hook -> Body -> CTA');
      expect(draft.templateSuggestion!.example).toBe('Example thread');
    });

    it('should fall back to listAll when no platform-specific template exists', () => {
      templateRepo.listByPlatform.mockReturnValue([]);
      templateRepo.listAll.mockReturnValue([
        { id: 2, name: 'Generic Template', structure: 'Intro -> Content', example: null, platform: null, avg_engagement: 50, use_count: 2 },
      ]);

      const draft = service.generateDraft('bluesky');

      expect(templateRepo.listByPlatform).toHaveBeenCalledWith('bluesky', 1);
      expect(templateRepo.listAll).toHaveBeenCalledWith(1);
      expect(draft.templateSuggestion).not.toBeNull();
      expect(draft.templateSuggestion!.name).toBe('Generic Template');
    });

    it('should return null templateSuggestion when no templates exist', () => {
      templateRepo.listByPlatform.mockReturnValue([]);
      templateRepo.listAll.mockReturnValue([]);

      const draft = service.generateDraft('x');

      expect(draft.templateSuggestion).toBeNull();
    });

    it('should return low confidence and estimatedEngagement when no patterns exist', () => {
      // PatternExtractor mock already returns [] by default
      const draft = service.generateDraft('x');

      expect(draft.confidence).toBe(0);
      expect(draft.estimatedEngagement).toBe('low');
      expect(draft.patterns).toEqual([]);
    });

    it('should default suggestedFormat to text when no format patterns exist', () => {
      const draft = service.generateDraft('x');

      expect(draft.suggestedFormat).toBe('text');
    });
  });

  describe('suggestHashtags', () => {
    it('should return hashtags sorted by average engagement descending', () => {
      const mockAll = vi.fn().mockReturnValue([
        { hashtags: '#marketing,#growth', score: 200 },
        { hashtags: '#marketing,#seo', score: 100 },
        { hashtags: '#growth,#tips', score: 150 },
      ]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const suggestions = service.suggestHashtags('x', 10);

      // #marketing: totalScore = 200 + 100 = 300, count = 2, avg = 150
      // #growth: totalScore = 200 + 150 = 350, count = 2, avg = 175
      // #seo: totalScore = 100, count = 1, avg = 100
      // #tips: totalScore = 150, count = 1, avg = 150
      // Sorted by avg desc: #growth (175), #marketing (150), #tips (150), #seo (100)
      expect(suggestions).toHaveLength(4);
      expect(suggestions[0]!.hashtag).toBe('#growth');
      expect(suggestions[0]!.avgEngagement).toBe(175);
      expect(suggestions[1]!.hashtag).toBe('#marketing');
      expect(suggestions[1]!.avgEngagement).toBe(150);
    });

    it('should return empty array when no hashtag data exists', () => {
      const mockAll = vi.fn().mockReturnValue([]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const suggestions = service.suggestHashtags('reddit');

      expect(suggestions).toEqual([]);
    });

    it('should respect the limit parameter', () => {
      const mockAll = vi.fn().mockReturnValue([
        { hashtags: '#a', score: 300 },
        { hashtags: '#b', score: 200 },
        { hashtags: '#c', score: 100 },
      ]);
      mockDb.prepare.mockReturnValue({ all: mockAll });

      const suggestions = service.suggestHashtags('x', 2);

      expect(suggestions).toHaveLength(2);
      expect(suggestions[0]!.hashtag).toBe('#a');
      expect(suggestions[1]!.hashtag).toBe('#b');
    });
  });
});
