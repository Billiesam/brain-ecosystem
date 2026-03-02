import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedDashboardServer } from '../../../src/unified/unified-server.js';
import { ThoughtStream } from '../../../src/consciousness/thought-stream.js';

describe('UnifiedDashboardServer', () => {
  let server: UnifiedDashboardServer;
  let stream: ThoughtStream;
  const port = 18788; // high port to avoid conflicts

  beforeEach(() => {
    stream = new ThoughtStream(100);
  });

  afterEach(() => {
    server?.stop();
  });

  it('should start and stop without errors', async () => {
    server = new UnifiedDashboardServer({
      port,
      thoughtStream: stream,
      getOverview: () => ({ healthScore: 85, brains: {} }),
      getTransferStatus: () => ({ totalAnalogies: 0 }),
      getAttentionStatus: () => ({ currentContext: 'coding' }),
      getNotifications: () => [],
    });

    server.start();
    // Give it a moment to bind
    await new Promise(r => setTimeout(r, 100));
    expect(server.getClientCount()).toBe(0);
    server.stop();
  });

  it('should serve API state', async () => {
    const overview = { healthScore: 92, brains: { brain: { status: 'running' } } };
    const transfer = { totalAnalogies: 5, totalTransfers: 3 };
    const attention = { currentContext: 'debugging', topTopics: [] };

    server = new UnifiedDashboardServer({
      port: port + 1,
      thoughtStream: stream,
      getOverview: () => overview,
      getTransferStatus: () => transfer,
      getAttentionStatus: () => attention,
      getNotifications: () => [],
    });

    server.start();
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port + 1}/api/state`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.overview.healthScore).toBe(92);
    expect(data.transfer.totalAnalogies).toBe(5);
    expect(data.attention.currentContext).toBe('debugging');
    expect(data.thoughts).toBeDefined();
    expect(data.engines).toBeDefined();
  });

  it('should serve dashboard HTML', async () => {
    server = new UnifiedDashboardServer({
      port: port + 2,
      thoughtStream: stream,
      getOverview: () => ({}),
      getTransferStatus: () => null,
      getAttentionStatus: () => null,
      getNotifications: () => [],
    });

    server.start();
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port + 2}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Unified Dashboard');
  });

  it('should handle trigger feedback', async () => {
    let triggered = false;

    server = new UnifiedDashboardServer({
      port: port + 3,
      thoughtStream: stream,
      getOverview: () => ({}),
      getTransferStatus: () => null,
      getAttentionStatus: () => null,
      getNotifications: () => [],
      onTriggerFeedback: () => { triggered = true; },
    });

    server.start();
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port + 3}/api/trigger`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.triggered).toBe(true);
    expect(triggered).toBe(true);
  });

  it('should return 404 for unknown routes', async () => {
    server = new UnifiedDashboardServer({
      port: port + 4,
      thoughtStream: stream,
      getOverview: () => ({}),
      getTransferStatus: () => null,
      getAttentionStatus: () => null,
      getNotifications: () => [],
    });

    server.start();
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port + 4}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it('should serve SSE events endpoint', async () => {
    server = new UnifiedDashboardServer({
      port: port + 5,
      thoughtStream: stream,
      getOverview: () => ({}),
      getTransferStatus: () => null,
      getAttentionStatus: () => null,
      getNotifications: () => [],
    });

    server.start();
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port + 5}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Read the first SSE message (connected event)
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toContain('event: connected');

    reader.cancel();
  });

  it('should filter notifications by significance', async () => {
    stream.emit('test_engine', 'analyzing', 'routine thought');
    stream.emit('test_engine', 'discovering', 'notable thought', 'notable');
    stream.emit('test_engine', 'discovering', 'breakthrough!', 'breakthrough');

    const notifications: unknown[] = [];
    const notifGetter = () => {
      return stream.getRecent(100).filter(
        (t: { significance?: string }) => t.significance === 'breakthrough' || t.significance === 'notable',
      );
    };

    server = new UnifiedDashboardServer({
      port: port + 6,
      thoughtStream: stream,
      getOverview: () => ({}),
      getTransferStatus: () => null,
      getAttentionStatus: () => null,
      getNotifications: notifGetter,
    });

    server.start();
    await new Promise(r => setTimeout(r, 100));

    const res = await fetch(`http://localhost:${port + 6}/api/state`);
    const data = await res.json();
    // notifications should only have notable + breakthrough
    expect(data.notifications.length).toBe(2);
  });
});
