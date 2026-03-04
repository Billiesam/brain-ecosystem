import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface LLMServiceConfig {
  /** Anthropic API key. Falls back to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Model to use. Default: claude-sonnet-4-20250514 */
  model?: string;
  /** Max tokens per request. Default: 2048 */
  maxTokens?: number;
  /** Max API calls per hour. Default: 30 */
  maxCallsPerHour?: number;
  /** Max tokens per hour budget. Default: 100_000 */
  tokenBudgetPerHour?: number;
  /** Max tokens per day budget. Default: 500_000 */
  tokenBudgetPerDay?: number;
  /** Cache TTL in ms. Default: 3_600_000 (1 hour) */
  cacheTtlMs?: number;
  /** Max cache entries. Default: 500 */
  maxCacheEntries?: number;
}

export interface LLMResponse {
  text: string;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  model: string;
  durationMs: number;
}

export interface LLMUsageStats {
  totalCalls: number;
  totalTokens: number;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number;
  callsThisHour: number;
  tokensThisHour: number;
  tokensToday: number;
  budgetRemainingHour: number;
  budgetRemainingDay: number;
  averageLatencyMs: number;
  rateLimitHits: number;
  errors: number;
  lastCallAt: number | null;
  model: string;
}

export type PromptTemplate =
  | 'explain'
  | 'ask'
  | 'synthesize_debate'
  | 'creative_hypothesis'
  | 'research_question'
  | 'summarize'
  | 'analyze_contradiction'
  | 'custom';

interface CacheEntry {
  response: LLMResponse;
  expiresAt: number;
}

interface CallRecord {
  timestamp: number;
  tokens: number;
}

// ── Migration ───────────────────────────────────────────

export function runLLMServiceMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_hash TEXT NOT NULL,
      template TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_template ON llm_usage(template);
  `);
}

// ── Prompt Templates ────────────────────────────────────

const SYSTEM_PROMPTS: Record<PromptTemplate, string> = {
  explain: `You are an analytical AI research assistant embedded in an autonomous Brain system.
Your task is to explain a topic based on the provided knowledge base (principles, hypotheses, experiments, journal entries).
Be concise, insightful, and synthesize across sources. Highlight confidence levels and knowledge gaps.
Output a coherent narrative explanation (2-4 paragraphs). Do not use markdown headers.`,

  ask: `You are an analytical AI research assistant embedded in an autonomous Brain system.
Answer the user's question based ONLY on the provided knowledge context.
If the context doesn't contain enough information, say so honestly.
Be direct and precise. Cite which sources (principle, hypothesis, experiment, journal) support your answer.`,

  synthesize_debate: `You are a debate synthesizer in an autonomous Brain system.
Multiple perspectives on a question have been gathered from different knowledge domains.
Your job is to:
1. Identify points of agreement across perspectives
2. Identify genuine conflicts and explain why they exist
3. Propose a nuanced synthesis that respects all evidence
4. Make clear recommendations based on the weight of evidence
Be balanced and analytical. Output a structured synthesis.`,

  creative_hypothesis: `You are a creative research hypothesis generator in an autonomous Brain system.
Given the current knowledge base (confirmed principles, existing hypotheses, anomalies, patterns),
generate novel, testable hypotheses that push the boundaries of current understanding.
Each hypothesis should:
- Be specific and falsifiable
- Connect to existing evidence
- Explore non-obvious relationships
- Include what variables to track
Output exactly the requested number of hypotheses in JSON format.`,

  research_question: `You are a research question generator in an autonomous Brain system.
Given knowledge gaps and topics of interest, generate precise, actionable research questions.
Questions should be specific enough to guide investigation and lead to measurable outcomes.
Consider what data or experiments could answer each question.`,

  summarize: `You are a summarizer in an autonomous Brain system.
Condense the provided information into a clear, concise summary.
Preserve key insights, numbers, and conclusions. Remove redundancy.`,

  analyze_contradiction: `You are a contradiction analyzer in an autonomous Brain system.
Two pieces of knowledge appear to conflict. Analyze:
1. Are they truly contradictory, or is the conflict apparent?
2. What context or conditions might make both true?
3. What evidence favors each side?
4. What experiment or data could resolve the contradiction?`,

  custom: `You are an AI research assistant embedded in an autonomous Brain system.
Follow the user's instructions precisely.`,
};

// ── Service ─────────────────────────────────────────────

export class LLMService {
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly maxCallsPerHour: number;
  private readonly tokenBudgetPerHour: number;
  private readonly tokenBudgetPerDay: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly log = getLogger();

  // In-memory state
  private cache = new Map<string, CacheEntry>();
  private callHistory: CallRecord[] = [];
  private stats = {
    totalCalls: 0,
    totalTokens: 0,
    cacheHits: 0,
    cacheMisses: 0,
    rateLimitHits: 0,
    errors: 0,
    totalLatencyMs: 0,
    lastCallAt: null as number | null,
  };

  // Prepared statements (lazy-initialized)
  private stmtInsertUsage: Database.Statement | null = null;

  constructor(private db: Database.Database, config: LLMServiceConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? null;
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.maxTokens = config.maxTokens ?? 2048;
    this.maxCallsPerHour = config.maxCallsPerHour ?? 30;
    this.tokenBudgetPerHour = config.tokenBudgetPerHour ?? 100_000;
    this.tokenBudgetPerDay = config.tokenBudgetPerDay ?? 500_000;
    this.cacheTtlMs = config.cacheTtlMs ?? 3_600_000;
    this.maxCacheEntries = config.maxCacheEntries ?? 500;

    runLLMServiceMigration(db);

    this.stmtInsertUsage = db.prepare(
      'INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    this.log.debug(`[LLMService] Initialized (model=${this.model}, apiKey=${this.apiKey ? 'set' : 'NOT SET'}, budget=${this.tokenBudgetPerHour}/h)`);
  }

  /** Check if LLM is available (API key set). */
  isAvailable(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  /**
   * Main entry point: call Claude with a template + context.
   * Returns null if budget exhausted or API key not set (caller should fallback to heuristic).
   */
  async call(
    template: PromptTemplate,
    userMessage: string,
    options?: { maxTokens?: number; temperature?: number },
  ): Promise<LLMResponse | null> {
    if (!this.isAvailable()) return null;

    // Check rate limit
    if (!this.checkRateLimit()) {
      this.stats.rateLimitHits++;
      this.log.debug('[LLMService] Rate limit reached, falling back to heuristic');
      return null;
    }

    // Check token budget
    if (!this.checkTokenBudget()) {
      this.stats.rateLimitHits++;
      this.log.debug('[LLMService] Token budget exhausted, falling back to heuristic');
      return null;
    }

    // Check cache
    const cacheKey = this.getCacheKey(template, userMessage);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      this.recordUsage(cacheKey, template, cached, true);
      return { ...cached, cached: true };
    }
    this.stats.cacheMisses++;

    // Make API call
    const systemPrompt = SYSTEM_PROMPTS[template];
    const start = Date.now();

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: options?.maxTokens ?? this.maxTokens,
          ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      const durationMs = Date.now() - start;

      if (!response.ok) {
        const errText = await response.text();
        this.stats.errors++;
        this.log.warn(`[LLMService] API error (${response.status}): ${errText.substring(0, 200)}`);
        return null;
      }

      const data = await response.json() as {
        content: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const text = data.content
        ?.filter(c => c.type === 'text')
        .map(c => c.text ?? '')
        .join('\n') ?? '';

      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      const totalTokens = inputTokens + outputTokens;

      const result: LLMResponse = {
        text,
        tokensUsed: totalTokens,
        inputTokens,
        outputTokens,
        cached: false,
        model: this.model,
        durationMs,
      };

      // Update stats
      this.stats.totalCalls++;
      this.stats.totalTokens += totalTokens;
      this.stats.totalLatencyMs += durationMs;
      this.stats.lastCallAt = Date.now();
      this.callHistory.push({ timestamp: Date.now(), tokens: totalTokens });

      // Cache the response
      this.setCache(cacheKey, result);

      // Record to DB
      this.recordUsage(cacheKey, template, result, false);

      this.log.debug(`[LLMService] ${template}: ${totalTokens} tokens, ${durationMs}ms`);

      return result;
    } catch (err) {
      this.stats.errors++;
      this.log.warn(`[LLMService] Call failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Get usage statistics. */
  getStats(): LLMUsageStats {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    this.pruneCallHistory();

    const callsThisHour = this.callHistory.filter(c => c.timestamp > oneHourAgo).length;
    const tokensThisHour = this.callHistory.filter(c => c.timestamp > oneHourAgo).reduce((s, c) => s + c.tokens, 0);
    const tokensToday = this.callHistory.filter(c => c.timestamp > oneDayAgo).reduce((s, c) => s + c.tokens, 0);

    return {
      totalCalls: this.stats.totalCalls,
      totalTokens: this.stats.totalTokens,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0
        ? this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)
        : 0,
      callsThisHour,
      tokensThisHour,
      tokensToday,
      budgetRemainingHour: Math.max(0, this.tokenBudgetPerHour - tokensThisHour),
      budgetRemainingDay: Math.max(0, this.tokenBudgetPerDay - tokensToday),
      averageLatencyMs: this.stats.totalCalls > 0 ? this.stats.totalLatencyMs / this.stats.totalCalls : 0,
      rateLimitHits: this.stats.rateLimitHits,
      errors: this.stats.errors,
      lastCallAt: this.stats.lastCallAt,
      model: this.model,
    };
  }

  /** Get usage history from DB (for dashboard). */
  getUsageHistory(hours = 24): Array<{ hour: string; calls: number; tokens: number; cached: number }> {
    try {
      return this.db.prepare(`
        SELECT strftime('%Y-%m-%d %H:00', created_at) as hour,
               COUNT(*) as calls,
               SUM(total_tokens) as tokens,
               SUM(cached) as cached
        FROM llm_usage
        WHERE created_at > datetime('now', '-' || ? || ' hours')
        GROUP BY hour
        ORDER BY hour DESC
      `).all(hours) as Array<{ hour: string; calls: number; tokens: number; cached: number }>;
    } catch {
      return [];
    }
  }

  /** Get usage breakdown by template. */
  getUsageByTemplate(): Array<{ template: string; calls: number; tokens: number; avg_tokens: number }> {
    try {
      return this.db.prepare(`
        SELECT template,
               COUNT(*) as calls,
               SUM(total_tokens) as tokens,
               AVG(total_tokens) as avg_tokens
        FROM llm_usage
        WHERE cached = 0
        GROUP BY template
        ORDER BY tokens DESC
      `).all() as Array<{ template: string; calls: number; tokens: number; avg_tokens: number }>;
    } catch {
      return [];
    }
  }

  // ── Private Helpers ────────────────────────────────────

  private checkRateLimit(): boolean {
    const oneHourAgo = Date.now() - 3_600_000;
    this.pruneCallHistory();
    const recentCalls = this.callHistory.filter(c => c.timestamp > oneHourAgo).length;
    return recentCalls < this.maxCallsPerHour;
  }

  private checkTokenBudget(): boolean {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    const tokensThisHour = this.callHistory.filter(c => c.timestamp > oneHourAgo).reduce((s, c) => s + c.tokens, 0);
    if (tokensThisHour >= this.tokenBudgetPerHour) return false;

    const tokensToday = this.callHistory.filter(c => c.timestamp > oneDayAgo).reduce((s, c) => s + c.tokens, 0);
    if (tokensToday >= this.tokenBudgetPerDay) return false;

    return true;
  }

  private getCacheKey(template: PromptTemplate, userMessage: string): string {
    const input = `${template}:${this.model}:${userMessage}`;
    return createHash('sha256').update(input).digest('hex');
  }

  private getFromCache(key: string): LLMResponse | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.response;
  }

  private setCache(key: string, response: LLMResponse): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxCacheEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  private pruneCallHistory(): void {
    const oneDayAgo = Date.now() - 86_400_000;
    this.callHistory = this.callHistory.filter(c => c.timestamp > oneDayAgo);
  }

  private recordUsage(hash: string, template: string, response: LLMResponse, cached: boolean): void {
    try {
      this.stmtInsertUsage?.run(
        hash,
        template,
        response.model,
        response.inputTokens,
        response.outputTokens,
        response.tokensUsed,
        response.durationMs,
        cached ? 1 : 0,
      );
    } catch {
      // Best effort — don't crash on DB error
    }
  }
}
