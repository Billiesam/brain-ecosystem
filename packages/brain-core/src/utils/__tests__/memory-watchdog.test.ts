import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryWatchdog } from '../memory-watchdog.js';

describe('MemoryWatchdog', () => {
  let watchdog: MemoryWatchdog;

  beforeEach(() => {
    watchdog = new MemoryWatchdog();
  });

  afterEach(() => {
    watchdog.stop();
  });

  it('should return stable trend with no samples', () => {
    const stats = watchdog.getStats();
    expect(stats.trend).toBe('stable');
    expect(stats.leakSuspected).toBe(false);
    expect(stats.samples).toBe(0);
    expect(stats.currentMB).toBeGreaterThan(0);
  });

  it('should detect stable memory (flat heap)', () => {
    // Simulate 8 samples at roughly the same heap level
    const baseHeap = 100; // MB
    const origMemoryUsage = process.memoryUsage;
    let heapValue = baseHeap;

    process.memoryUsage = vi.fn(() => ({
      rss: 200 * 1024 * 1024,
      heapTotal: 150 * 1024 * 1024,
      heapUsed: heapValue * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    })) as any;

    const now = Date.now();
    vi.spyOn(Date, 'now')
      .mockImplementation(() => now);

    // Deterministic jitter pattern: alternating ±0.5 MB around base
    const jitter = [0.3, -0.4, 0.2, -0.3, 0.4, -0.2, 0.1, -0.1];
    for (let i = 0; i < 8; i++) {
      heapValue = baseHeap + jitter[i]!;
      vi.spyOn(Date, 'now').mockReturnValue(now + i * 300_000); // 5 min intervals
      watchdog.takeSample();
    }

    const stats = watchdog.getStats();
    expect(stats.trend).toBe('stable');
    expect(stats.leakSuspected).toBe(false);
    expect(stats.samples).toBe(8);

    process.memoryUsage = origMemoryUsage;
    vi.restoreAllMocks();
  });

  it('should detect rising trend and suspect leak', () => {
    const origMemoryUsage = process.memoryUsage;
    let heapMB = 100;

    process.memoryUsage = vi.fn(() => ({
      rss: 200 * 1024 * 1024,
      heapTotal: 250 * 1024 * 1024,
      heapUsed: heapMB * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    })) as any;

    const now = Date.now();

    // Simulate 8 samples with steady 10 MB/h growth (well above 5 MB/h threshold)
    for (let i = 0; i < 8; i++) {
      heapMB = 100 + i * 5; // 5 MB per sample, 5 min apart = 60 MB/h
      vi.spyOn(Date, 'now').mockReturnValue(now + i * 300_000);
      watchdog.takeSample();
    }

    const stats = watchdog.getStats();
    expect(stats.trend).toBe('rising');
    expect(stats.leakSuspected).toBe(true);
    expect(stats.samples).toBe(8);
    expect(stats.peakMB).toBeGreaterThanOrEqual(135); // 100 + 7*5

    process.memoryUsage = origMemoryUsage;
    vi.restoreAllMocks();
  });

  it('should detect falling trend', () => {
    const origMemoryUsage = process.memoryUsage;
    let heapMB = 200;

    process.memoryUsage = vi.fn(() => ({
      rss: 300 * 1024 * 1024,
      heapTotal: 250 * 1024 * 1024,
      heapUsed: heapMB * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    })) as any;

    const now = Date.now();

    // Simulate 8 samples with steady decline
    for (let i = 0; i < 8; i++) {
      heapMB = 200 - i * 5; // Decreasing
      vi.spyOn(Date, 'now').mockReturnValue(now + i * 300_000);
      watchdog.takeSample();
    }

    const stats = watchdog.getStats();
    expect(stats.trend).toBe('falling');
    expect(stats.leakSuspected).toBe(false);

    process.memoryUsage = origMemoryUsage;
    vi.restoreAllMocks();
  });

  it('should not suspect leak with fewer than 6 samples', () => {
    const origMemoryUsage = process.memoryUsage;
    let heapMB = 100;

    process.memoryUsage = vi.fn(() => ({
      rss: 200 * 1024 * 1024,
      heapTotal: 250 * 1024 * 1024,
      heapUsed: heapMB * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    })) as any;

    const now = Date.now();

    // Only 4 samples with steep rise — not enough for leak detection
    for (let i = 0; i < 4; i++) {
      heapMB = 100 + i * 10;
      vi.spyOn(Date, 'now').mockReturnValue(now + i * 300_000);
      watchdog.takeSample();
    }

    const stats = watchdog.getStats();
    expect(stats.trend).toBe('rising');
    expect(stats.leakSuspected).toBe(false); // Not enough samples
    expect(stats.samples).toBe(4);

    process.memoryUsage = origMemoryUsage;
    vi.restoreAllMocks();
  });

  it('should cap ring buffer at 12 samples', () => {
    for (let i = 0; i < 20; i++) {
      watchdog.takeSample();
    }
    const stats = watchdog.getStats();
    expect(stats.samples).toBe(12);
  });

  it('should start and stop timer', () => {
    watchdog.start(60_000);
    // Starting again should be a no-op
    watchdog.start(60_000);
    expect(watchdog.getStats().samples).toBeGreaterThanOrEqual(1); // immediate first sample
    watchdog.stop();
  });
});
