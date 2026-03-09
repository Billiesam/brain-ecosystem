/**
 * MemoryWatchdog — Heap leak detection via linear regression over a ring buffer.
 *
 * Samples process.memoryUsage() at a configurable interval (default 5 min).
 * Keeps the last 12 samples (= 1 hour window) in a ring buffer.
 * Reports trend (stable / rising / falling) and leakSuspected flag
 * when the regression slope exceeds 5 MB/h over 6+ samples.
 */

export interface MemoryStats {
  currentMB: number;
  peakMB: number;
  trend: 'stable' | 'rising' | 'falling';
  leakSuspected: boolean;
  samples: number;
}

interface Sample {
  timestampMs: number;
  heapMB: number;
}

const RING_SIZE = 12;
const LEAK_SLOPE_THRESHOLD_MB_PER_H = 5;
const MIN_SAMPLES_FOR_TREND = 6;

export class MemoryWatchdog {
  private samples: Sample[] = [];
  private peakMB = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Start sampling at the given interval (default 5 minutes). */
  start(intervalMs = 300_000): void {
    if (this.timer) return; // already running
    this.takeSample(); // immediate first sample
    this.timer = setInterval(() => this.takeSample(), intervalMs);
    if (this.timer.unref) this.timer.unref(); // don't block process exit
  }

  /** Stop sampling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Take a single heap sample and add it to the ring buffer. */
  takeSample(): void {
    const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
    if (heapMB > this.peakMB) this.peakMB = heapMB;

    this.samples.push({ timestampMs: Date.now(), heapMB });
    if (this.samples.length > RING_SIZE) {
      this.samples.shift();
    }
  }

  /** Get current memory statistics and leak assessment. */
  getStats(): MemoryStats {
    const currentMB = Math.round(process.memoryUsage().heapUsed / (1024 * 1024));

    if (this.samples.length < 2) {
      return { currentMB, peakMB: Math.round(this.peakMB), trend: 'stable', leakSuspected: false, samples: this.samples.length };
    }

    const slopeMBPerH = this.linearRegressionSlope();
    let trend: MemoryStats['trend'] = 'stable';
    if (slopeMBPerH > 2) trend = 'rising';
    else if (slopeMBPerH < -2) trend = 'falling';

    const leakSuspected = this.samples.length >= MIN_SAMPLES_FOR_TREND && slopeMBPerH > LEAK_SLOPE_THRESHOLD_MB_PER_H;

    return {
      currentMB,
      peakMB: Math.round(this.peakMB),
      trend,
      leakSuspected,
      samples: this.samples.length,
    };
  }

  /**
   * Simple linear regression: slope of heapMB over time (in MB/h).
   * Uses least-squares fit: slope = Σ((x-x̄)(y-ȳ)) / Σ((x-x̄)²)
   */
  private linearRegressionSlope(): number {
    const n = this.samples.length;
    if (n < 2) return 0;

    // Convert timestamps to hours relative to first sample
    const t0 = this.samples[0]!.timestampMs;
    const xs = this.samples.map(s => (s.timestampMs - t0) / 3_600_000); // hours
    const ys = this.samples.map(s => s.heapMB);

    const xMean = xs.reduce((a, b) => a + b, 0) / n;
    const yMean = ys.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i]! - xMean;
      const dy = ys[i]! - yMean;
      numerator += dx * dy;
      denominator += dx * dx;
    }

    return denominator === 0 ? 0 : numerator / denominator;
  }
}
