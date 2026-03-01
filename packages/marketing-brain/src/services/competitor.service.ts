import type { CompetitorRepository, CompetitorRecord, CompetitorPostRecord } from '../db/repositories/competitor.repository.js';
import { getLogger } from '../utils/logger.js';

export interface CompetitorAnalysis {
  totalPosts: number;
  postsPerWeek: number;
  avgEngagement: number;
  topPost: CompetitorPostRecord | null;
  platforms: string[];
  contentPatterns: {
    avgLength: number;
    hasHashtags: number;
    hasQuestions: number;
    hasUrls: number;
  };
}

export interface CompetitorComparison {
  competitor: {
    totalPosts: number;
    avgEngagement: number;
    postsPerWeek: number;
  };
  self: {
    totalPosts: number;
    avgEngagement: number;
    postsPerWeek: number;
  };
  verdict: string;
}

export class CompetitorService {
  private logger = getLogger();

  constructor(private competitorRepo: CompetitorRepository) {}

  addCompetitor(input: { name: string; platform: string; handle: string; url?: string; notes?: string }): { competitorId: number; isNew: boolean } {
    const existing = this.competitorRepo.getByHandle(input.platform, input.handle);
    if (existing) {
      this.logger.info(`Competitor already exists: ${input.handle} on ${input.platform} (id=${existing.id})`);
      return { competitorId: existing.id, isNew: false };
    }

    const competitorId = this.competitorRepo.create(input);
    this.logger.info(`Competitor added: ${input.name} (${input.handle} on ${input.platform}, id=${competitorId})`);
    return { competitorId, isNew: true };
  }

  listCompetitors(): CompetitorRecord[] {
    return this.competitorRepo.getActive();
  }

  removeCompetitor(id: number): void {
    this.competitorRepo.delete(id);
    this.logger.info(`Competitor #${id} removed`);
  }

  recordPost(input: { competitorId: number; platform: string; content: string; url?: string; engagement?: Record<string, number> }): number {
    const engagementJson = input.engagement ? JSON.stringify(input.engagement) : undefined;
    const postId = this.competitorRepo.addPost({
      competitor_id: input.competitorId,
      platform: input.platform,
      content: input.content,
      url: input.url,
      engagement_json: engagementJson,
    });
    this.logger.info(`Competitor post recorded: competitor=#${input.competitorId}, post=#${postId}`);
    return postId;
  }

  getCompetitorPosts(competitorId: number, limit?: number): CompetitorPostRecord[] {
    return this.competitorRepo.getPosts(competitorId, limit);
  }

  analyzeCompetitor(competitorId: number): CompetitorAnalysis {
    const posts = this.competitorRepo.getPosts(competitorId, 1000);
    const totalPosts = posts.length;

    if (totalPosts === 0) {
      return {
        totalPosts: 0,
        postsPerWeek: 0,
        avgEngagement: 0,
        topPost: null,
        platforms: [],
        contentPatterns: { avgLength: 0, hasHashtags: 0, hasQuestions: 0, hasUrls: 0 },
      };
    }

    // Calculate posts per week
    const dates = posts.map(p => new Date(p.detected_at).getTime()).sort((a, b) => a - b);
    const spanMs = dates[dates.length - 1] - dates[0];
    const spanWeeks = Math.max(spanMs / (7 * 24 * 60 * 60 * 1000), 1);
    const postsPerWeek = Math.round((totalPosts / spanWeeks) * 100) / 100;

    // Parse engagement and find top post
    let totalEngagement = 0;
    let topPost: CompetitorPostRecord | null = null;
    let topEngagement = -1;

    for (const post of posts) {
      const eng = parseEngagement(post.engagement_json);
      const score = engagementScore(eng);
      totalEngagement += score;
      if (score > topEngagement) {
        topEngagement = score;
        topPost = post;
      }
    }

    const avgEngagement = Math.round((totalEngagement / totalPosts) * 100) / 100;

    // Platforms
    const platformSet = new Set(posts.map(p => p.platform));
    const platforms = [...platformSet];

    // Content patterns
    let totalLength = 0;
    let hashtagCount = 0;
    let questionCount = 0;
    let urlCount = 0;

    for (const post of posts) {
      totalLength += post.content.length;
      if (/#\w+/.test(post.content)) hashtagCount++;
      if (/\?/.test(post.content)) questionCount++;
      if (/https?:\/\//.test(post.content)) urlCount++;
    }

    const contentPatterns = {
      avgLength: Math.round(totalLength / totalPosts),
      hasHashtags: Math.round((hashtagCount / totalPosts) * 100),
      hasQuestions: Math.round((questionCount / totalPosts) * 100),
      hasUrls: Math.round((urlCount / totalPosts) * 100),
    };

    this.logger.info(`Analyzed competitor #${competitorId}: ${totalPosts} posts, ${postsPerWeek} posts/week, avg engagement ${avgEngagement}`);

    return {
      totalPosts,
      postsPerWeek,
      avgEngagement,
      topPost,
      platforms,
      contentPatterns,
    };
  }

  compareWithSelf(competitorId: number): CompetitorComparison {
    // Competitor stats
    const analysis = this.analyzeCompetitor(competitorId);

    // Self stats via direct queries on the posts table
    const db = (this.competitorRepo as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }).db;

    const selfCountRow = db.prepare(
      `SELECT COUNT(*) as count FROM posts WHERE status = 'published'`
    ).get() as { count: number };
    const selfTotalPosts = selfCountRow.count;

    const selfEngRow = db.prepare(
      `SELECT AVG(likes + comments*3 + shares*5 + clicks*2 + saves*4 + impressions*0.01) as avg FROM engagement e JOIN posts p ON p.id = e.post_id WHERE p.status = 'published'`
    ).get() as { avg: number | null };
    const selfAvgEngagement = Math.round((selfEngRow.avg ?? 0) * 100) / 100;

    // Self posts per week
    let selfPostsPerWeek = 0;
    if (selfTotalPosts > 0) {
      const selfDatesRow = db.prepare(
        `SELECT MIN(published_at) as earliest, MAX(published_at) as latest FROM posts WHERE status = 'published'`
      ).get() as { earliest: string | null; latest: string | null };

      if (selfDatesRow.earliest && selfDatesRow.latest) {
        const spanMs = new Date(selfDatesRow.latest).getTime() - new Date(selfDatesRow.earliest).getTime();
        const spanWeeks = Math.max(spanMs / (7 * 24 * 60 * 60 * 1000), 1);
        selfPostsPerWeek = Math.round((selfTotalPosts / spanWeeks) * 100) / 100;
      }
    }

    // Generate verdict
    const engDiff = selfAvgEngagement - analysis.avgEngagement;
    const freqDiff = selfPostsPerWeek - analysis.postsPerWeek;
    const verdictParts: string[] = [];

    if (engDiff > 0) {
      verdictParts.push(`Your avg engagement is ${Math.abs(Math.round(engDiff))} points higher than the competitor.`);
    } else if (engDiff < 0) {
      verdictParts.push(`The competitor's avg engagement is ${Math.abs(Math.round(engDiff))} points higher than yours.`);
    } else {
      verdictParts.push('Engagement levels are roughly equal.');
    }

    if (freqDiff > 0) {
      verdictParts.push(`You post ${Math.abs(Math.round(freqDiff * 10) / 10)} more times per week.`);
    } else if (freqDiff < 0) {
      verdictParts.push(`The competitor posts ${Math.abs(Math.round(freqDiff * 10) / 10)} more times per week.`);
    } else {
      verdictParts.push('Posting frequency is similar.');
    }

    const verdict = verdictParts.join(' ');

    this.logger.info(`Compared self with competitor #${competitorId}: verdict="${verdict}"`);

    return {
      competitor: {
        totalPosts: analysis.totalPosts,
        avgEngagement: analysis.avgEngagement,
        postsPerWeek: analysis.postsPerWeek,
      },
      self: {
        totalPosts: selfTotalPosts,
        avgEngagement: selfAvgEngagement,
        postsPerWeek: selfPostsPerWeek,
      },
      verdict,
    };
  }
}

function parseEngagement(json: string | null): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as Record<string, number>;
    }
    return {};
  } catch {
    return {};
  }
}

function engagementScore(eng: Record<string, number>): number {
  let score = 0;
  for (const value of Object.values(eng)) {
    if (typeof value === 'number') {
      score += value;
    }
  }
  return score;
}
