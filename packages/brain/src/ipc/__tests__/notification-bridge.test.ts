import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal mock services for the IpcRouter
function createMockNotificationService() {
  const store: Array<{ id: number; type: string; title: string; message: string; priority: number; acknowledged: boolean }> = [];
  let nextId = 1;

  return {
    create(input: { type: string; title: string; message: string; priority?: number }) {
      const id = nextId++;
      store.push({
        id,
        type: input.type,
        title: input.title,
        message: input.message,
        priority: input.priority ?? 0,
        acknowledged: false,
      });
      return id;
    },
    list() {
      return store.filter(n => !n.acknowledged);
    },
    acknowledge(id: number) {
      const n = store.find(s => s.id === id);
      if (n) n.acknowledged = true;
    },
    getById(id: number) {
      return store.find(s => s.id === id);
    },
    _store: store,
  };
}

describe('notification bridge IPC routes', () => {
  let notificationService: ReturnType<typeof createMockNotificationService>;

  beforeEach(() => {
    notificationService = createMockNotificationService();
  });

  describe('notification.pending', () => {
    it('returns empty array when no notifications', () => {
      const pending = notificationService.list();
      expect(pending).toEqual([]);
    });

    it('returns unacknowledged notifications', () => {
      notificationService.create({ type: 'selfmod', title: 'Test', message: '{}' });
      notificationService.create({ type: 'cross-brain:trading-brain', title: 'trade', message: '{}' });
      const pending = notificationService.list();
      expect(pending).toHaveLength(2);
      expect(pending[0].type).toBe('selfmod');
      expect(pending[1].type).toBe('cross-brain:trading-brain');
    });

    it('does not return acknowledged notifications', () => {
      const id = notificationService.create({ type: 'selfmod', title: 'Test', message: '{}' });
      notificationService.acknowledge(id);
      const pending = notificationService.list();
      expect(pending).toHaveLength(0);
    });
  });

  describe('notification.ackAll', () => {
    it('acknowledges all pending notifications', () => {
      notificationService.create({ type: 'selfmod', title: 'A', message: '{}' });
      notificationService.create({ type: 'selfmod', title: 'B', message: '{}' });
      notificationService.create({ type: 'selfmod', title: 'C', message: '{}' });

      // Simulate ackAll route logic
      const pending = notificationService.list();
      for (const n of pending) {
        notificationService.acknowledge(n.id);
      }

      expect(notificationService.list()).toHaveLength(0);
      expect(notificationService._store.every(n => n.acknowledged)).toBe(true);
    });

    it('returns acknowledged count', () => {
      notificationService.create({ type: 'a', title: 'A', message: '{}' });
      notificationService.create({ type: 'b', title: 'B', message: '{}' });

      const pending = notificationService.list();
      for (const n of pending) {
        notificationService.acknowledge(n.id);
      }

      expect(pending.length).toBe(2);
    });
  });

  describe('cross-brain.notify → notification storage', () => {
    it('stores cross-brain notifications with proper type prefix', () => {
      // Simulate cross-brain.notify handler
      const params = {
        source: 'trading-brain',
        event: 'position:closed',
        data: { pnl: 42.5, pnlPct: 2.1, symbol: 'BTC/USDT' },
        timestamp: new Date().toISOString(),
      };

      notificationService.create({
        type: `cross-brain:${params.source}`,
        title: params.event,
        message: JSON.stringify(params.data ?? {}),
        priority: (params.data as Record<string, unknown>)?.priority as number ?? 0,
      });

      const pending = notificationService.list();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe('cross-brain:trading-brain');
      expect(pending[0].title).toBe('position:closed');
      const msg = JSON.parse(pending[0].message);
      expect(msg.pnl).toBe(42.5);
      expect(msg.symbol).toBe('BTC/USDT');
    });

    it('stores marketing-brain notifications', () => {
      const params = {
        source: 'marketing-brain',
        event: 'rule:learned',
        data: { ruleId: 5, pattern: 'post at 9am', summary: 'New marketing rule: "post at 9am"' },
        timestamp: new Date().toISOString(),
      };

      notificationService.create({
        type: `cross-brain:${params.source}`,
        title: params.event,
        message: JSON.stringify(params.data ?? {}),
      });

      const pending = notificationService.list();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe('cross-brain:marketing-brain');
      const msg = JSON.parse(pending[0].message);
      expect(msg.pattern).toBe('post at 9am');
    });

    it('handles data with priority', () => {
      notificationService.create({
        type: 'cross-brain:trading-brain',
        title: 'urgent:alert',
        message: JSON.stringify({ priority: 5, msg: 'Flash crash' }),
        priority: 5,
      });

      const pending = notificationService.list();
      expect(pending[0].priority).toBe(5);
    });
  });

  describe('selfmod → notification flow', () => {
    it('creates notifications from self-improvement suggestions', () => {
      const suggestions = [
        'Tell Claude: Extract common IPC patterns into shared helper',
        'Tell Claude: Add retry logic to price fetcher',
      ];

      // Simulate the onSuggestion callback from brain.ts
      for (const s of suggestions) {
        notificationService.create({
          type: 'selfmod',
          title: 'Self-improvement suggestion',
          message: JSON.stringify({ summary: s }),
        });
      }

      const pending = notificationService.list();
      expect(pending).toHaveLength(2);
      expect(pending[0].type).toBe('selfmod');
      const msg0 = JSON.parse(pending[0].message);
      expect(msg0.summary).toContain('Extract common IPC patterns');
    });
  });
});
