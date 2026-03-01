import { describe, it, expect } from 'vitest';
import { scoreRepo, classifyLevel, classifyWithHysteresis, classifyPhase, scoreCrypto } from '../../../src/scanner/signal-scorer.js';
import type { ScannedRepo, HnMention } from '../../../src/scanner/types.js';

function makeRepo(overrides: Partial<ScannedRepo> = {}): Pick<ScannedRepo, 'current_stars' | 'current_forks' | 'current_watchers' | 'current_issues' | 'description' | 'topics' | 'language' | 'star_velocity_24h' | 'star_velocity_7d' | 'star_acceleration' | 'created_at' | 'name'> {
  return {
    name: 'test-repo',
    current_stars: 1000,
    current_forks: 100,
    current_watchers: 50,
    current_issues: 30,
    description: 'A test repository for unit tests',
    topics: ['typescript', 'testing'],
    language: 'TypeScript',
    star_velocity_24h: 10,
    star_velocity_7d: 50,
    star_acceleration: 2,
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('scoreRepo', () => {
  it('should return a score breakdown with all components', () => {
    const result = scoreRepo(makeRepo());
    expect(result).toHaveProperty('momentum');
    expect(result).toHaveProperty('technical');
    expect(result).toHaveProperty('cross_platform');
    expect(result).toHaveProperty('influencer');
    expect(result).toHaveProperty('timing');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('phase');
  });

  it('should score higher for repos with high star velocity', () => {
    const slow = scoreRepo(makeRepo({ star_velocity_24h: 1, star_velocity_7d: 5 }));
    const fast = scoreRepo(makeRepo({ star_velocity_24h: 80, star_velocity_7d: 400 }));
    expect(fast.momentum).toBeGreaterThan(slow.momentum);
    expect(fast.total).toBeGreaterThan(slow.total);
  });

  it('should score higher for repos with more stars', () => {
    const small = scoreRepo(makeRepo({ current_stars: 10 }));
    const big = scoreRepo(makeRepo({ current_stars: 10000 }));
    expect(big.momentum).toBeGreaterThan(small.momentum);
  });

  it('should score higher for repos with hot language', () => {
    const rust = scoreRepo(makeRepo({ language: 'Rust' }));
    const cobol = scoreRepo(makeRepo({ language: 'COBOL' }));
    expect(rust.technical).toBeGreaterThan(cobol.technical);
  });

  it('should score timing for hot keywords', () => {
    const aiRepo = scoreRepo(makeRepo({ name: 'ai-agent', topics: ['llm', 'mcp'] }));
    const plainRepo = scoreRepo(makeRepo({ name: 'utils', topics: ['utility'] }));
    expect(aiRepo.timing).toBeGreaterThan(plainRepo.timing);
  });

  it('should score cross-platform when HN mentions exist', () => {
    const mentions: Pick<HnMention, 'score' | 'comment_count'>[] = [
      { score: 200, comment_count: 150 },
      { score: 50, comment_count: 30 },
    ];
    const withHn = scoreRepo(makeRepo(), mentions);
    const withoutHn = scoreRepo(makeRepo());
    expect(withHn.cross_platform).toBeGreaterThan(withoutHn.cross_platform);
    expect(withoutHn.cross_platform).toBe(0);
  });

  it('should score influencer when count > 0', () => {
    const withInfluencer = scoreRepo(makeRepo(), [], 10);
    const without = scoreRepo(makeRepo(), [], 0);
    expect(withInfluencer.influencer).toBeGreaterThan(without.influencer);
    expect(without.influencer).toBe(0);
  });

  it('should cap total at 100', () => {
    const maxRepo = makeRepo({
      current_stars: 100000,
      star_velocity_24h: 500,
      star_velocity_7d: 3000,
      star_acceleration: 100,
      current_forks: 5000,
      current_watchers: 10000,
      current_issues: 500,
      description: 'An incredibly detailed description that covers all aspects of this amazing project',
      topics: ['ai', 'llm', 'agent', 'mcp', 'typescript', 'rust'],
      language: 'TypeScript',
      name: 'ai-agent',
    });
    const mentions: Pick<HnMention, 'score' | 'comment_count'>[] = [
      { score: 1000, comment_count: 500 },
    ];
    const result = scoreRepo(maxRepo, mentions, 50);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it('should handle zero-star repos gracefully', () => {
    const result = scoreRepo(makeRepo({ current_stars: 0, current_forks: 0, current_watchers: 0 }));
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.momentum).toBeGreaterThanOrEqual(0);
  });

  it('should handle null description/topics', () => {
    const result = scoreRepo(makeRepo({ description: null, topics: [] }));
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});

describe('classifyLevel', () => {
  it('should classify breakout for score >= 70', () => {
    expect(classifyLevel(70)).toBe('breakout');
    expect(classifyLevel(85)).toBe('breakout');
    expect(classifyLevel(100)).toBe('breakout');
  });

  it('should classify signal for score >= 55', () => {
    expect(classifyLevel(55)).toBe('signal');
    expect(classifyLevel(69)).toBe('signal');
  });

  it('should classify watch for score >= 30', () => {
    expect(classifyLevel(30)).toBe('watch');
    expect(classifyLevel(54)).toBe('watch');
  });

  it('should classify noise for score < 30', () => {
    expect(classifyLevel(0)).toBe('noise');
    expect(classifyLevel(29)).toBe('noise');
  });
});

describe('classifyWithHysteresis', () => {
  it('should immediately upgrade to higher level', () => {
    const result = classifyWithHysteresis(75, 'signal', 'signal', '2025-01-01T00:00:00Z');
    expect(result.level).toBe('breakout');
    expect(result.peak).toBe('breakout');
  });

  it('should hold level during hysteresis period', () => {
    const recentPeak = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    const result = classifyWithHysteresis(40, 'signal', 'signal', recentPeak, 2);
    expect(result.level).toBe('signal'); // Held, not downgraded to watch
  });

  it('should downgrade after hold period expires', () => {
    const oldPeak = new Date(Date.now() - 5 * 86_400_000).toISOString(); // 5 days ago
    const result = classifyWithHysteresis(40, 'signal', 'signal', oldPeak, 2);
    expect(result.level).toBe('watch');
  });

  it('should preserve peak level in history', () => {
    const result = classifyWithHysteresis(40, 'watch', 'breakout', '2025-01-01T00:00:00Z');
    expect(result.peak).toBe('breakout');
  });

  it('should handle null peakSince', () => {
    const result = classifyWithHysteresis(55, 'noise', null, null);
    expect(result.level).toBe('signal');
    expect(result.peakSince).toBeTruthy();
  });
});

describe('classifyPhase', () => {
  it('should classify discovery for < 500 stars', () => {
    expect(classifyPhase(0)).toBe('discovery');
    expect(classifyPhase(499)).toBe('discovery');
  });

  it('should classify early_adopter for 500-4999 stars', () => {
    expect(classifyPhase(500)).toBe('early_adopter');
    expect(classifyPhase(4999)).toBe('early_adopter');
  });

  it('should classify hype for 5000-14999 stars', () => {
    expect(classifyPhase(5000)).toBe('hype');
    expect(classifyPhase(14999)).toBe('hype');
  });

  it('should classify mainstream for 15000-29999 stars', () => {
    expect(classifyPhase(15000)).toBe('mainstream');
    expect(classifyPhase(29999)).toBe('mainstream');
  });

  it('should classify commodity for >= 30000 stars', () => {
    expect(classifyPhase(30000)).toBe('commodity');
    expect(classifyPhase(100000)).toBe('commodity');
  });
});

describe('scoreCrypto', () => {
  it('should return score and level', () => {
    const result = scoreCrypto(5, 10, 1_000_000, 1_000_000_000);
    expect(result.score).toBeGreaterThan(0);
    expect(result.level).toBeTruthy();
  });

  it('should score higher for larger price changes', () => {
    const small = scoreCrypto(1, 2, 100000, 1000000);
    const big = scoreCrypto(15, 30, 100000, 1000000);
    expect(big.score).toBeGreaterThan(small.score);
  });

  it('should handle null values', () => {
    const result = scoreCrypto(null, null, null, null);
    expect(result.score).toBe(0);
    expect(result.level).toBe('noise');
  });

  it('should cap at 100', () => {
    const result = scoreCrypto(50, 100, 1e12, 1e12);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
