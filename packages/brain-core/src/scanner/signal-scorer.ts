import type { ScannedRepo, ScoreBreakdown, SignalLevel, RepoPhase, HnMention } from './types.js';

// ── Hot Keywords for Timing Score ────────────────────────
const HOT_KEYWORDS = [
  'ai', 'llm', 'agent', 'mcp', 'rust', 'wasm', 'rag',
  'gpt', 'claude', 'copilot', 'transformer', 'diffusion',
  'vector', 'embedding', 'autonomous', 'serverless', 'edge',
];

// ── Signal Level Thresholds ──────────────────────────────
const BREAKOUT_THRESHOLD = 70;
const SIGNAL_THRESHOLD = 55;
const WATCH_THRESHOLD = 30;

// ── Phase Boundaries ─────────────────────────────────────
const PHASE_EARLY = 500;
const PHASE_HYPE = 5000;
const PHASE_MAINSTREAM = 15000;
const PHASE_COMMODITY = 30000;

/**
 * Score a repo's signal strength (0-100).
 * Port of reposignal Python scoring logic.
 *
 * Components:
 *   Momentum    (0-35): star baseline + velocity + acceleration + relative growth
 *   Technical   (0-35): description + topics + issues + forks + language + activity + watchers
 *   CrossPlatform (0-15): HN score + mentions + comments
 *   Influencer  (0-15): count + quality + diversity
 *   Timing      (0-5): hot keyword matches
 */
export function scoreRepo(
  repo: Pick<ScannedRepo, 'current_stars' | 'current_forks' | 'current_watchers' | 'current_issues' | 'description' | 'topics' | 'language' | 'star_velocity_24h' | 'star_velocity_7d' | 'star_acceleration' | 'created_at' | 'name'>,
  hnMentions: Pick<HnMention, 'score' | 'comment_count'>[] = [],
  influencerCount = 0,
): ScoreBreakdown {
  const momentum = scoreMomentum(repo);
  const technical = scoreTechnical(repo);
  const cross_platform = scoreCrossPlatform(hnMentions);
  const influencer = scoreInfluencer(influencerCount);
  const timing = scoreTiming(repo);
  const total = Math.min(100, momentum + technical + cross_platform + influencer + timing);
  const level = classifyLevel(total);
  const phase = classifyPhase(repo.current_stars);

  return { momentum, technical, cross_platform, influencer, timing, total, level, phase };
}

/** Momentum (0-35): star_baseline + velocity + acceleration + relative_growth */
function scoreMomentum(repo: Pick<ScannedRepo, 'current_stars' | 'star_velocity_24h' | 'star_velocity_7d' | 'star_acceleration'>): number {
  // Star baseline: log10(stars), max 10 points
  const starBase = Math.min(10, repo.current_stars > 0 ? Math.log10(repo.current_stars) * 2 : 0);

  // Velocity: 50% weight, normalized (100 stars/day = max)
  const vel24h = Math.min(1, repo.star_velocity_24h / 100);
  const vel7d = Math.min(1, repo.star_velocity_7d / 500);
  const velocityScore = (vel24h * 0.6 + vel7d * 0.4) * 17.5; // max 17.5

  // Acceleration bonus: 20% weight
  const accelBonus = Math.min(5, Math.max(0, repo.star_acceleration * 2.5));

  // Relative growth: velocity / stars ratio, 30% weight
  const relativeGrowth = repo.current_stars > 0
    ? Math.min(2.5, (repo.star_velocity_7d / repo.current_stars) * 50)
    : 0;

  return Math.min(35, starBase + velocityScore + accelBonus + relativeGrowth);
}

/** Technical (0-35): description + topics + issue_ratio + fork_ratio + language + activity + watchers */
function scoreTechnical(repo: Pick<ScannedRepo, 'description' | 'topics' | 'current_issues' | 'current_stars' | 'current_forks' | 'current_watchers' | 'language'>): number {
  let score = 0;

  // Description quality (0-5)
  const descLen = (repo.description ?? '').length;
  score += Math.min(5, descLen / 30);

  // Topics count (0-5)
  const topicCount = repo.topics?.length ?? 0;
  score += Math.min(5, topicCount);

  // Issue ratio: some issues = healthy (0-5)
  if (repo.current_stars > 0) {
    const issueRatio = repo.current_issues / repo.current_stars;
    if (issueRatio > 0.01 && issueRatio < 0.2) score += 5;
    else if (issueRatio > 0 && issueRatio < 0.4) score += 3;
    else score += 1;
  }

  // Fork ratio (0-5)
  if (repo.current_stars > 0) {
    const forkRatio = repo.current_forks / repo.current_stars;
    if (forkRatio > 0.05 && forkRatio < 0.5) score += 5;
    else if (forkRatio > 0.01) score += 3;
    else score += 1;
  }

  // Language bonus (0-5)
  const hotLangs = ['TypeScript', 'Rust', 'Python', 'Go', 'Zig'];
  if (repo.language && hotLangs.includes(repo.language)) score += 5;
  else if (repo.language) score += 2;

  // Watchers (0-5)
  score += Math.min(5, repo.current_watchers > 0 ? Math.log10(repo.current_watchers) * 2 : 0);

  // Activity bonus: repo has forks + issues + watchers = alive (0-5)
  const activitySignals = [repo.current_forks > 0, repo.current_issues > 0, repo.current_watchers > 10];
  score += activitySignals.filter(Boolean).length * 1.67;

  return Math.min(35, score);
}

/** CrossPlatform (0-15): HN score + mentions + comments */
function scoreCrossPlatform(hnMentions: Pick<HnMention, 'score' | 'comment_count'>[]): number {
  if (hnMentions.length === 0) return 0;

  let score = 0;

  // Mention count (0-5, log scale)
  score += Math.min(5, Math.log2(hnMentions.length + 1) * 2);

  // Best HN score (0-5, log scale)
  const bestScore = Math.max(...hnMentions.map(m => m.score));
  score += Math.min(5, bestScore > 0 ? Math.log10(bestScore) * 2 : 0);

  // Comment activity (0-5, log scale)
  const totalComments = hnMentions.reduce((sum, m) => sum + m.comment_count, 0);
  score += Math.min(5, totalComments > 0 ? Math.log10(totalComments) * 2 : 0);

  return Math.min(15, score);
}

/** Influencer (0-15): count + quality + diversity */
function scoreInfluencer(influencerCount: number): number {
  // Simple: log-scaled count. In full implementation, would check GitHub star history
  // for repos with high-profile contributors or star-givers.
  return Math.min(15, influencerCount > 0 ? Math.log2(influencerCount + 1) * 5 : 0);
}

/** Timing (0-5): hot keyword matches in name/description/topics */
function scoreTiming(repo: Pick<ScannedRepo, 'name' | 'description' | 'topics'>): number {
  const haystack = [
    repo.name,
    repo.description ?? '',
    ...(repo.topics ?? []),
  ].join(' ').toLowerCase();

  let matches = 0;
  for (const keyword of HOT_KEYWORDS) {
    if (haystack.includes(keyword)) {
      matches++;
      if (matches >= 2) break; // max 2 matches
    }
  }

  return Math.min(5, matches * 2.5);
}

/** Classify signal level from total score. */
export function classifyLevel(score: number): SignalLevel {
  if (score >= BREAKOUT_THRESHOLD) return 'breakout';
  if (score >= SIGNAL_THRESHOLD) return 'signal';
  if (score >= WATCH_THRESHOLD) return 'watch';
  return 'noise';
}

/**
 * Classify signal level with hysteresis.
 * Once a repo reaches a level, it stays there for holdDays before downgrading.
 */
export function classifyWithHysteresis(
  score: number,
  currentLevel: SignalLevel,
  peakLevel: SignalLevel | null,
  peakSince: string | null,
  holdDays = 2,
): { level: SignalLevel; peak: SignalLevel; peakSince: string } {
  const newLevel = classifyLevel(score);
  const now = new Date().toISOString();

  const levelRank: Record<SignalLevel, number> = { noise: 0, watch: 1, signal: 2, breakout: 3 };

  // Upgrading: immediate
  if (levelRank[newLevel] > levelRank[currentLevel]) {
    return { level: newLevel, peak: newLevel, peakSince: now };
  }

  // Downgrading: apply hysteresis hold
  if (levelRank[newLevel] < levelRank[currentLevel] && peakSince) {
    const peakDate = new Date(peakSince);
    const daysSincePeak = (Date.now() - peakDate.getTime()) / 86_400_000;
    if (daysSincePeak < holdDays) {
      // Hold at current level
      return { level: currentLevel, peak: peakLevel ?? currentLevel, peakSince };
    }
  }

  // Same level or hold expired
  return {
    level: newLevel,
    peak: peakLevel && levelRank[peakLevel] > levelRank[newLevel] ? peakLevel : newLevel,
    peakSince: peakSince ?? now,
  };
}

/** Classify repo phase by star count. */
export function classifyPhase(stars: number): RepoPhase {
  if (stars < PHASE_EARLY) return 'discovery';
  if (stars < PHASE_HYPE) return 'early_adopter';
  if (stars < PHASE_MAINSTREAM) return 'hype';
  if (stars < PHASE_COMMODITY) return 'mainstream';
  return 'commodity';
}

/** Score a crypto token (0-100). */
export function scoreCrypto(
  priceChange24h: number | null,
  priceChange7d: number | null,
  volume: number | null,
  marketCap: number | null,
): { score: number; level: SignalLevel } {
  let score = 0;

  // Price momentum (0-40)
  if (priceChange24h !== null) {
    score += Math.min(20, Math.abs(priceChange24h));
  }
  if (priceChange7d !== null) {
    score += Math.min(20, Math.abs(priceChange7d) * 0.5);
  }

  // Volume (0-30, log-scaled)
  if (volume !== null && volume > 0) {
    score += Math.min(30, Math.log10(volume) * 3);
  }

  // Market cap stability (0-30)
  if (marketCap !== null && marketCap > 0) {
    score += Math.min(30, Math.log10(marketCap) * 2.5);
  }

  const total = Math.min(100, score);
  return { score: total, level: classifyLevel(total) };
}
