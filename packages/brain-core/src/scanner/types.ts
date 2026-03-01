// ── Scanner Types ──────────────────────────────────────────────

export interface ScannerConfig {
  enabled: boolean;
  githubToken: string;
  scanIntervalMs: number;
  minStarsEmerging: number;
  minStarsTrending: number;
  maxReposPerScan: number;
  cryptoEnabled: boolean;
  hnEnabled: boolean;
}

// ── GitHub ─────────────────────────────────────────────────────

export interface ScannedRepo {
  id?: number;
  github_id: number;
  full_name: string;
  name: string;
  owner: string;
  url: string;
  description: string | null;
  language: string | null;
  topics: string[];
  created_at: string | null;
  first_seen_at?: string;
  current_stars: number;
  current_forks: number;
  current_watchers: number;
  current_issues: number;
  signal_score: number;
  signal_level: SignalLevel;
  phase: RepoPhase;
  peak_signal_level: SignalLevel | null;
  peak_level_since: string | null;
  star_velocity_24h: number;
  star_velocity_7d: number;
  star_acceleration: number;
  last_scanned_at: string | null;
  is_active: boolean;
}

export type SignalLevel = 'breakout' | 'signal' | 'watch' | 'noise';
export type RepoPhase = 'discovery' | 'early_adopter' | 'hype' | 'mainstream' | 'commodity';

export interface DailyStats {
  id?: number;
  repo_id: number;
  date: string;
  stars: number;
  forks: number;
  watchers: number;
  issues: number;
  star_velocity_24h: number;
  star_velocity_7d: number;
  star_acceleration: number;
  fork_velocity_24h: number;
}

// ── HackerNews ────────────────────────────────────────────────

export interface HnMention {
  id?: number;
  hn_id: number | null;
  title: string;
  url: string | null;
  score: number;
  comment_count: number;
  author: string | null;
  posted_at: string | null;
  detected_at?: string;
  repo_id: number | null;
}

// ── Crypto ─────────────────────────────────────────────────────

export interface CryptoToken {
  id?: number;
  coingecko_id: string;
  symbol: string;
  name: string;
  category: string | null;
  current_price: number | null;
  market_cap: number | null;
  market_cap_rank: number | null;
  price_change_24h: number | null;
  price_change_7d: number | null;
  total_volume: number | null;
  signal_score: number;
  signal_level: SignalLevel;
  last_scanned_at: string | null;
  is_active: boolean;
}

// ── Scan Results ──────────────────────────────────────────────

export interface ScanResult {
  started_at: string;
  finished_at: string;
  duration_ms: number;
  repos_discovered: number;
  repos_updated: number;
  new_breakouts: number;
  new_signals: number;
  hn_mentions_found: number;
  crypto_tokens_scanned: number;
  errors: string[];
}

export interface ScannerStatus {
  running: boolean;
  enabled: boolean;
  last_scan: ScanResult | null;
  total_repos: number;
  total_active: number;
  by_level: Record<SignalLevel, number>;
  next_scan_at: string | null;
}

// ── GitHub API ─────────────────────────────────────────────────

export interface GitHubSearchResult {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubRepo[];
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
  created_at: string;
  pushed_at: string;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
}

// ── HackerNews API ────────────────────────────────────────────

export interface HnSearchResult {
  hits: HnHit[];
  nbHits: number;
}

export interface HnHit {
  objectID: string;
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  author: string;
  created_at: string;
}

// ── CoinGecko API ─────────────────────────────────────────────

export interface CoinGeckoMarket {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  price_change_percentage_24h: number;
  price_change_percentage_7d_in_currency?: number;
  total_volume: number;
}

export interface CoinGeckoTrending {
  coins: Array<{
    item: {
      id: string;
      symbol: string;
      name: string;
      market_cap_rank: number;
      price_btc: number;
    };
  }>;
}

// ── Score Components ──────────────────────────────────────────

export interface ScoreBreakdown {
  momentum: number;
  technical: number;
  cross_platform: number;
  influencer: number;
  timing: number;
  total: number;
  level: SignalLevel;
  phase: RepoPhase;
}
