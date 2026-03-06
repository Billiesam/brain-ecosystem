import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { EcosystemService } from '../../../src/ecosystem/service.js';

function createMockCorrelator() {
  return {
    getHealth: vi.fn().mockReturnValue({
      score: 85,
      status: 'healthy',
      activeBrains: 2,
      totalEvents: 50,
      correlations: 3,
      recentErrors: 0,
      recentTradeLosses: 0,
      alerts: [],
    }),
    getCorrelations: vi.fn().mockReturnValue([]),
    getTimeline: vi.fn().mockReturnValue([]),
    recordEvent: vi.fn(),
    getActiveBrains: vi.fn().mockReturnValue(['brain', 'trading-brain']),
  };
}

function createMockCrossBrain() {
  return {
    broadcast: vi.fn().mockResolvedValue([
      { name: 'trading-brain', result: { version: '2.1.0', uptime: 100, pid: 1234, methods: 50 } },
    ]),
    query: vi.fn().mockResolvedValue(null),
    getPeerNames: vi.fn().mockReturnValue(['trading-brain', 'marketing-brain']),
  };
}

describe('EcosystemService', () => {
  let service: EcosystemService;
  let mockCorrelator: ReturnType<typeof createMockCorrelator>;
  let mockCrossBrain: ReturnType<typeof createMockCrossBrain>;

  beforeEach(() => {
    mockCorrelator = createMockCorrelator();
    mockCrossBrain = createMockCrossBrain();
    service = new EcosystemService(mockCorrelator as any, mockCrossBrain as any);
  });

  describe('getStatus', () => {
    it('returns status with available and unavailable brains', async () => {
      const status = await service.getStatus();

      const tradingBrain = status.brains.find((b) => b.name === 'trading-brain');
      expect(tradingBrain).toEqual({
        name: 'trading-brain',
        available: true,
        version: '2.1.0',
        uptime: 100,
        pid: 1234,
        methods: 50,
      });

      const marketingBrain = status.brains.find((b) => b.name === 'marketing-brain');
      expect(marketingBrain).toEqual({
        name: 'marketing-brain',
        available: false,
      });
    });

    it('includes health from correlator', async () => {
      const status = await service.getStatus();

      expect(status.health).toEqual(mockCorrelator.getHealth());
      expect(mockCorrelator.getHealth).toHaveBeenCalled();
    });

    it('includes recent events from correlator up to 20', async () => {
      const events = Array.from({ length: 30 }, (_, i) => ({
        id: i,
        source: 'brain',
        event: `event-${i}`,
        data: null,
        timestamp: Date.now(),
      }));
      mockCorrelator.getTimeline.mockReturnValue(events);

      const status = await service.getStatus();

      expect(status.recentEvents).toHaveLength(20);
      expect(status.recentEvents[0]).toEqual(events[10]);
      expect(status.recentEvents[19]).toEqual(events[29]);
    });
  });

  describe('getCorrelations', () => {
    it('delegates to correlator with minStrength', () => {
      const mockCorrelations = [
        { id: '1', strength: 0.9, sources: ['brain', 'trading-brain'] },
      ];
      mockCorrelator.getCorrelations.mockReturnValue(mockCorrelations);

      const result = service.getCorrelations(0.5);

      expect(mockCorrelator.getCorrelations).toHaveBeenCalledWith(0.5);
      expect(result).toEqual(mockCorrelations);
    });

    it('returns empty array when no correlations', () => {
      mockCorrelator.getCorrelations.mockReturnValue([]);

      const result = service.getCorrelations();

      expect(result).toEqual([]);
    });
  });

  describe('getTimeline', () => {
    it('delegates to correlator with limit', () => {
      const mockEvents = [
        { id: 1, source: 'brain', event: 'test', data: null, timestamp: Date.now() },
      ];
      mockCorrelator.getTimeline.mockReturnValue(mockEvents);

      const result = service.getTimeline(10);

      expect(mockCorrelator.getTimeline).toHaveBeenCalledWith(10);
      expect(result).toEqual(mockEvents);
    });
  });

  describe('getHealth', () => {
    it('delegates to correlator', () => {
      const result = service.getHealth();

      expect(mockCorrelator.getHealth).toHaveBeenCalled();
      expect(result).toEqual({
        score: 85,
        status: 'healthy',
        activeBrains: 2,
        totalEvents: 50,
        correlations: 3,
        recentErrors: 0,
        recentTradeLosses: 0,
        alerts: [],
      });
    });
  });

  describe('getAggregatedAnalytics', () => {
    it('returns analytics from responding peers', async () => {
      mockCrossBrain.query.mockImplementation((peer: string, method: string) => {
        if (peer === 'brain') return Promise.resolve({ errors: 10, solutions: 5, modules: 3 });
        if (peer === 'trading-brain' && method === 'analytics.summary') return Promise.resolve({ trades: { total: 20, recentWinRate: 75 }, rules: { total: 3 }, network: { synapses: 8 } });
        if (peer === 'trading-brain' && method === 'paper.status') return Promise.resolve({ equity: 10000, openPositions: 5, totalPnL: 200 });
        if (peer === 'marketing-brain') return Promise.resolve({ posts: { total: 15 }, campaigns: { total: 4 }, strategies: { total: 2 }, rules: { active: 1 }, templates: { total: 0 } });
        return Promise.resolve(null);
      });

      const analytics = await service.getAggregatedAnalytics();

      expect(analytics.brain).toEqual({ errors: 10, solutions: 5, modules: 3 });
      expect(analytics.trading).toEqual({ trades: 20, winRate: 0.75, signals: 8, rules: 3, equity: 10000, positions: 5, pnl: 200 });
      expect(analytics.marketing).toEqual({ posts: 15, campaigns: 4, engagement: 0, strategies: 2, rules: 1, templates: 0 });
    });

    it('handles offline peers gracefully', async () => {
      mockCrossBrain.query.mockResolvedValue(null);

      const analytics = await service.getAggregatedAnalytics();

      expect(analytics.brain).toBeUndefined();
      expect(analytics.trading).toBeUndefined();
      expect(analytics.marketing).toBeUndefined();
    });

    it('maps brain analytics correctly', async () => {
      mockCrossBrain.query.mockImplementation((peer: string) => {
        if (peer === 'brain') return Promise.resolve({ errors: 10, solutions: 5, modules: 3 });
        return Promise.resolve(null);
      });

      const analytics = await service.getAggregatedAnalytics();

      expect(analytics.brain).toEqual({ errors: 10, solutions: 5, modules: 3 });
      expect(analytics.trading).toBeUndefined();
      expect(analytics.marketing).toBeUndefined();
    });

    it('maps trading analytics correctly', async () => {
      mockCrossBrain.query.mockImplementation((peer: string, method: string) => {
        if (peer === 'trading-brain' && method === 'analytics.summary') return Promise.resolve({ trades: { total: 42, recentWinRate: 60 }, rules: { total: 5 }, network: { synapses: 15 } });
        if (peer === 'trading-brain' && method === 'paper.status') return Promise.resolve({ equity: 8000, openPositions: 3, totalPnL: -100 });
        return Promise.resolve(null);
      });

      const analytics = await service.getAggregatedAnalytics();

      expect(analytics.trading).toEqual({ trades: 42, winRate: 0.6, signals: 15, rules: 5, equity: 8000, positions: 3, pnl: -100 });
      expect(analytics.brain).toBeUndefined();
      expect(analytics.marketing).toBeUndefined();
    });

    it('maps marketing analytics correctly', async () => {
      mockCrossBrain.query.mockImplementation((peer: string) => {
        if (peer === 'marketing-brain') return Promise.resolve({ posts: { total: 30 }, campaigns: { total: 7 }, strategies: { total: 3 }, rules: { active: 2 }, templates: { total: 1 } });
        return Promise.resolve(null);
      });

      const analytics = await service.getAggregatedAnalytics();

      expect(analytics.marketing).toEqual({ posts: 30, campaigns: 7, engagement: 0, strategies: 3, rules: 2, templates: 1 });
      expect(analytics.brain).toBeUndefined();
      expect(analytics.trading).toBeUndefined();
    });
  });

  describe('recordEvent', () => {
    it('delegates to correlator.recordEvent', () => {
      service.recordEvent('brain', 'error.caught', { message: 'test error' });

      expect(mockCorrelator.recordEvent).toHaveBeenCalledWith('brain', 'error.caught', { message: 'test error' });
    });
  });
});
