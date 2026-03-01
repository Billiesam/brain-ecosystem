import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { ThoughtStream } from '../../../src/consciousness/thought-stream.js';
import { ConsciousnessServer } from '../../../src/consciousness/consciousness-server.js';

// ── Helpers ──────────────────────────────────────────────

function fetchJson(port: number, path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchText(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data });
      });
    }).on('error', reject);
  });
}

function waitForServer(port: number, attempts = 10): Promise<void> {
  return new Promise((resolve, reject) => {
    let tried = 0;
    function tryConnect() {
      tried++;
      http.get(`http://127.0.0.1:${port}/api/state`, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (tried >= attempts) reject(new Error('Server did not start'));
        else setTimeout(tryConnect, 50);
      });
    }
    tryConnect();
  });
}

// ── Tests ────────────────────────────────────────────────

describe('ConsciousnessServer', () => {
  let thoughtStream: ThoughtStream;
  let server: ConsciousnessServer;
  const port = 19784;

  beforeEach(async () => {
    thoughtStream = new ThoughtStream(100);
    server = new ConsciousnessServer({
      port,
      thoughtStream,
      getNetworkState: () => ({ nodes: [], edges: [] }),
      getEngineStatus: () => ({}),
    });
    server.start();
    await waitForServer(port);
  });

  afterEach(() => {
    server.stop();
  });

  it('GET / should serve dashboard HTML', async () => {
    const res = await fetchText(port, '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Dashboard HTML contains either the real dashboard or fallback
    expect(res.body).toContain('<html');
  });

  it('GET /api/state should return JSON with thoughts, network, engines, status', async () => {
    thoughtStream.emit('test', 'perceiving', 'Hello');
    const state = await fetchJson(port, '/api/state');
    expect(state.thoughts).toBeDefined();
    expect(state.network).toBeDefined();
    expect(state.engines).toBeDefined();
    expect(state.status).toBeDefined();
    expect(Array.isArray(state.thoughts)).toBe(true);
  });

  it('GET /events should return SSE content type', async () => {
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
        res.destroy();
        req.destroy();
      });
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
  });

  it('SSE should broadcast thoughts', async () => {
    const receivedData = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 3000);
      let msgCount = 0;
      const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
        res.on('data', (chunk) => {
          const text = chunk.toString();
          // Skip the initial connected event
          if (text.includes('event: thought')) {
            clearTimeout(timeout);
            res.destroy();
            req.destroy();
            resolve(text);
          }
          // After first message (connected), emit a thought
          msgCount++;
          if (msgCount === 1) {
            setTimeout(() => {
              thoughtStream.emit('orchestrator', 'perceiving', 'SSE test thought');
            }, 50);
          }
        });
      });
      req.on('error', () => { /* expected when destroying */ });
    });
    expect(receivedData).toContain('thought');
    expect(receivedData).toContain('SSE test thought');
  });

  it('GET /unknown should return 404', async () => {
    const res = await fetchText(port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('getClientCount should track connected SSE clients', async () => {
    expect(server.getClientCount()).toBe(0);

    const req = http.get(`http://127.0.0.1:${port}/events`);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.getClientCount()).toBe(1);

    req.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(server.getClientCount()).toBe(0);
  });
});
