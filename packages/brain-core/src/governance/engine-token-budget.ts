/**
 * EngineTokenBudgetTracker — Per-engine token budget enforcement.
 *
 * Tracks how many tokens each engine has consumed (hourly + daily)
 * and enforces configurable limits via ParameterRegistry.
 */
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ParameterRegistry } from '../metacognition/index.js';

// ── Types ───────────────────────────────────────────────

export interface EngineTokenAllocation {
  engineId: string;
  hourlyLimit: number;
  dailyLimit: number;
  hourlyUsed: number;
  dailyUsed: number;
  hourlyPercent: number;
  dailyPercent: number;
  status: 'ok' | 'warning' | 'exhausted';
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface BudgetReservation {
  engineId: string;
  estimatedTokens: number;
  reservedAt: number;
}

// ── Default Budgets ─────────────────────────────────────

export const DEFAULT_ENGINE_BUDGETS: Array<{ engine: string; hourly: number; daily: number }> = [
  { engine: 'hypothesis_engine', hourly: 5000, daily: 30000 },
  { engine: 'debate_engine', hourly: 5000, daily: 30000 },
  { engine: 'creative_engine', hourly: 3000, daily: 20000 },
  { engine: 'narrative_engine', hourly: 3000, daily: 20000 },
  { engine: 'curiosity_engine', hourly: 5000, daily: 30000 },
  { engine: 'mission_engine', hourly: 8000, daily: 50000 },
  { engine: 'strategy_forge', hourly: 10000, daily: 60000 },
  { engine: 'content_forge', hourly: 5000, daily: 30000 },
  { engine: 'rag_engine', hourly: 3000, daily: 20000 },
  { engine: 'semantic_compressor', hourly: 2000, daily: 15000 },
  { engine: 'relevance_scorer', hourly: 2000, daily: 15000 },
  { engine: 'tech_radar', hourly: 3000, daily: 20000 },
  { engine: 'proactive_engine', hourly: 3000, daily: 20000 },
  { engine: 'knowledge_graph', hourly: 3000, daily: 20000 },
  { engine: 'research_orchestrator', hourly: 5000, daily: 30000 },
  { engine: 'feature_extractor', hourly: 3000, daily: 20000 },
];

// ── Tracker ─────────────────────────────────────────────

export class EngineTokenBudgetTracker {
  private db: Database.Database;
  private parameterRegistry: ParameterRegistry | null;
  private log = getLogger();

  // In-memory cache for hot path (avoid DB queries on every call)
  private cache = new Map<string, { hourly: number; daily: number; fetchedAt: number }>();
  private readonly cacheTtlMs = 60_000; // 1 minute

  // Active reservations — tokens claimed by in-flight LLM calls
  private reservations = new Map<string, BudgetReservation>();
  private reservationCounter = 0;

  constructor(db: Database.Database, parameterRegistry: ParameterRegistry | null = null) {
    this.db = db;
    this.parameterRegistry = parameterRegistry;
  }

  /** Register default budget parameters in the ParameterRegistry. */
  registerDefaults(): void {
    if (!this.parameterRegistry) return;

    const params = DEFAULT_ENGINE_BUDGETS.flatMap(b => [
      {
        engine: b.engine,
        name: 'token_budget_hourly',
        value: b.hourly,
        min: 0,
        max: 100_000,
        description: `Hourly token budget for ${b.engine}`,
        category: 'token_budget',
      },
      {
        engine: b.engine,
        name: 'token_budget_daily',
        value: b.daily,
        min: 0,
        max: 1_000_000,
        description: `Daily token budget for ${b.engine}`,
        category: 'token_budget',
      },
    ]);

    this.parameterRegistry.registerAll(params);
    this.log.debug(`[TokenBudget] Registered ${params.length} budget parameters for ${DEFAULT_ENGINE_BUDGETS.length} engines`);
  }

  /** Check if an engine is within its token budget. */
  checkBudget(engineId: string): BudgetCheckResult {
    const limits = this.getLimits(engineId);
    if (!limits) {
      // No budget configured → allow
      return { allowed: true };
    }

    const usage = this.getUsage(engineId);

    if (limits.daily > 0 && usage.daily >= limits.daily) {
      return { allowed: false, reason: `Daily token budget exhausted (${usage.daily}/${limits.daily})` };
    }

    if (limits.hourly > 0 && usage.hourly >= limits.hourly) {
      return { allowed: false, reason: `Hourly token budget exhausted (${usage.hourly}/${limits.hourly})` };
    }

    return { allowed: true };
  }

  /** Get token allocation status for all tracked engines. */
  getStatus(): EngineTokenAllocation[] {
    const engines = DEFAULT_ENGINE_BUDGETS.map(b => b.engine);
    return engines.map(e => this.getEngineStatus(e)).filter((s): s is EngineTokenAllocation => s !== null);
  }

  /** Get token allocation status for a specific engine. */
  getEngineStatus(engineId: string): EngineTokenAllocation | null {
    const limits = this.getLimits(engineId);
    if (!limits) return null;

    const usage = this.getUsage(engineId);
    const hourlyPercent = limits.hourly > 0 ? (usage.hourly / limits.hourly) * 100 : 0;
    const dailyPercent = limits.daily > 0 ? (usage.daily / limits.daily) * 100 : 0;
    const maxPercent = Math.max(hourlyPercent, dailyPercent);

    return {
      engineId,
      hourlyLimit: limits.hourly,
      dailyLimit: limits.daily,
      hourlyUsed: usage.hourly,
      dailyUsed: usage.daily,
      hourlyPercent,
      dailyPercent,
      status: maxPercent >= 100 ? 'exhausted' : maxPercent >= 80 ? 'warning' : 'ok',
    };
  }

  /**
   * Reserve tokens before an LLM call. Returns a reservation ID if allowed,
   * or null if budget is exhausted. This prevents race conditions where
   * multiple concurrent calls all pass checkBudget() before any tokens are recorded.
   */
  reserveTokens(engineId: string, estimatedTokens: number): string | null {
    const limits = this.getLimits(engineId);
    if (!limits) return `res_${++this.reservationCounter}`; // no budget configured → always allow

    const usage = this.getUsage(engineId);
    const reserved = this.getReservedTokens(engineId);

    const effectiveHourly = usage.hourly + reserved;
    const effectiveDaily = usage.daily + reserved;

    if (limits.daily > 0 && (effectiveDaily + estimatedTokens) > limits.daily) {
      return null;
    }
    if (limits.hourly > 0 && (effectiveHourly + estimatedTokens) > limits.hourly) {
      return null;
    }

    const id = `res_${++this.reservationCounter}`;
    this.reservations.set(id, { engineId, estimatedTokens, reservedAt: Date.now() });
    return id;
  }

  /**
   * Release a reservation after the LLM call completes.
   * Call this regardless of success/failure to clean up the reservation.
   * Invalidates the usage cache for the engine so next check reads fresh DB data.
   */
  releaseReservation(reservationId: string): void {
    const res = this.reservations.get(reservationId);
    if (res) {
      this.cache.delete(res.engineId); // invalidate cache — DB may have new usage
      this.reservations.delete(reservationId);
    }
  }

  /** Get total reserved (in-flight) tokens for an engine. */
  private getReservedTokens(engineId: string): number {
    let total = 0;
    const staleThreshold = Date.now() - 120_000; // 2min timeout for stale reservations
    for (const [id, res] of this.reservations) {
      if (res.reservedAt < staleThreshold) {
        this.reservations.delete(id); // auto-clean stale reservations
        continue;
      }
      if (res.engineId === engineId) {
        total += res.estimatedTokens;
      }
    }
    return total;
  }

  // ── Private ─────────────────────────────────────────────

  private getLimits(engineId: string): { hourly: number; daily: number } | null {
    // Try ParameterRegistry first (allows runtime tuning)
    if (this.parameterRegistry) {
      try {
        const hourly = this.parameterRegistry.get(engineId, 'token_budget_hourly');
        const daily = this.parameterRegistry.get(engineId, 'token_budget_daily');
        if (hourly != null && daily != null) {
          return { hourly, daily };
        }
      } catch {
        // Parameter not registered
      }
    }

    // Fallback to defaults
    const def = DEFAULT_ENGINE_BUDGETS.find(b => b.engine === engineId);
    if (def) return { hourly: def.hourly, daily: def.daily };

    return null;
  }

  private getUsage(engineId: string): { hourly: number; daily: number } {
    const now = Date.now();
    const cached = this.cache.get(engineId);
    if (cached && (now - cached.fetchedAt) < this.cacheTtlMs) {
      return { hourly: cached.hourly, daily: cached.daily };
    }

    try {
      const hourlyRow = this.db.prepare(`
        SELECT COALESCE(SUM(total_tokens), 0) as tokens
        FROM llm_usage
        WHERE source_engine = ? AND cached = 0
          AND created_at > datetime('now', '-1 hours')
      `).get(engineId) as { tokens: number };

      const dailyRow = this.db.prepare(`
        SELECT COALESCE(SUM(total_tokens), 0) as tokens
        FROM llm_usage
        WHERE source_engine = ? AND cached = 0
          AND created_at > datetime('now', '-24 hours')
      `).get(engineId) as { tokens: number };

      const result = { hourly: hourlyRow.tokens, daily: dailyRow.tokens };
      this.cache.set(engineId, { ...result, fetchedAt: now });
      return result;
    } catch {
      return { hourly: 0, daily: 0 };
    }
  }
}
