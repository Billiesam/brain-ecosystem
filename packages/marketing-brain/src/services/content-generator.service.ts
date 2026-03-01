import type Database from 'better-sqlite3';
import { PatternExtractor, type ContentPattern } from '../learning/pattern-extractor.js';
import type { RuleRepository } from '../db/repositories/rule.repository.js';
import type { TemplateRepository } from '../db/repositories/template.repository.js';
import type { CalendarService } from './calendar.service.js';
import { getLogger } from '../utils/logger.js';

export interface ContentDraft {
  platform: string;
  suggestedFormat: string;
  suggestedTime: { time: string; day: string; hour: number; reason: string; confidence: number };
  contentGuidelines: string[];
  templateSuggestion: { name: string; structure: string; example: string | null } | null;
  hashtagSuggestions: string[];
  estimatedEngagement: 'low' | 'medium' | 'high';
  patterns: PatternSummary[];
  confidence: number;
}

export interface PatternSummary {
  pattern: string;
  category: string;
  multiplier: number;
  confidence: number;
}

export interface HashtagSuggestion {
  hashtag: string;
  frequency: number;
  avgEngagement: number;
}

export class ContentGeneratorService {
  private logger = getLogger();
  private patternExtractor: PatternExtractor;

  constructor(
    private db: Database.Database,
    private ruleRepo: RuleRepository,
    private templateRepo: TemplateRepository,
    private calendarService: CalendarService,
  ) {
    this.patternExtractor = new PatternExtractor(db);
  }

  // ---------------------------------------------------------------------------
  // generateDraft
  // ---------------------------------------------------------------------------

  generateDraft(platform: string, topic?: string): ContentDraft {
    this.logger.info(`ContentGenerator: generating draft for platform="${platform}" topic="${topic ?? ''}"`);

    // 1. Extract learned patterns
    const allPatterns = this.patternExtractor.extractPatterns();

    // 2. Best format for platform (look at format-category patterns, pick highest multiplier)
    const suggestedFormat = this.pickBestFormat(allPatterns, platform);

    // 3. Suggested posting time
    const suggestedTime = this.calendarService.suggestNextPostTime(platform);

    // 4. Content guidelines from active marketing rules
    const activeRules = this.ruleRepo.listActive();
    const contentGuidelines = activeRules.map(
      (r) => `${r.pattern}: ${r.recommendation} (confidence ${(r.confidence * 100).toFixed(0)}%)`,
    );

    // 5. Best template for this platform
    const templateSuggestion = this.pickBestTemplate(platform);

    // 6. Hashtag suggestions from historical engagement data
    const hashtagSuggestions = this.getTopHashtags(platform, 5);

    // 7. Estimate engagement level based on high-confidence pattern alignment
    const estimatedEngagement = this.estimateEngagement(allPatterns, platform);

    // 8. Overall confidence (average of pattern confidences, or 0 if none)
    const confidence =
      allPatterns.length > 0
        ? allPatterns.reduce((sum, p) => sum + p.confidence, 0) / allPatterns.length
        : 0;

    // 9. Build pattern summaries
    const patterns: PatternSummary[] = allPatterns.map((p) => ({
      pattern: p.pattern,
      category: p.category,
      multiplier: p.multiplier,
      confidence: p.confidence,
    }));

    const draft: ContentDraft = {
      platform,
      suggestedFormat,
      suggestedTime: {
        time: suggestedTime.time,
        day: suggestedTime.day,
        hour: suggestedTime.hour,
        reason: suggestedTime.reason,
        confidence: suggestedTime.confidence,
      },
      contentGuidelines,
      templateSuggestion,
      hashtagSuggestions,
      estimatedEngagement,
      patterns,
      confidence,
    };

    this.logger.info(
      `ContentGenerator: draft ready – format="${suggestedFormat}", ` +
        `engagement="${estimatedEngagement}", patterns=${patterns.length}, ` +
        `confidence=${confidence.toFixed(2)}`,
    );

    return draft;
  }

  // ---------------------------------------------------------------------------
  // suggestHashtags
  // ---------------------------------------------------------------------------

  suggestHashtags(platform: string, limit: number = 10): HashtagSuggestion[] {
    this.logger.info(`ContentGenerator: suggesting hashtags for platform="${platform}" limit=${limit}`);

    const rows = this.db
      .prepare(
        `SELECT p.hashtags, AVG(e.likes + e.comments*3 + e.shares*5) as score
         FROM posts p JOIN engagement e ON e.post_id = p.id
         WHERE p.platform = ? AND p.hashtags IS NOT NULL
         GROUP BY p.hashtags
         ORDER BY score DESC LIMIT 50`,
      )
      .all(platform) as Array<{ hashtags: string; score: number }>;

    // Parse individual hashtags and aggregate
    const tagMap = new Map<string, { totalScore: number; count: number }>();

    for (const row of rows) {
      const tags = this.parseHashtags(row.hashtags);
      for (const tag of tags) {
        const existing = tagMap.get(tag);
        if (existing) {
          existing.totalScore += row.score;
          existing.count += 1;
        } else {
          tagMap.set(tag, { totalScore: row.score, count: 1 });
        }
      }
    }

    const suggestions: HashtagSuggestion[] = [];
    for (const [hashtag, data] of tagMap.entries()) {
      suggestions.push({
        hashtag,
        frequency: data.count,
        avgEngagement: data.totalScore / data.count,
      });
    }

    // Sort by average engagement descending
    suggestions.sort((a, b) => b.avgEngagement - a.avgEngagement);

    return suggestions.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pickBestFormat(patterns: ContentPattern[], _platform: string): string {
    const formatPatterns = patterns
      .filter((p) => p.category === 'format')
      .sort((a, b) => b.multiplier - a.multiplier);

    if (formatPatterns.length === 0) return 'text';

    // Extract format name from pattern string (e.g. "video posts outperform…")
    const best = formatPatterns[0]!;
    const match = best.pattern.match(/^(\w+)\s+posts?\s/i);
    if (match) return match[1]!.toLowerCase();

    return 'text';
  }

  private pickBestTemplate(platform: string): ContentDraft['templateSuggestion'] {
    // Prefer platform-specific templates, fall back to all templates
    let templates = this.templateRepo.listByPlatform(platform, 1);
    if (templates.length === 0) {
      templates = this.templateRepo.listAll(1);
    }

    if (templates.length === 0) return null;

    const t = templates[0]!;
    return {
      name: t.name,
      structure: t.structure,
      example: t.example,
    };
  }

  private getTopHashtags(platform: string, limit: number): string[] {
    const suggestions = this.suggestHashtags(platform, limit);
    return suggestions.map((s) => s.hashtag);
  }

  private estimateEngagement(patterns: ContentPattern[], _platform: string): 'low' | 'medium' | 'high' {
    // Count patterns with high confidence (>= 0.7) and strong multiplier (>= 1.5)
    const strongPatterns = patterns.filter(
      (p) => p.confidence >= 0.7 && p.multiplier >= 1.5,
    );

    if (strongPatterns.length >= 3) return 'high';
    if (strongPatterns.length >= 1) return 'medium';
    return 'low';
  }

  private parseHashtags(raw: string): string[] {
    if (!raw) return [];
    // Split on commas, spaces, or both; normalise to lowercase
    return raw
      .split(/[\s,]+/)
      .map((tag) => tag.trim().toLowerCase())
      .filter((tag) => tag.length > 0)
      .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`));
  }
}
