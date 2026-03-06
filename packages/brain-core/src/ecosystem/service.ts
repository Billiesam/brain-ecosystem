import type { CrossBrainCorrelator, Correlation, CorrelatorEvent, EcosystemHealth } from '../cross-brain/correlator.js';
import type { CrossBrainClient } from '../cross-brain/client.js';
import { getLogger } from '../utils/logger.js';

export interface BrainStatus {
  name: string;
  available: boolean;
  version?: string;
  uptime?: number;
  pid?: number;
  methods?: number;
}

export interface EcosystemStatus {
  brains: BrainStatus[];
  health: EcosystemHealth;
  correlations: Correlation[];
  recentEvents: CorrelatorEvent[];
}

export interface AggregatedAnalytics {
  brain?: { errors: number; solutions: number; modules: number };
  trading?: { trades: number; winRate: number; signals: number; equity?: number; positions?: number; pnl?: number; rules?: number };
  marketing?: { posts: number; campaigns: number; engagement: number; strategies?: number; rules?: number; templates?: number };
}

export class EcosystemService {
  private logger = getLogger();

  constructor(
    private correlator: CrossBrainCorrelator,
    private crossBrain: CrossBrainClient,
  ) {}

  /**
   * Get the full ecosystem status: all peer brains, health, correlations, and recent events.
   */
  async getStatus(): Promise<EcosystemStatus> {
    const responses = await this.crossBrain.broadcast('status');

    const brains: BrainStatus[] = responses.map((r) => {
      const data = r.result as Record<string, unknown> | null;
      return {
        name: r.name,
        available: true,
        version: data?.version as string | undefined,
        uptime: data?.uptime as number | undefined,
        pid: data?.pid as number | undefined,
        methods: data?.methods as number | undefined,
      };
    });

    // Mark peers that didn't respond as unavailable
    const respondedNames = new Set(brains.map((b) => b.name));
    for (const peerName of this.crossBrain.getPeerNames()) {
      if (!respondedNames.has(peerName)) {
        brains.push({ name: peerName, available: false });
      }
    }

    const health = this.correlator.getHealth();
    const correlations = this.correlator.getCorrelations();
    const allEvents = this.correlator.getTimeline();
    const recentEvents = allEvents.slice(-20);

    return { brains, health, correlations, recentEvents };
  }

  /**
   * Get correlations, optionally filtered by minimum strength.
   */
  getCorrelations(minStrength?: number): Correlation[] {
    return this.correlator.getCorrelations(minStrength);
  }

  /**
   * Get the event timeline, optionally limited to the most recent N entries.
   */
  getTimeline(limit?: number): CorrelatorEvent[] {
    return this.correlator.getTimeline(limit);
  }

  /**
   * Get the current ecosystem health assessment.
   */
  getHealth(): EcosystemHealth {
    return this.correlator.getHealth();
  }

  /**
   * Aggregate analytics from all peer brains.
   * Each peer is queried independently; offline peers are silently skipped.
   */
  async getAggregatedAnalytics(): Promise<AggregatedAnalytics> {
    const analytics: AggregatedAnalytics = {};

    const [brainResult, tradingResult, marketingResult, paperResult] = await Promise.all([
      this.crossBrain.query('brain', 'analytics.summary'),
      this.crossBrain.query('trading-brain', 'analytics.summary'),
      this.crossBrain.query('marketing-brain', 'analytics.summary'),
      this.crossBrain.query('trading-brain', 'paper.status'),
    ]);

    if (brainResult != null) {
      const data = brainResult as Record<string, number>;
      analytics.brain = {
        errors: data.errors ?? 0,
        solutions: data.solutions ?? 0,
        modules: data.modules ?? 0,
      };
    }

    if (tradingResult != null) {
      const data = tradingResult as Record<string, unknown>;
      const trades = data.trades as Record<string, number> | number | undefined;
      const rules = data.rules as Record<string, number> | undefined;
      const network = data.network as Record<string, number> | undefined;
      const paper = paperResult as Record<string, unknown> | null;
      analytics.trading = {
        trades: typeof trades === 'object' ? trades?.total ?? 0 : Number(trades) || 0,
        winRate: typeof trades === 'object' ? (trades?.recentWinRate ?? 0) / 100 : 0,
        signals: network?.synapses ?? 0,
        rules: typeof rules === 'object' ? rules?.total ?? 0 : 0,
        equity: Number(paper?.equity) || 0,
        positions: Number(paper?.openPositions) || 0,
        pnl: Number(paper?.totalPnL) || 0,
      };
    }

    if (marketingResult != null) {
      const data = marketingResult as Record<string, unknown>;
      const posts = data.posts as Record<string, number> | number | undefined;
      const campaigns = data.campaigns as Record<string, number> | undefined;
      const strategies = data.strategies as Record<string, number> | undefined;
      const rules = data.rules as Record<string, number> | undefined;
      const templates = data.templates as Record<string, number> | undefined;
      analytics.marketing = {
        posts: typeof posts === 'object' ? posts?.total ?? 0 : Number(posts) || 0,
        campaigns: typeof campaigns === 'object' ? campaigns?.total ?? 0 : Number(campaigns) || 0,
        engagement: 0, // computed client-side from posts
        strategies: typeof strategies === 'object' ? strategies?.total ?? 0 : 0,
        rules: typeof rules === 'object' ? rules?.active ?? rules?.total ?? 0 : 0,
        templates: typeof templates === 'object' ? templates?.total ?? 0 : 0,
      };
    }

    this.logger.debug('Aggregated analytics collected', {
      hasBrain: analytics.brain != null,
      hasTrading: analytics.trading != null,
      hasMarketing: analytics.marketing != null,
    });

    return analytics;
  }

  /**
   * Record a cross-brain event in the correlator.
   */
  recordEvent(source: string, event: string, data: unknown): void {
    this.correlator.recordEvent(source, event, data);
  }
}
