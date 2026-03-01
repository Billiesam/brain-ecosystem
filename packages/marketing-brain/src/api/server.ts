import http from 'node:http';
import { getLogger } from '../utils/logger.js';
import type { IpcRouter } from '../ipc/router.js';
import { RateLimiter, applySecurityHeaders, readBodyWithLimit } from '@timmeck/brain-core';
import { validateParams } from '@timmeck/brain-core';

interface ApiServerOptions {
  port: number;
  router: IpcRouter;
  apiKey?: string;
  healthCheck?: () => Record<string, unknown>;
}

export class ApiServer {
  private server: http.Server | null = null;
  private logger = getLogger();
  private rateLimiter = new RateLimiter();

  constructor(private opts: ApiServerOptions) {}

  start(): void {
    this.server = http.createServer((req, res) => {
      // Security headers
      applySecurityHeaders(res);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Rate limiting (skip health)
      const url = req.url ?? '/';
      if (url !== '/api/v1/health' && url !== '/api/v1/ready') {
        const limit = this.rateLimiter.check(req);
        res.setHeader('X-RateLimit-Remaining', String(limit.remaining));
        if (!limit.allowed) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too Many Requests' }));
          return;
        }
      }

      // Auth check
      if (this.opts.apiKey) {
        const auth = req.headers.authorization;
        if (!auth || auth !== `Bearer ${this.opts.apiKey}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Health check (deep)
      if (url === '/api/v1/health') {
        const base = { status: 'ok', service: 'marketing-brain', uptime: Math.floor(process.uptime()), memory: Math.floor(process.memoryUsage().rss / 1024 / 1024) };
        const extra = this.opts.healthCheck?.() ?? {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...base, ...extra }));
        return;
      }

      // Readiness probe
      if (url === '/api/v1/ready') {
        const extra = this.opts.healthCheck?.() ?? {};
        const ready = extra.db !== false && extra.ipc !== false;
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready, ...extra }));
        return;
      }

      // Methods list
      if (url === '/api/v1/methods') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ methods: this.opts.router.listMethods() }));
        return;
      }

      // RPC endpoint
      if (url === '/api/v1/rpc' && req.method === 'POST') {
        readBodyWithLimit(req).then(bodyResult => {
          if (bodyResult.error) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: bodyResult.error }));
            return;
          }
          try {
            const { method, params } = JSON.parse(bodyResult.body!);
            const validated = validateParams(params);
            const result = this.opts.router.handle(method, validated);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    this.server.listen(this.opts.port, () => {
      this.logger.info(`API server listening on port ${this.opts.port}`);
    });
  }

  stop(): void {
    this.rateLimiter.stop();
    this.server?.close();
    this.server = null;
    this.logger.info('API server stopped');
  }
}
