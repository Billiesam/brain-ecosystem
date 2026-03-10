import { describe, it, expect } from 'vitest';
import { AdaptiveScheduler } from '../../../src/research/adaptive-scheduler.js';

describe('AdaptiveScheduler', () => {
  it('starts with base interval', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 300_000 });
    expect(scheduler.getNextInterval()).toBe(300_000);
  });

  it('speeds up for productive hours', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 300_000, productiveMultiplier: 0.7 });
    // Monday 10am
    const date = new Date('2026-03-09T10:00:00');
    scheduler.recordOutcome({ insightsFound: 3, rulesLearned: 0, anomaliesDetected: 1, durationMs: 5000 }, date);
    expect(scheduler.getNextInterval()).toBe(210_000); // 300k * 0.7
  });

  it('slows down for idle hours', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 300_000, idleMultiplier: 1.5, idleThreshold: 3 });
    const date = new Date('2026-03-09T03:00:00'); // Monday 3am
    for (let i = 0; i < 3; i++) {
      scheduler.recordOutcome({ insightsFound: 0, rulesLearned: 0, anomaliesDetected: 0, durationMs: 2000 }, date);
    }
    expect(scheduler.getNextInterval()).toBe(450_000); // 300k * 1.5
  });

  it('respects minimum interval bound', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 100_000, minIntervalMs: 120_000, productiveMultiplier: 0.5 });
    const date = new Date('2026-03-09T10:00:00');
    scheduler.recordOutcome({ insightsFound: 5, rulesLearned: 0, anomaliesDetected: 0, durationMs: 1000 }, date);
    expect(scheduler.getNextInterval()).toBe(120_000); // clamped to min
  });

  it('respects maximum interval bound', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 800_000, maxIntervalMs: 900_000, idleMultiplier: 1.5, idleThreshold: 1 });
    const date = new Date('2026-03-09T03:00:00');
    scheduler.recordOutcome({ insightsFound: 0, rulesLearned: 0, anomaliesDetected: 0, durationMs: 1000 }, date);
    expect(scheduler.getNextInterval()).toBe(900_000); // clamped to max
  });

  it('tracks status correctly', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 300_000, idleThreshold: 2 });
    const prodDate = new Date('2026-03-09T10:00:00');
    const idleDate = new Date('2026-03-09T03:00:00');

    scheduler.recordOutcome({ insightsFound: 1, rulesLearned: 0, anomaliesDetected: 0, durationMs: 5000 }, prodDate);
    scheduler.recordOutcome({ insightsFound: 0, rulesLearned: 0, anomaliesDetected: 0, durationMs: 2000 }, idleDate);
    scheduler.recordOutcome({ insightsFound: 0, rulesLearned: 0, anomaliesDetected: 0, durationMs: 2000 }, idleDate);

    const status = scheduler.getStatus();
    expect(status.totalCycles).toBe(3);
    expect(status.productiveBuckets).toBe(1);
    expect(status.idleBuckets).toBe(1);
  });

  it('resets all bucket data', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 300_000 });
    scheduler.recordOutcome({ insightsFound: 5, rulesLearned: 0, anomaliesDetected: 0, durationMs: 5000 }, new Date());
    expect(scheduler.getStatus().totalCycles).toBe(1);

    scheduler.reset();
    expect(scheduler.getStatus().totalCycles).toBe(0);
    expect(scheduler.getNextInterval()).toBe(300_000);
  });

  it('updates config dynamically', () => {
    const scheduler = new AdaptiveScheduler({ baseIntervalMs: 300_000 });
    scheduler.updateConfig({ baseIntervalMs: 200_000 });
    expect(scheduler.getStatus().baseIntervalMs).toBe(200_000);
  });
});
