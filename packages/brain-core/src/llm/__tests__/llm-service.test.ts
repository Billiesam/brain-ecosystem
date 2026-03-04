import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { LLMService, runLLMServiceMigration } from '../llm-service.js';
import type { LLMServiceConfig, LLMResponse, PromptTemplate } from '../llm-service.js';

function createTestDb(): Database.Database {
  return new Database(':memory:');
}

describe('LLMService', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  // ── Migration ──────────────────────────────────────

  describe('runLLMServiceMigration', () => {
    it('creates llm_usage table', () => {
      runLLMServiceMigration(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_usage'").all();
      expect(tables).toHaveLength(1);
    });

    it('is idempotent', () => {
      runLLMServiceMigration(db);
      runLLMServiceMigration(db);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='llm_usage'").all();
      expect(tables).toHaveLength(1);
    });

    it('creates indexes', () => {
      runLLMServiceMigration(db);
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_llm_%'").all();
      expect(indexes.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Constructor & isAvailable ──────────────────────

  describe('constructor', () => {
    it('constructs without API key', () => {
      const svc = new LLMService(db, {});
      expect(svc.isAvailable()).toBe(false);
    });

    it('constructs with API key', () => {
      const svc = new LLMService(db, { apiKey: 'test-key-123' });
      expect(svc.isAvailable()).toBe(true);
    });

    it('uses env var if no config key', () => {
      const original = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'env-key-456';
      try {
        const svc = new LLMService(db, {});
        expect(svc.isAvailable()).toBe(true);
      } finally {
        if (original !== undefined) {
          process.env.ANTHROPIC_API_KEY = original;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });
  });

  // ── getStats ───────────────────────────────────────

  describe('getStats', () => {
    it('returns initial zero stats', () => {
      const svc = new LLMService(db, {});
      const stats = svc.getStats();
      expect(stats.totalCalls).toBe(0);
      expect(stats.totalTokens).toBe(0);
      expect(stats.cacheHits).toBe(0);
      expect(stats.cacheMisses).toBe(0);
      expect(stats.cacheHitRate).toBe(0);
      expect(stats.callsThisHour).toBe(0);
      expect(stats.tokensThisHour).toBe(0);
      expect(stats.tokensToday).toBe(0);
      expect(stats.rateLimitHits).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.lastCallAt).toBeNull();
      expect(stats.averageLatencyMs).toBe(0);
    });

    it('has correct budget remaining', () => {
      const svc = new LLMService(db, {
        tokenBudgetPerHour: 50_000,
        tokenBudgetPerDay: 200_000,
      });
      const stats = svc.getStats();
      expect(stats.budgetRemainingHour).toBe(50_000);
      expect(stats.budgetRemainingDay).toBe(200_000);
    });

    it('reports configured model', () => {
      const svc = new LLMService(db, { model: 'claude-test-model' });
      expect(svc.getStats().model).toBe('claude-test-model');
    });
  });

  // ── call (without API key) ─────────────────────────

  describe('call', () => {
    it('returns null when no API key', async () => {
      const svc = new LLMService(db, {});
      const result = await svc.call('explain', 'test message');
      expect(result).toBeNull();
    });
  });

  // ── call (with mocked fetch) ───────────────────────

  describe('call with mocked API', () => {
    let svc: LLMService;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      svc = new LLMService(db, {
        apiKey: 'test-key',
        maxCallsPerHour: 5,
        tokenBudgetPerHour: 10_000,
        tokenBudgetPerDay: 50_000,
      });

      fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Test response from Claude' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('makes API call and returns response', async () => {
      const result = await svc.call('explain', 'What is momentum trading?');
      expect(result).not.toBeNull();
      expect(result!.text).toBe('Test response from Claude');
      expect(result!.tokensUsed).toBe(150);
      expect(result!.inputTokens).toBe(100);
      expect(result!.outputTokens).toBe(50);
      expect(result!.cached).toBe(false);
    });

    it('sends correct headers', async () => {
      await svc.call('explain', 'test');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const callArgs = fetchMock.mock.calls[0];
      expect(callArgs[0]).toBe('https://api.anthropic.com/v1/messages');
      expect(callArgs[1].headers['x-api-key']).toBe('test-key');
      expect(callArgs[1].headers['anthropic-version']).toBe('2023-06-01');
    });

    it('sends template system prompt', async () => {
      await svc.call('creative_hypothesis', 'test');
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.system).toContain('creative research hypothesis generator');
      expect(body.messages[0].content).toBe('test');
    });

    it('updates stats after call', async () => {
      await svc.call('explain', 'test');
      const stats = svc.getStats();
      expect(stats.totalCalls).toBe(1);
      expect(stats.totalTokens).toBe(150);
      expect(stats.callsThisHour).toBe(1);
      expect(stats.tokensThisHour).toBe(150);
      expect(stats.lastCallAt).not.toBeNull();
      expect(stats.cacheMisses).toBe(1);
    });

    it('caches identical requests', async () => {
      const r1 = await svc.call('explain', 'same question');
      const r2 = await svc.call('explain', 'same question');
      expect(fetchMock).toHaveBeenCalledTimes(1); // Only 1 API call
      expect(r2!.cached).toBe(true);
      expect(r2!.text).toBe(r1!.text);

      const stats = svc.getStats();
      expect(stats.cacheHits).toBe(1);
      expect(stats.cacheMisses).toBe(1);
      expect(stats.cacheHitRate).toBeCloseTo(0.5);
    });

    it('different templates hit different cache keys', async () => {
      await svc.call('explain', 'same text');
      await svc.call('ask', 'same text');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('enforces rate limit', async () => {
      // max 5 calls per hour
      for (let i = 0; i < 5; i++) {
        const r = await svc.call('explain', `q${i}`);
        expect(r).not.toBeNull();
      }
      // 6th call should be rate limited
      const r6 = await svc.call('explain', 'q5');
      expect(r6).toBeNull();
      expect(svc.getStats().rateLimitHits).toBeGreaterThan(0);
    });

    it('handles API errors gracefully', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'Rate limited by Anthropic',
      });
      const result = await svc.call('explain', 'test');
      expect(result).toBeNull();
      expect(svc.getStats().errors).toBe(1);
    });

    it('handles network errors gracefully', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));
      const result = await svc.call('explain', 'test');
      expect(result).toBeNull();
      expect(svc.getStats().errors).toBe(1);
    });

    it('records usage to database', async () => {
      await svc.call('explain', 'test db recording');
      const rows = db.prepare('SELECT * FROM llm_usage').all() as Array<{
        template: string; total_tokens: number; cached: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].template).toBe('explain');
      expect(rows[0].total_tokens).toBe(150);
      expect(rows[0].cached).toBe(0);
    });

    it('records cached hits to database too', async () => {
      await svc.call('explain', 'test caching');
      await svc.call('explain', 'test caching'); // cached
      const rows = db.prepare('SELECT * FROM llm_usage ORDER BY id').all() as Array<{
        cached: number;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].cached).toBe(0);
      expect(rows[1].cached).toBe(1);
    });

    it('respects custom maxTokens and temperature', async () => {
      await svc.call('explain', 'test', { maxTokens: 512, temperature: 0.3 });
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.max_tokens).toBe(512);
      expect(body.temperature).toBe(0.3);
    });
  });

  // ── getUsageHistory ────────────────────────────────

  describe('getUsageHistory', () => {
    it('returns empty when no data', () => {
      const svc = new LLMService(db, {});
      expect(svc.getUsageHistory()).toEqual([]);
    });

    it('groups by hour after manual insert', () => {
      const svc = new LLMService(db, {});
      // Insert test data
      db.prepare(
        "INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
      ).run('hash1', 'explain', 'test-model', 100, 50, 150, 500, 0);
      db.prepare(
        "INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
      ).run('hash2', 'ask', 'test-model', 80, 40, 120, 300, 0);

      const history = svc.getUsageHistory(24);
      expect(history).toHaveLength(1); // Both in same hour
      expect(history[0].calls).toBe(2);
      expect(history[0].tokens).toBe(270);
    });
  });

  // ── getUsageByTemplate ─────────────────────────────

  describe('getUsageByTemplate', () => {
    it('returns empty when no data', () => {
      const svc = new LLMService(db, {});
      expect(svc.getUsageByTemplate()).toEqual([]);
    });

    it('groups by template', () => {
      const svc = new LLMService(db, {});
      db.prepare(
        "INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run('h1', 'explain', 'model', 100, 50, 150, 500, 0);
      db.prepare(
        "INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run('h2', 'explain', 'model', 200, 80, 280, 600, 0);
      db.prepare(
        "INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run('h3', 'ask', 'model', 50, 30, 80, 200, 0);
      // Cached entries should be excluded
      db.prepare(
        "INSERT INTO llm_usage (prompt_hash, template, model, input_tokens, output_tokens, total_tokens, duration_ms, cached) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run('h4', 'explain', 'model', 100, 50, 150, 0, 1);

      const result = svc.getUsageByTemplate();
      expect(result).toHaveLength(2);

      const explain = result.find(r => r.template === 'explain');
      expect(explain).toBeDefined();
      expect(explain!.calls).toBe(2); // Excludes cached
      expect(explain!.tokens).toBe(430);

      const ask = result.find(r => r.template === 'ask');
      expect(ask).toBeDefined();
      expect(ask!.calls).toBe(1);
      expect(ask!.tokens).toBe(80);
    });
  });

  // ── Token budget enforcement ───────────────────────

  describe('token budget', () => {
    it('blocks calls when hourly budget exhausted', async () => {
      const svc = new LLMService(db, {
        apiKey: 'test-key',
        maxCallsPerHour: 100,
        tokenBudgetPerHour: 200, // Very small budget
        tokenBudgetPerDay: 50_000,
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // First call uses 200 tokens = budget
      const r1 = await svc.call('explain', 'first');
      expect(r1).not.toBeNull();

      // Second call should be blocked (budget exhausted)
      const r2 = await svc.call('explain', 'second');
      expect(r2).toBeNull();

      vi.unstubAllGlobals();
    });
  });

  // ── Cache eviction ─────────────────────────────────

  describe('cache', () => {
    it('evicts oldest entries when max reached', async () => {
      const svc = new LLMService(db, {
        apiKey: 'test-key',
        maxCallsPerHour: 100,
        tokenBudgetPerHour: 100_000,
        maxCacheEntries: 3,
      });

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: `response-${++callCount}` }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      await svc.call('explain', 'q1');
      await svc.call('explain', 'q2');
      await svc.call('explain', 'q3');
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // q1 should still be cached
      await svc.call('explain', 'q1');
      expect(fetchMock).toHaveBeenCalledTimes(3); // no new call

      // Add q4 — this should evict q1 (oldest)
      await svc.call('explain', 'q4');
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // q1 should be evicted, new API call needed
      await svc.call('explain', 'q1');
      expect(fetchMock).toHaveBeenCalledTimes(5);

      vi.unstubAllGlobals();
    });
  });

  // ── All templates supported ────────────────────────

  describe('templates', () => {
    it('supports all template types', async () => {
      const svc = new LLMService(db, {
        apiKey: 'test-key',
        maxCallsPerHour: 100,
        tokenBudgetPerHour: 100_000,
      });

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const templates: PromptTemplate[] = [
        'explain', 'ask', 'synthesize_debate', 'creative_hypothesis',
        'research_question', 'summarize', 'analyze_contradiction', 'custom',
      ];

      for (const template of templates) {
        const result = await svc.call(template, `test ${template}`);
        expect(result).not.toBeNull();
        expect(result!.text).toBe('ok');
      }

      expect(fetchMock).toHaveBeenCalledTimes(templates.length);

      vi.unstubAllGlobals();
    });
  });
});
