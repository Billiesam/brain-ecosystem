import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────

export interface SchedulerBucket {
  cycleCount: number;
  insightsFound: number;
  rulesLearned: number;
  anomaliesDetected: number;
  avgDurationMs: number;
}

export interface CycleOutcome {
  insightsFound: number;
  rulesLearned: number;
  anomaliesDetected: number;
  durationMs: number;
}

export interface AdaptiveSchedulerConfig {
  baseIntervalMs?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  productiveMultiplier?: number;
  idleMultiplier?: number;
  idleThreshold?: number; // cycles with 0 output before considered idle
}

export interface AdaptiveSchedulerStatus {
  currentIntervalMs: number;
  baseIntervalMs: number;
  minIntervalMs: number;
  maxIntervalMs: number;
  totalCycles: number;
  productiveBuckets: number;
  idleBuckets: number;
}

// ── Scheduler ───────────────────────────────────────

const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const TOTAL_BUCKETS = HOURS_PER_DAY * DAYS_PER_WEEK; // 168

export class AdaptiveScheduler {
  private buckets: SchedulerBucket[];
  private currentIntervalMs: number;
  private readonly config: Required<AdaptiveSchedulerConfig>;
  private readonly log = getLogger();

  constructor(config: AdaptiveSchedulerConfig = {}) {
    this.config = {
      baseIntervalMs: config.baseIntervalMs ?? 300_000,
      minIntervalMs: config.minIntervalMs ?? 120_000,
      maxIntervalMs: config.maxIntervalMs ?? 900_000,
      productiveMultiplier: config.productiveMultiplier ?? 0.7,
      idleMultiplier: config.idleMultiplier ?? 1.5,
      idleThreshold: config.idleThreshold ?? 3,
    };
    this.currentIntervalMs = this.config.baseIntervalMs;
    this.buckets = Array.from({ length: TOTAL_BUCKETS }, () => ({
      cycleCount: 0,
      insightsFound: 0,
      rulesLearned: 0,
      anomaliesDetected: 0,
      avgDurationMs: 0,
    }));
  }

  /** Get bucket index for a given time. */
  private getBucketIndex(date: Date = new Date()): number {
    const day = date.getDay(); // 0=Sunday
    const hour = date.getHours();
    return day * HOURS_PER_DAY + hour;
  }

  /** Record outcome of a completed cycle. */
  recordOutcome(outcome: CycleOutcome, date: Date = new Date()): void {
    const idx = this.getBucketIndex(date);
    const bucket = this.buckets[idx]!;

    // Running average for duration
    const totalDuration = bucket.avgDurationMs * bucket.cycleCount + outcome.durationMs;
    bucket.cycleCount++;
    bucket.avgDurationMs = totalDuration / bucket.cycleCount;
    bucket.insightsFound += outcome.insightsFound;
    bucket.rulesLearned += outcome.rulesLearned;
    bucket.anomaliesDetected += outcome.anomaliesDetected;

    // Recalculate interval
    this.currentIntervalMs = this.computeInterval(idx);

    this.log.debug(`[adaptive-scheduler] Bucket ${idx} (day=${date.getDay()},h=${date.getHours()}): cycles=${bucket.cycleCount}, interval=${this.currentIntervalMs}ms`);
  }

  /** Compute next interval based on current bucket's productivity. */
  private computeInterval(bucketIndex: number): number {
    const bucket = this.buckets[bucketIndex]!;
    const { baseIntervalMs, minIntervalMs, maxIntervalMs, productiveMultiplier, idleMultiplier, idleThreshold } = this.config;

    const isProductive = bucket.insightsFound > 0 || bucket.anomaliesDetected > 0 || bucket.rulesLearned > 0;
    const isIdle = !isProductive && bucket.cycleCount >= idleThreshold;

    let interval = baseIntervalMs;
    if (isProductive) {
      interval = Math.round(baseIntervalMs * productiveMultiplier);
    } else if (isIdle) {
      interval = Math.round(baseIntervalMs * idleMultiplier);
    }

    return Math.max(minIntervalMs, Math.min(maxIntervalMs, interval));
  }

  /** Get the recommended interval for the next cycle. */
  getNextInterval(): number {
    return this.currentIntervalMs;
  }

  /** Update base config from ParameterRegistry values. */
  updateConfig(partial: Partial<AdaptiveSchedulerConfig>): void {
    if (partial.baseIntervalMs !== undefined) this.config.baseIntervalMs = partial.baseIntervalMs;
    if (partial.minIntervalMs !== undefined) this.config.minIntervalMs = partial.minIntervalMs;
    if (partial.maxIntervalMs !== undefined) this.config.maxIntervalMs = partial.maxIntervalMs;
    if (partial.productiveMultiplier !== undefined) this.config.productiveMultiplier = partial.productiveMultiplier;
    if (partial.idleMultiplier !== undefined) this.config.idleMultiplier = partial.idleMultiplier;
    if (partial.idleThreshold !== undefined) this.config.idleThreshold = partial.idleThreshold;
  }

  /** Get status summary. */
  getStatus(): AdaptiveSchedulerStatus {
    let productive = 0;
    let idle = 0;
    for (const b of this.buckets) {
      if (b.cycleCount === 0) continue;
      if (b.insightsFound > 0 || b.anomaliesDetected > 0 || b.rulesLearned > 0) productive++;
      else if (b.cycleCount >= this.config.idleThreshold) idle++;
    }
    return {
      currentIntervalMs: this.currentIntervalMs,
      baseIntervalMs: this.config.baseIntervalMs,
      minIntervalMs: this.config.minIntervalMs,
      maxIntervalMs: this.config.maxIntervalMs,
      totalCycles: this.buckets.reduce((s, b) => s + b.cycleCount, 0),
      productiveBuckets: productive,
      idleBuckets: idle,
    };
  }

  /** Reset all bucket data. */
  reset(): void {
    for (const b of this.buckets) {
      b.cycleCount = 0;
      b.insightsFound = 0;
      b.rulesLearned = 0;
      b.anomaliesDetected = 0;
      b.avgDurationMs = 0;
    }
    this.currentIntervalMs = this.config.baseIntervalMs;
  }

  /** Get raw bucket data (for dashboard/debugging). */
  getBuckets(): readonly SchedulerBucket[] {
    return this.buckets;
  }
}
