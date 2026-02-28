import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../ipc/client.js', () => ({
  IpcClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  })),
}));

vi.mock('../../utils/paths.js', () => ({
  getPipeName: vi.fn((name: string) => `\\\\.\\pipe\\${name}`),
}));

import { CrossBrainSubscriptionManager } from '../subscription.js';

describe('CrossBrainSubscriptionManager', () => {
  let manager: CrossBrainSubscriptionManager;

  beforeEach(() => {
    manager = new CrossBrainSubscriptionManager('brain');
  });

  describe('getSubscriptions', () => {
    it('returns empty array initially', () => {
      expect(manager.getSubscriptions()).toEqual([]);
    });
  });

  describe('subscribe', () => {
    it('stores the subscription so getSubscriptions reflects it', async () => {
      const callback = vi.fn();
      await manager.subscribe('trading-brain', ['error:reported', 'insight:created'], callback);

      const subs = manager.getSubscriptions();
      expect(subs).toHaveLength(1);
      expect(subs[0]!.peer).toBe('trading-brain');
      expect(subs[0]!.events).toEqual(['error:reported', 'insight:created']);
      expect(subs[0]!.callback).toBe(callback);
    });
  });

  describe('handleIncomingEvent', () => {
    it('calls callback for subscribed events', async () => {
      const callback = vi.fn();
      await manager.subscribe('trading-brain', ['error:reported', 'insight:created'], callback);

      manager.handleIncomingEvent('trading-brain', 'error:reported', { errorId: 42 });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('error:reported', { errorId: 42 });
    });

    it('does NOT call callback for unsubscribed events', async () => {
      const callback = vi.fn();
      await manager.subscribe('trading-brain', ['error:reported'], callback);

      manager.handleIncomingEvent('trading-brain', 'some:other:event', { data: 1 });

      expect(callback).not.toHaveBeenCalled();
    });

    it('does NOT call callback for wrong peer', async () => {
      const callback = vi.fn();
      await manager.subscribe('trading-brain', ['error:reported'], callback);

      manager.handleIncomingEvent('marketing-brain', 'error:reported', { errorId: 1 });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('disconnectAll', () => {
    it('clears all subscriptions', async () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      await manager.subscribe('trading-brain', ['error:reported'], cb1);
      await manager.subscribe('marketing-brain', ['insight:created'], cb2);

      expect(manager.getSubscriptions()).toHaveLength(2);

      await manager.disconnectAll();

      expect(manager.getSubscriptions()).toEqual([]);
    });
  });
});
