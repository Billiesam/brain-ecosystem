import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ────────────────────────────────────────────────

export interface UnifiedDashboardOptions {
  port: number;
  thoughtStream: ThoughtStream;
  getOverview: () => unknown;
  getTransferStatus: () => unknown;
  getAttentionStatus: () => unknown;
  getNotifications: () => unknown[];
  onTriggerFeedback?: () => void;
}

// ── Server ───────────────────────────────────────────────

export class UnifiedDashboardServer {
  private server: http.Server | null = null;
  private clients: Set<http.ServerResponse> = new Set();
  private unsubscribe: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private dashboardHtml: string | null = null;
  private logger = getLogger();

  constructor(private options: UnifiedDashboardOptions) {}

  start(): void {
    const { port, thoughtStream } = this.options;

    // Load dashboard HTML
    const htmlPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '../../unified-dashboard.html',
    );
    try {
      this.dashboardHtml = fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      this.dashboardHtml = '<html><body><h1>Unified Dashboard HTML not found</h1></body></html>';
    }

    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      // CORS + Security
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Dashboard
      if (url.pathname === '/' || url.pathname === '/dashboard') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(this.dashboardHtml);
        return;
      }

      // Full state snapshot
      if (url.pathname === '/api/state') {
        try {
          const state = {
            overview: this.options.getOverview(),
            transfer: this.options.getTransferStatus(),
            attention: this.options.getAttentionStatus(),
            thoughts: thoughtStream.getRecent(200),
            engines: thoughtStream.getEngineActivity(),
            stats: thoughtStream.getStats(),
            notifications: this.options.getNotifications(),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(state));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      // Trigger feedback cycle
      if (url.pathname === '/api/trigger' && req.method === 'POST') {
        if (this.options.onTriggerFeedback) {
          try {
            this.options.onTriggerFeedback();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ triggered: true }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
        } else {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Feedback trigger not configured' }));
        }
        return;
      }

      // SSE stream
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ clients: this.clients.size + 1 })}\n\n`);

        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    // Subscribe to thought stream → broadcast immediately
    this.unsubscribe = thoughtStream.onThought((thought) => {
      this.broadcast('thought', thought);
    });

    // Status snapshot every 10s
    this.statusTimer = setInterval(() => {
      if (this.clients.size > 0) {
        try {
          this.broadcast('status', {
            overview: this.options.getOverview(),
            engines: thoughtStream.getEngineActivity(),
            stats: thoughtStream.getStats(),
          });
        } catch { /* ignore errors during broadcast */ }
      }
    }, 10_000);

    // Heartbeat every 30s
    this.heartbeatTimer = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcast('heartbeat', { time: Date.now() });
      }
    }, 30_000);

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.logger.warn(`Unified dashboard port ${port} already in use — skipping`);
        this.server?.close();
        this.server = null;
      } else {
        this.logger.error(`Unified dashboard error: ${err.message}`);
      }
    });

    this.server.listen(port, () => {
      this.logger.info(`Unified dashboard started on http://localhost:${port}`);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

    for (const client of this.clients) {
      try { client.end(); } catch { /* ignore */ }
    }
    this.clients.clear();

    this.server?.close();
    this.server = null;
    this.logger.info('Unified dashboard stopped');
  }

  getClientCount(): number {
    return this.clients.size;
  }

  private broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(msg);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
