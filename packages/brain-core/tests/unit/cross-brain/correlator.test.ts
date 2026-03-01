import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CrossBrainCorrelator } from '../../../src/cross-brain/correlator.js';

describe('recordEvent', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('adds event to buffer', () => {
    correlator.recordEvent('brain-a', 'test:event', { foo: 1 });
    expect(correlator.getEventCount()).toBe(1);
    const timeline = correlator.getTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].source).toBe('brain-a');
    expect(timeline[0].event).toBe('test:event');
    expect(timeline[0].data).toEqual({ foo: 1 });
  });

  it('updates brainLastSeen', () => {
    correlator.recordEvent('brain-a', 'test:event', {});
    const active = correlator.getActiveBrains();
    expect(active).toContain('brain-a');
  });

  it('circular buffer trims when exceeding maxEvents', () => {
    const small = new CrossBrainCorrelator({ maxEvents: 5 });
    for (let i = 0; i < 7; i++) {
      small.recordEvent('brain', `event:${i}`, {});
    }
    expect(small.getEventCount()).toBe(5);
  });

  it('detects correlation when events from different brains within window', () => {
    correlator.recordEvent('brain-a', 'test:event', {});
    correlator.recordEvent('brain-b', 'other:event', {});
    const correlations = correlator.getCorrelations();
    expect(correlations.length).toBeGreaterThan(0);
  });
});

describe('detectCorrelations', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('classifies error:reported + trade:outcome(win=false) as error-trade-loss', () => {
    correlator.recordEvent('brain-a', 'error:reported', {});
    correlator.recordEvent('brain-b', 'trade:outcome', { win: false });
    const correlations = correlator.getCorrelations();
    expect(correlations).toHaveLength(1);
    expect(correlations[0].type).toBe('error-trade-loss');
  });

  it('classifies error:reported + trade:outcome(win=true) as error-trade-win', () => {
    correlator.recordEvent('brain-a', 'error:reported', {});
    correlator.recordEvent('brain-b', 'trade:outcome', { win: true });
    const correlations = correlator.getCorrelations();
    expect(correlations).toHaveLength(1);
    expect(correlations[0].type).toBe('error-trade-win');
  });

  it('classifies error:reported + post:published as publish-during-errors', () => {
    correlator.recordEvent('brain-a', 'error:reported', {});
    correlator.recordEvent('brain-b', 'post:published', {});
    const correlations = correlator.getCorrelations();
    expect(correlations).toHaveLength(1);
    expect(correlations[0].type).toBe('publish-during-errors');
  });

  it('classifies insight:created + any as cross-brain-insight', () => {
    correlator.recordEvent('brain-a', 'insight:created', {});
    correlator.recordEvent('brain-b', 'something:else', {});
    const correlations = correlator.getCorrelations();
    expect(correlations).toHaveLength(1);
    expect(correlations[0].type).toBe('cross-brain-insight');
  });

  it('classifies unrelated events as temporal-co-occurrence', () => {
    correlator.recordEvent('brain-a', 'foo:bar', {});
    correlator.recordEvent('brain-b', 'baz:qux', {});
    const correlations = correlator.getCorrelations();
    expect(correlations).toHaveLength(1);
    expect(correlations[0].type).toBe('temporal-co-occurrence');
  });

  it('same brain events do not correlate', () => {
    correlator.recordEvent('brain', 'event:a', {});
    correlator.recordEvent('brain', 'event:b', {});
    const correlations = correlator.getCorrelations();
    expect(correlations).toHaveLength(0);
  });

  it('events outside window do not correlate', () => {
    vi.useFakeTimers();
    const narrow = new CrossBrainCorrelator({ windowMs: 100 });
    narrow.recordEvent('brain-a', 'event:a', {});
    vi.advanceTimersByTime(150);
    narrow.recordEvent('brain-b', 'event:b', {});
    const correlations = narrow.getCorrelations();
    expect(correlations).toHaveLength(0);
    vi.useRealTimers();
  });

  it('correlation strength increases with count', () => {
    for (let i = 0; i < 10; i++) {
      correlator.recordEvent('brain-a', 'event:x', {});
      correlator.recordEvent('brain-b', 'event:y', {});
    }
    const correlations = correlator.getCorrelations();
    expect(correlations.length).toBeGreaterThan(0);
    expect(correlations[0].strength).toBe(1.0);
  });

  it('correlation ID is stable regardless of event arrival order', () => {
    const c1 = new CrossBrainCorrelator();
    c1.recordEvent('brain-a', 'event:x', {});
    c1.recordEvent('brain-b', 'event:y', {});

    const c2 = new CrossBrainCorrelator();
    c2.recordEvent('brain-b', 'event:y', {});
    c2.recordEvent('brain-a', 'event:x', {});

    const id1 = c1.getCorrelations()[0].id;
    const id2 = c2.getCorrelations()[0].id;
    expect(id1).toBe(id2);
  });
});

describe('getCorrelations', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('returns empty array when no correlations', () => {
    expect(correlator.getCorrelations()).toEqual([]);
  });

  it('sorts by strength descending', () => {
    correlator.recordEvent('brain-a', 'event:x', {});
    correlator.recordEvent('brain-b', 'event:y', {});

    for (let i = 0; i < 5; i++) {
      correlator.recordEvent('brain-c', 'event:z', {});
      correlator.recordEvent('brain-d', 'event:w', {});
    }

    const correlations = correlator.getCorrelations();
    for (let i = 1; i < correlations.length; i++) {
      expect(correlations[i - 1].strength).toBeGreaterThanOrEqual(
        correlations[i].strength,
      );
    }
  });

  it('filters by minStrength', () => {
    correlator.recordEvent('brain-a', 'event:x', {});
    correlator.recordEvent('brain-b', 'event:y', {});

    for (let i = 0; i < 9; i++) {
      correlator.recordEvent('brain-c', 'event:z', {});
      correlator.recordEvent('brain-d', 'event:w', {});
    }

    const weak = correlator.getCorrelations(0.5);
    for (const c of weak) {
      expect(c.strength).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('getTimeline', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('returns most recent events (default 50)', () => {
    for (let i = 0; i < 60; i++) {
      correlator.recordEvent('brain', `event:${i}`, {});
    }
    const timeline = correlator.getTimeline();
    expect(timeline).toHaveLength(50);
    expect(timeline[timeline.length - 1].event).toBe('event:59');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 20; i++) {
      correlator.recordEvent('brain', `event:${i}`, {});
    }
    const timeline = correlator.getTimeline(5);
    expect(timeline).toHaveLength(5);
    expect(timeline[timeline.length - 1].event).toBe('event:19');
  });
});

describe('getHealth', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('starts at healthy (100) with no events', () => {
    const health = correlator.getHealth();
    expect(health.score).toBe(100);
    expect(health.status).toBe('healthy');
  });

  it('decreases score with errors', () => {
    correlator.recordEvent('brain', 'error:reported', {});
    correlator.recordEvent('brain', 'error:reported', {});
    correlator.recordEvent('brain', 'error:reported', {});
    const health = correlator.getHealth();
    expect(health.score).toBeLessThan(100);
  });

  it('marks active brains correctly', () => {
    correlator.recordEvent('brain', 'test:event', {});
    const health = correlator.getHealth();
    expect(health.activeBrains).toBeGreaterThanOrEqual(1);
    expect(correlator.getActiveBrains()).toContain('brain');
  });

  it('generates alerts for recent errors', () => {
    correlator.recordEvent('brain', 'error:reported', {});
    const health = correlator.getHealth();
    expect(health.alerts.length).toBeGreaterThan(0);
    expect(health.alerts.some((a) => a.includes('error'))).toBe(true);
  });

  it('status is critical when score < 40', () => {
    for (let i = 0; i < 10; i++) {
      correlator.recordEvent('brain', 'error:reported', {});
    }
    const health = correlator.getHealth();
    expect(health.score).toBeLessThan(40);
    expect(health.status).toBe('critical');
  });
});

describe('getActiveBrains', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('returns empty when no events', () => {
    expect(correlator.getActiveBrains()).toEqual([]);
  });

  it('returns brain name after recording event', () => {
    correlator.recordEvent('brain', 'test:event', {});
    expect(correlator.getActiveBrains()).toContain('brain');
  });
});

describe('clear', () => {
  let correlator: CrossBrainCorrelator;

  beforeEach(() => {
    correlator = new CrossBrainCorrelator();
  });

  it('resets all state', () => {
    correlator.recordEvent('brain-a', 'event:x', {});
    correlator.recordEvent('brain-b', 'event:y', {});
    correlator.clear();
    expect(correlator.getEventCount()).toBe(0);
    expect(correlator.getCorrelations()).toEqual([]);
    expect(correlator.getActiveBrains()).toEqual([]);
    expect(correlator.getTimeline()).toEqual([]);
  });
});
