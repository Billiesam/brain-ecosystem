/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformAdapterService } from '../../../src/services/platform-adapter.service.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('PlatformAdapterService', () => {
  let service: PlatformAdapterService;

  beforeEach(() => {
    service = new PlatformAdapterService();
  });

  // ───────────────────────────── adaptForPlatform ─────────────────────────────

  describe('adaptForPlatform', () => {
    it('should not truncate short content within X 280-char limit', () => {
      const shortContent = 'Hello world! This is a short tweet.';
      const result = service.adaptForPlatform(shortContent, 'x');

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(shortContent);
      expect(result.threadParts).toBeNull();
      expect(result.platform).toBe('x');
    });

    it('should split long content into a thread on X (supports threads)', () => {
      // Build content that exceeds 280 characters using multiple sentences
      const sentences = Array.from({ length: 15 }, (_, i) => `This is sentence number ${i + 1} and it adds meaningful length to the post.`);
      const longContent = sentences.join(' ');

      expect(longContent.length).toBeGreaterThan(280);

      const result = service.adaptForPlatform(longContent, 'x');

      expect(result.threadParts).not.toBeNull();
      expect(result.threadParts!.length).toBeGreaterThan(1);
      // Each thread part should have a [n/N] indicator
      for (const part of result.threadParts!) {
        expect(part).toMatch(/\[\d+\/\d+\]$/);
      }
      expect(result.notes).toEqual(
        expect.arrayContaining([expect.stringContaining('thread')]),
      );
    });

    it('should not truncate long content on LinkedIn (3000 char limit)', () => {
      // 500 characters is well within LinkedIn's 3000 limit
      const content = 'A'.repeat(500);
      const result = service.adaptForPlatform(content, 'linkedin');

      expect(result.truncated).toBe(false);
      expect(result.content).toContain('A'.repeat(500));
      expect(result.threadParts).toBeNull();
    });

    it('should trim hashtags to platform max when too many are provided', () => {
      const content = 'Great post #one #two #three #four #five #six';
      // X allows max 3 hashtags
      const result = service.adaptForPlatform(content, 'x');

      const remainingHashtags = result.content.match(/#\w+/g) ?? [];
      expect(remainingHashtags.length).toBeLessThanOrEqual(3);
      expect(result.notes).toEqual(
        expect.arrayContaining([expect.stringContaining('Reduced hashtags')]),
      );
    });

    it('should move hashtags to end when hashtagStrategy is "end" (linkedin)', () => {
      const content = 'Check out this #amazing article about #tech today';
      const result = service.adaptForPlatform(content, 'linkedin');

      // Hashtags should be at the very end, separated by a blank line
      const lines = result.content.split('\n');
      const lastLine = lines[lines.length - 1].trim();
      expect(lastLine).toMatch(/#\w+/);

      // The main body text should not contain hashtags
      const bodyWithoutHashtagLine = lines.slice(0, -2).join('\n');
      expect(bodyWithoutHashtagLine).not.toMatch(/#\w+/);
    });

    it('should remove all hashtags when hashtagStrategy is "none" (reddit)', () => {
      const content = 'Great discussion #coding #javascript #webdev';
      const result = service.adaptForPlatform(content, 'reddit');

      expect(result.content).not.toMatch(/#\w+/);
      expect(result.hashtags).toBeNull();
      expect(result.notes).toEqual(
        expect.arrayContaining([expect.stringContaining('Hashtags removed')]),
      );
    });

    it('should never truncate normal content on Reddit (40000 char limit)', () => {
      const longContent = 'Word '.repeat(2000); // ~10000 chars
      const result = service.adaptForPlatform(longContent, 'reddit');

      expect(result.truncated).toBe(false);
      expect(result.threadParts).toBeNull();
    });

    it('should create thread parts with [n/N] indicators', () => {
      // Use a platform that supports threads (x) with content that forces splitting
      const sentences = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1} with enough words to fill space.`);
      const longContent = sentences.join(' ');

      const result = service.adaptForPlatform(longContent, 'x');

      expect(result.threadParts).not.toBeNull();
      const totalParts = result.threadParts!.length;
      result.threadParts!.forEach((part, index) => {
        expect(part).toContain(`[${index + 1}/${totalParts}]`);
      });
    });

    it('should return the first bestFormat as default format for each platform', () => {
      const content = 'Simple post';

      const xResult = service.adaptForPlatform(content, 'x');
      expect(xResult.format).toBe('text'); // x bestFormats[0] = 'text'

      const linkedinResult = service.adaptForPlatform(content, 'linkedin');
      expect(linkedinResult.format).toBe('article'); // linkedin bestFormats[0] = 'article'

      const redditResult = service.adaptForPlatform(content, 'reddit');
      expect(redditResult.format).toBe('text'); // reddit bestFormats[0] = 'text'
    });

    it('should use sourceFormat when it matches a platform bestFormat', () => {
      const content = 'Simple post';

      // 'carousel' is in linkedin bestFormats → should be used
      const result = service.adaptForPlatform(content, 'linkedin', 'carousel');
      expect(result.format).toBe('carousel');

      // 'poll' is in x bestFormats → should be used
      const xResult = service.adaptForPlatform(content, 'x', 'poll');
      expect(xResult.format).toBe('poll');

      // 'article' is NOT in x bestFormats → should fall back to default
      const xFallback = service.adaptForPlatform(content, 'x', 'article');
      expect(xFallback.format).toBe('text');
    });

    it('should truncate with ellipsis on platforms that do not support threads', () => {
      // Mastodon: 500 char limit, no threads
      const longContent = 'A'.repeat(600);
      const result = service.adaptForPlatform(longContent, 'mastodon');

      expect(result.truncated).toBe(true);
      expect(result.content).toHaveLength(500);
      expect(result.content.endsWith('...')).toBe(true);
      expect(result.threadParts).toBeNull();
    });
  });

  // ───────────────────────────── adaptCrossPlatform ───────────────────────────

  describe('adaptCrossPlatform', () => {
    it('should adapt to all other platforms when no target specified', () => {
      const content = 'Cross platform content';
      const result = service.adaptCrossPlatform(content, 'x');

      // Should adapt to every known platform except the source ('x')
      const adaptedPlatforms = result.adaptations.map(a => a.platform);
      expect(adaptedPlatforms).not.toContain('x');
      // linkedin, reddit, bluesky, mastodon, threads = 5 platforms
      expect(result.adaptations.length).toBe(5);
      expect(adaptedPlatforms).toContain('linkedin');
      expect(adaptedPlatforms).toContain('reddit');
      expect(adaptedPlatforms).toContain('bluesky');
      expect(adaptedPlatforms).toContain('mastodon');
      expect(adaptedPlatforms).toContain('threads');
    });

    it('should adapt only to specified target platforms', () => {
      const content = 'Targeted adaptation';
      const result = service.adaptCrossPlatform(content, 'x', ['linkedin', 'reddit']);

      expect(result.adaptations.length).toBe(2);
      const platforms = result.adaptations.map(a => a.platform);
      expect(platforms).toContain('linkedin');
      expect(platforms).toContain('reddit');
    });

    it('should preserve original content in result', () => {
      const content = 'Original content here #tag';
      const result = service.adaptCrossPlatform(content, 'linkedin', ['x']);

      expect(result.original.platform).toBe('linkedin');
      expect(result.original.content).toBe(content);
    });

    it('should include correct platform name in each adaptation', () => {
      const content = 'Multi-platform post';
      const result = service.adaptCrossPlatform(content, 'x', ['linkedin', 'reddit', 'bluesky']);

      expect(result.adaptations[0].platform).toBe('linkedin');
      expect(result.adaptations[1].platform).toBe('reddit');
      expect(result.adaptations[2].platform).toBe('bluesky');
    });
  });

  // ───────────────────────────── getPlatformConfig ────────────────────────────

  describe('getPlatformConfig', () => {
    it('should return correct config for known platforms', () => {
      const xConfig = service.getPlatformConfig('x');
      expect(xConfig.name).toBe('X');
      expect(xConfig.maxLength).toBe(280);
      expect(xConfig.supportsThreads).toBe(true);

      const linkedinConfig = service.getPlatformConfig('linkedin');
      expect(linkedinConfig.name).toBe('LinkedIn');
      expect(linkedinConfig.maxLength).toBe(3000);

      const redditConfig = service.getPlatformConfig('reddit');
      expect(redditConfig.name).toBe('Reddit');
      expect(redditConfig.maxLength).toBe(40000);
    });

    it('should return generic config for unknown platform', () => {
      const config = service.getPlatformConfig('myspace');

      expect(config.name).toBe('myspace');
      expect(config.maxLength).toBe(5000);
      expect(config.hashtagStrategy).toBe('end');
      expect(config.bestFormats).toEqual(['text']);
    });

    it('should have correct maxLength values for known platforms', () => {
      expect(service.getPlatformConfig('x').maxLength).toBe(280);
      expect(service.getPlatformConfig('linkedin').maxLength).toBe(3000);
      expect(service.getPlatformConfig('reddit').maxLength).toBe(40000);
      expect(service.getPlatformConfig('bluesky').maxLength).toBe(300);
      expect(service.getPlatformConfig('mastodon').maxLength).toBe(500);
      expect(service.getPlatformConfig('threads').maxLength).toBe(500);
    });
  });
});
