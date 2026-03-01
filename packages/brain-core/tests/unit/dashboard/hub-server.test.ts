import { vi, describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { createHubDashboard } from '../../../src/dashboard/hub-server.js';

function createMockCorrelator() {
  return {
    getHealth: vi.fn().mockReturnValue({
      score: 90,
      status: 'healthy',
      activeBrains: 3,
      totalEvents: 100,
      correlations: 5,
      recentErrors: 0,
      recentTradeLosses: 0,
      alerts: [],
    }),
    getCorrelations: vi.fn().mockReturnValue([
      {
        id: 'test',
        sourceA: 'brain',
        eventA: 'error:reported',
        sourceB: 'trading-brain',
        eventB: 'trade:outcome',
        type: 'error-trade-loss',
        strength: 0.5,
        count: 5,
        lastSeen: Date.now(),
      },
    ]),
    getTimeline: vi.fn().mockReturnValue([
      { source: 'brain', event: 'error:reported', data: {}, timestamp: Date.now() },
    ]),
    getActiveBrains: vi.fn().mockReturnValue(['brain', 'trading-brain', 'marketing-brain']),
    recordEvent: vi.fn(),
  };
}

function createMockEcosystem() {
  return {
    getStatus: vi.fn(),
    getCorrelations: vi.fn(),
    getTimeline: vi.fn(),
    getHealth: vi.fn(),
    getAggregatedAnalytics: vi.fn(),
    recordEvent: vi.fn(),
  };
}

describe('createHubDashboard', () => {
  let correlator: ReturnType<typeof createMockCorrelator>;
  let ecosystem: ReturnType<typeof createMockEcosystem>;

  beforeEach(() => {
    correlator = createMockCorrelator();
    ecosystem = createMockEcosystem();
  });

  it('returns a DashboardServer instance with start and stop methods', () => {
    const dashboard = createHubDashboard({
      port: 0,
      ecosystemService: ecosystem as any,
      correlator: correlator as any,
    });

    expect(dashboard).toBeDefined();
    expect(typeof dashboard.start).toBe('function');
    expect(typeof dashboard.stop).toBe('function');
  });

  it('getStats returns health data including correlations and timeline', () => {
    const dashboard = createHubDashboard({
      port: 0,
      ecosystemService: ecosystem as any,
      correlator: correlator as any,
    });

    // Access the internal getStats via the options passed to DashboardServer
    const options = (dashboard as any).options;
    const stats = options.getStats();

    expect(stats.score).toBe(90);
    expect(stats.status).toBe('healthy');
    expect(stats.activeBrains).toBe(3);
    expect(stats.totalEvents).toBe(100);
    expect(stats.correlations).toHaveLength(1);
    expect(stats.correlations[0].id).toBe('test');
    expect(stats.timeline).toHaveLength(1);
    expect(stats.timeline[0].source).toBe('brain');
  });

  it('getStats includes activeBrainNames array', () => {
    const dashboard = createHubDashboard({
      port: 0,
      ecosystemService: ecosystem as any,
      correlator: correlator as any,
    });

    const options = (dashboard as any).options;
    const stats = options.getStats();

    expect(stats.activeBrainNames).toEqual(['brain', 'trading-brain', 'marketing-brain']);
    expect(correlator.getActiveBrains).toHaveBeenCalled();
  });

  it('getStats calls correlator methods', () => {
    const dashboard = createHubDashboard({
      port: 0,
      ecosystemService: ecosystem as any,
      correlator: correlator as any,
    });

    const options = (dashboard as any).options;
    options.getStats();

    expect(correlator.getHealth).toHaveBeenCalled();
    expect(correlator.getCorrelations).toHaveBeenCalled();
    expect(correlator.getTimeline).toHaveBeenCalledWith(20);
    expect(correlator.getActiveBrains).toHaveBeenCalled();
  });

  it('getDashboardHtml returns fallback HTML when template file is not found', () => {
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const dashboard = createHubDashboard({
      port: 0,
      ecosystemService: ecosystem as any,
      correlator: correlator as any,
    });

    const options = (dashboard as any).options;
    const html = options.getDashboardHtml();

    expect(html).toContain('Hub Dashboard HTML not found');
    spy.mockRestore();
  });
});
