import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouter } from '../../../src/messaging/message-router.js';
import type { IncomingMessage } from '../../../src/messaging/message-router.js';

function makeMsg(text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    text,
    senderId: 'user-1',
    senderName: 'TestUser',
    platform: 'telegram',
    ...overrides,
  };
}

describe('MessageRouter', () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
  });

  // ── Help Command ──────────────────────────────────

  it('responds to /help with command list', async () => {
    const res = await router.route(makeMsg('/help'));
    expect(res.text).toContain('/status');
    expect(res.text).toContain('/query');
    expect(res.text).toContain('/intel');
    expect(res.text).toContain('/mission');
  });

  // ── Unknown Command ───────────────────────────────

  it('responds to unknown command with hint', async () => {
    const res = await router.route(makeMsg('/foobar'));
    expect(res.text).toContain('Unbekannter Befehl');
    expect(res.text).toContain('/help');
  });

  // ── Access Control ────────────────────────────────

  it('blocks unauthorized senders', async () => {
    const restricted = new MessageRouter({ allowedSenders: ['admin-1'] });
    const res = await restricted.route(makeMsg('/help', { senderId: 'user-999' }));
    expect(res.text).toContain('Zugriff verweigert');
  });

  it('allows authorized senders', async () => {
    const restricted = new MessageRouter({ allowedSenders: ['admin-1'] });
    const res = await restricted.route(makeMsg('/help', { senderId: 'admin-1' }));
    expect(res.text).toContain('/status');
  });

  // ── Free Text without IPC ────────────────────────

  it('responds to free text without IPC with hint', async () => {
    const res = await router.route(makeMsg('Was ist ein Bug?'));
    expect(res.text).toContain('/help');
  });

  // ── Custom Command Prefix ────────────────────────

  it('supports custom command prefix', async () => {
    const custom = new MessageRouter({ commandPrefix: '!' });
    const res = await custom.route(makeMsg('!help'));
    expect(res.text).toContain('!status');
  });

  // ── IPC Dispatch ─────────────────────────────────

  it('dispatches /status to IPC', async () => {
    const mockIpc = {
      request: vi.fn().mockResolvedValue({ name: 'brain', version: '3.0.0', uptime: 42, pid: 1234, methods: 100 }),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('/status'));
    expect(mockIpc.request).toHaveBeenCalledWith('status', {});
    expect(res.text).toContain('brain');
    expect(res.text).toContain('3.0.0');
    expect(res.code).toBe(true);
  });

  it('dispatches /query to IPC', async () => {
    const mockIpc = {
      request: vi.fn().mockResolvedValue({ results: [{ title: 'TypeError fix', score: 0.95 }] }),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('/query TypeError'));
    expect(mockIpc.request).toHaveBeenCalledWith('error.search', { query: 'TypeError', limit: 5 });
    expect(res.text).toContain('TypeError fix');
  });

  it('dispatches /mission to IPC', async () => {
    const mockIpc = {
      request: vi.fn().mockResolvedValue({ id: 'mission-123' }),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('/mission AI trends'));
    expect(mockIpc.request).toHaveBeenCalledWith('mission.create', { topic: 'AI trends', depth: 'standard' });
    expect(res.text).toContain('mission-123');
  });

  it('dispatches /traces to IPC', async () => {
    const mockIpc = {
      request: vi.fn().mockResolvedValue({ totalTraces: 10, totalSpans: 50, totalTokens: 1000, totalCost: 0.05, activeTraces: 2, avgDurationMs: 500 }),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('/traces'));
    expect(res.text).toContain('10');
    expect(res.text).toContain('50');
    expect(res.code).toBe(true);
  });

  // ── Free Text with IPC ───────────────────────────

  it('dispatches free text to query when IPC connected', async () => {
    const mockIpc = {
      request: vi.fn().mockResolvedValue({ results: [{ title: 'Found something' }] }),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('how to fix memory leak'));
    expect(mockIpc.request).toHaveBeenCalledWith('query', { query: 'how to fix memory leak' });
    expect(res.text).toContain('Found something');
  });

  it('handles empty query results', async () => {
    const mockIpc = {
      request: vi.fn().mockResolvedValue({ results: [] }),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('abcxyz'));
    expect(res.text).toContain('Keine Ergebnisse');
  });

  // ── Error Handling ───────────────────────────────

  it('handles IPC errors gracefully', async () => {
    const mockIpc = {
      request: vi.fn().mockRejectedValue(new Error('connection refused')),
    };
    router.setIpcClient(mockIpc as never);

    const res = await router.route(makeMsg('/status'));
    expect(res.text).toContain('fehlgeschlagen');
  });

  // ── Custom Intent ────────────────────────────────

  it('supports custom intent registration', async () => {
    router.registerIntent('ping', async () => ({ text: 'pong!' }));
    const res = await router.route(makeMsg('/ping'));
    expect(res.text).toBe('pong!');
  });

  // ── Status ───────────────────────────────────────

  it('tracks message stats', async () => {
    await router.route(makeMsg('/help'));
    await router.route(makeMsg('/help'));
    await router.route(makeMsg('/unknown'));

    const status = router.getStatus();
    expect(status.messagesReceived).toBe(3);
    expect(status.messagesRouted).toBe(2);
    expect(status.lastMessageAt).not.toBeNull();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  // ── Platform Agnostic ────────────────────────────

  it('works with discord platform', async () => {
    const res = await router.route(makeMsg('/help', { platform: 'discord' }));
    expect(res.text).toContain('/status');
  });

  // ── /query without args ──────────────────────────

  it('requires args for /query', async () => {
    const res = await router.route(makeMsg('/query'));
    expect(res.text).toContain('Suchtext');
  });

  it('requires args for /mission', async () => {
    const res = await router.route(makeMsg('/mission'));
    expect(res.text).toContain('Thema');
  });
});
