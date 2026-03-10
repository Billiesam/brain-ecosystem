import { describe, it, expect, vi } from 'vitest';
import { MultiBrainRouter } from '../../../src/chat/multi-brain-router.js';

describe('MultiBrainRouter', () => {
  const router = new MultiBrainRouter();

  describe('route()', () => {
    it('routes trading keywords to trading-brain', () => {
      const result = router.route('Wie performt meine trade strategie?');
      expect(result.brains).toContain('trading-brain');
    });

    it('routes error keywords to brain', () => {
      const result = router.route('Zeig mir die letzten Fehler');
      expect(result.brains).toContain('brain');
    });

    it('routes marketing keywords to marketing-brain', () => {
      const result = router.route('Wie gut performt mein content engagement?');
      expect(result.brains).toContain('marketing-brain');
    });

    it('routes system-wide queries to all brains', () => {
      const result = router.route('Wie performt das Gesamtsystem?');
      expect(result.brains).toHaveLength(3);
      expect(result.brains).toContain('brain');
      expect(result.brains).toContain('trading-brain');
      expect(result.brains).toContain('marketing-brain');
    });

    it('routes overview queries to all brains', () => {
      const result = router.route('Give me an overview of all brains');
      expect(result.brains).toHaveLength(3);
    });

    it('defaults to brain for unknown input', () => {
      const result = router.route('Was ist 42?');
      expect(result.brains).toContain('brain');
    });
  });

  describe('queryMultiple()', () => {
    it('queries multiple brains in parallel', async () => {
      const localHandler = vi.fn().mockResolvedValue({ status: 'ok' });
      const crossBrainQuery = vi.fn().mockResolvedValue({ status: 'ok' });

      const result = await router.queryMultiple(
        ['brain', 'trading-brain'],
        'brain',
        localHandler,
        crossBrainQuery,
        'status',
      );

      expect(result.responses).toHaveLength(2);
      expect(localHandler).toHaveBeenCalledWith('status', undefined);
      expect(crossBrainQuery).toHaveBeenCalledWith('trading-brain', 'status', undefined);
      expect(result.markdown).toContain('Brain');
      expect(result.markdown).toContain('Trading Brain');
    });

    it('handles timeout gracefully', async () => {
      const localHandler = vi.fn().mockResolvedValue({ ok: true });
      const crossBrainQuery = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 10_000))
      );

      const result = await router.queryMultiple(
        ['brain', 'trading-brain'],
        'brain',
        localHandler,
        crossBrainQuery,
        'status',
        undefined,
        100, // 100ms timeout
      );

      expect(result.responses).toHaveLength(2);
      const tradingResponse = result.responses.find(r => r.brain === 'trading-brain');
      expect(tradingResponse?.error).toBe('timeout');
    });
  });
});
