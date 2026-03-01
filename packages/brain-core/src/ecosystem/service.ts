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
  trading?: { trades: number; winRate: number; signals: number };
  marketing?: { posts: number; campaigns: number; engagement: number };
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

    const [brainResult, tradingResult, marketingResult] = await Promise.all([
      this.crossBrain.query('brain', 'analytics.summary'),
      this.crossBrain.query('trading-brain', 'analytics.summary'),
      this.crossBrain.query('marketing-brain', 'analytics.summary'),
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
      const data = tradingResult as Record<string, number>;
      analytics.trading = {
        trades: data.trades ?? 0,
        winRate: data.winRate ?? 0,
        signals: data.signals ?? 0,
      };
    }

    if (marketingResult != null) {
      const data = marketingResult as Record<string, number>;
      analytics.marketing = {
        posts: data.posts ?? 0,
        campaigns: data.campaigns ?? 0,
        engagement: data.engagement ?? 0,
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
