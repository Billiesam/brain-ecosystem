import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CommandCenterServer } from '../command-center-server.js';
import type { CommandCenterOptions } from '../command-center-server.js';

// ── Helpers ─────────────────────────────────────────────────

function request(
  port: number,
  path: string,
  method = 'GET',
  body?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createMockOptions(overrides: Partial<CommandCenterOptions> = {}): CommandCenterOptions {
  return {
    port: 0,
    selfName: 'brain',
    crossBrain: {
      broadcast: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue(null),
      getPeerNames: vi.fn().mockReturnValue(['trading-brain', 'marketing-brain']),
      getAvailablePeers: vi.fn().mockResolvedValue([]),
      addPeer: vi.fn(),
      removePeer: vi.fn(),
    } as unknown as CommandCenterOptions['crossBrain'],
    ecosystemService: {
      getStatus: vi.fn().mockResolvedValue({
        brains: [{ name: 'brain', available: true, version: '1.0.0', uptime: 100, pid: 1234, methods: 50 }],
        health: { score: 85, status: 'healthy', activeBrains: 1, totalEvents: 10, correlations: 0, recentErrors: 0, recentTradeLosses: 0, alerts: [] },
        correlations: [],
        recentEvents: [],
      }),
      getAggregatedAnalytics: vi.fn().mockResolvedValue({
        brain: { errors: 5, solutions: 3, modules: 10 },
      }),
      getCorrelations: vi.fn().mockReturnValue([]),
      getTimeline: vi.fn().mockReturnValue([]),
      getHealth: vi.fn().mockReturnValue({ score: 85, status: 'healthy' }),
    } as unknown as CommandCenterOptions['ecosystemService'],
    correlator: {
      getHealth: vi.fn().mockReturnValue({ score: 85, status: 'healthy' }),
      getCorrelations: vi.fn().mockReturnValue([]),
      getTimeline: vi.fn().mockReturnValue([]),
    } as unknown as CommandCenterOptions['correlator'],
    watchdog: null,
    pluginRegistry: null,
    borgSync: null,
    ...overrides,
  };
}

function startServer(
  overrides: Partial<CommandCenterOptions> = {},
): Promise<{ server: CommandCenterServer; port: number }> {
  return new Promise((resolve) => {
    const opts = createMockOptions(overrides);
    const server = new CommandCenterServer(opts);
    server.start();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = (server as any).server as http.Server;
    internal.on('listening', () => {
      const addr = internal.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('CommandCenterServer', () => {
  let server: CommandCenterServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  it('GET / returns HTML', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Should contain the fallback or real HTML
    expect(res.body).toContain('Command Center');
  });

  it('GET /api/state returns full state snapshot', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/api/state');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');

    const data = JSON.parse(res.body);
    expect(data).toHaveProperty('ecosystem');
    expect(data).toHaveProperty('engines');
    expect(data).toHaveProperty('watchdog');
    expect(data).toHaveProperty('plugins');
    expect(data).toHaveProperty('analytics');
    expect(data.ecosystem.brains).toHaveLength(1);
    expect(data.ecosystem.brains[0].name).toBe('brain');
  });

  it('GET /api/ecosystem returns ecosystem status', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/api/ecosystem');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.brains).toBeInstanceOf(Array);
    expect(data.health).toHaveProperty('score');
  });

  it('GET /api/engines broadcasts to peers', async () => {
    const mockBroadcast = vi.fn().mockResolvedValue([
      { name: 'brain', result: [{ engine: 'learning', thoughtCount: 5 }] },
    ]);
    const result = await startServer({
      crossBrain: {
        broadcast: mockBroadcast,
        getPeerNames: vi.fn().mockReturnValue([]),
      } as unknown as CommandCenterOptions['crossBrain'],
    });
    server = result.server;

    const res = await request(result.port, '/api/engines');
    expect(res.statusCode).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledWith('consciousness.engines');
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('brain');
  });

  it('GET /api/watchdog returns empty array when no watchdog', async () => {
    const result = await startServer({ watchdog: null });
    server = result.server;

    const res = await request(result.port, '/api/watchdog');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toEqual([]);
  });

  it('GET /api/watchdog returns daemon status when available', async () => {
    const mockWatchdog = {
      getStatus: vi.fn().mockReturnValue([
        { name: 'brain', pid: 1234, running: true, healthy: true, uptime: 5000, restarts: 0 },
      ]),
    };
    const result = await startServer({ watchdog: mockWatchdog as unknown as CommandCenterOptions['watchdog'] });
    server = result.server;

    const res = await request(result.port, '/api/watchdog');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('brain');
    expect(data[0].running).toBe(true);
  });

  it('GET /api/plugins returns empty array when no registry', async () => {
    const result = await startServer({ pluginRegistry: null });
    server = result.server;

    const res = await request(result.port, '/api/plugins');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('GET /api/plugins returns plugin list when available', async () => {
    const mockPlugins = {
      list: vi.fn().mockReturnValue([
        { name: 'test-plugin', version: '1.0.0', description: 'A test' },
      ]),
    };
    const result = await startServer({ pluginRegistry: mockPlugins as unknown as CommandCenterOptions['pluginRegistry'] });
    server = result.server;

    const res = await request(result.port, '/api/plugins');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('test-plugin');
  });

  it('GET /api/borg returns not available when no borgSync', async () => {
    const result = await startServer({ borgSync: null });
    server = result.server;

    const res = await request(result.port, '/api/borg');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.available).toBe(false);
  });

  it('GET /api/borg returns borg status when available', async () => {
    const mockBorg = {
      getStatus: vi.fn().mockReturnValue({ enabled: true, mode: 'full', totalSyncs: 5 }),
      getConfig: vi.fn().mockReturnValue({ enabled: true, mode: 'full' }),
      getHistory: vi.fn().mockReturnValue([]),
    };
    const result = await startServer({ borgSync: mockBorg as unknown as CommandCenterOptions['borgSync'] });
    server = result.server;

    const res = await request(result.port, '/api/borg');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.status.enabled).toBe(true);
    expect(data.config.mode).toBe('full');
  });

  it('GET /api/analytics returns aggregated analytics', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/api/analytics');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.brain).toEqual({ errors: 5, solutions: 3, modules: 10 });
  });

  it('POST /api/borg/toggle toggles borg sync', async () => {
    const mockBorg = {
      getStatus: vi.fn().mockReturnValue({ enabled: false }),
      getConfig: vi.fn().mockReturnValue({}),
      getHistory: vi.fn().mockReturnValue([]),
      setEnabled: vi.fn(),
    };
    const result = await startServer({ borgSync: mockBorg as unknown as CommandCenterOptions['borgSync'] });
    server = result.server;

    const res = await request(result.port, '/api/borg/toggle', 'POST', JSON.stringify({ enabled: true }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.toggled).toBe(true);
    expect(mockBorg.setEnabled).toHaveBeenCalledWith(true);
  });

  it('POST /api/borg/toggle returns 501 when no borgSync', async () => {
    const result = await startServer({ borgSync: null });
    server = result.server;

    const res = await request(result.port, '/api/borg/toggle', 'POST', JSON.stringify({ enabled: true }));
    expect(res.statusCode).toBe(501);
  });

  it('POST /api/borg/toggle returns 400 on invalid body', async () => {
    const mockBorg = {
      getStatus: vi.fn().mockReturnValue({ enabled: false }),
      getConfig: vi.fn().mockReturnValue({}),
      getHistory: vi.fn().mockReturnValue([]),
      setEnabled: vi.fn(),
    };
    const result = await startServer({ borgSync: mockBorg as unknown as CommandCenterOptions['borgSync'] });
    server = result.server;

    const res = await request(result.port, '/api/borg/toggle', 'POST', JSON.stringify({ foo: 'bar' }));
    expect(res.statusCode).toBe(400);
  });

  it('GET /events returns SSE stream', async () => {
    const result = await startServer();
    server = result.server;

    const sseData = await new Promise<string>((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: result.port, path: '/events' }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream');
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          // After first event, resolve
          if (data.includes('event: connected')) {
            res.destroy();
            resolve(data);
          }
        });
      });
      req.on('error', (err) => {
        if (err.message.includes('socket hang up')) return;
        reject(err);
      });
      req.end();
    });

    expect(sseData).toContain('event: connected');
  });

  it('GET /nonexistent returns 404', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/nonexistent');
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('Not Found');
  });

  it('OPTIONS returns 204 with CORS headers', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/', 'OPTIONS');
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('sets CORS headers on all responses', async () => {
    const result = await startServer();
    server = result.server;

    const res = await request(result.port, '/api/ecosystem');
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('stop() closes the server', async () => {
    const result = await startServer();
    server = result.server;

    const resBefore = await request(result.port, '/api/watchdog');
    expect(resBefore.statusCode).toBe(200);

    server.stop();
    server = null;

    await expect(request(result.port, '/')).rejects.toThrow();
  });
});
