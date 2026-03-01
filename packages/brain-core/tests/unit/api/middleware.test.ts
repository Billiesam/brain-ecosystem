import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { RateLimiter, readBodyWithLimit, applySecurityHeaders } from '../../../src/api/middleware.js';

// ── RateLimiter ─────────────────────────────────────────

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.stop();
  });

  it('allows requests under the limit', () => {
    limiter = new RateLimiter({ maxRequests: 5, windowMs: 60_000 });
    const req = { socket: { remoteAddress: '127.0.0.1' } };

    const result = limiter.check(req);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('blocks requests over the limit', () => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const req = { socket: { remoteAddress: '127.0.0.1' } };

    limiter.check(req); // 1
    limiter.check(req); // 2
    limiter.check(req); // 3
    const fourth = limiter.check(req); // 4 → blocked

    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it('tracks different IPs separately', () => {
    limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const req1 = { socket: { remoteAddress: '10.0.0.1' } };
    const req2 = { socket: { remoteAddress: '10.0.0.2' } };

    limiter.check(req1);
    limiter.check(req1);
    const blocked = limiter.check(req1);
    const allowed = limiter.check(req2);

    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
    expect(allowed.remaining).toBe(1);
  });

  it('resets window after expiry', () => {
    vi.useFakeTimers();
    limiter = new RateLimiter({ maxRequests: 1, windowMs: 1_000 });
    const req = { socket: { remoteAddress: '127.0.0.1' } };

    limiter.check(req); // 1 → allowed
    const blocked = limiter.check(req); // 2 → blocked
    expect(blocked.allowed).toBe(false);

    vi.advanceTimersByTime(1_001);
    const allowed = limiter.check(req); // new window → allowed
    expect(allowed.allowed).toBe(true);

    vi.useRealTimers();
  });

  it('handles missing remoteAddress', () => {
    limiter = new RateLimiter({ maxRequests: 5 });
    const req = { socket: {} as { remoteAddress?: string } };

    const result = limiter.check(req);
    expect(result.allowed).toBe(true);
  });

  it('reset() clears a specific key', () => {
    limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const req = { socket: { remoteAddress: '127.0.0.1' } };

    limiter.check(req);
    limiter.check(req); // blocked
    limiter.reset('127.0.0.1');

    const result = limiter.check(req);
    expect(result.allowed).toBe(true);
  });

  it('clear() removes all entries', () => {
    limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });

    limiter.check({ socket: { remoteAddress: '10.0.0.1' } });
    limiter.check({ socket: { remoteAddress: '10.0.0.2' } });
    limiter.clear();

    const r1 = limiter.check({ socket: { remoteAddress: '10.0.0.1' } });
    const r2 = limiter.check({ socket: { remoteAddress: '10.0.0.2' } });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
  });

  it('supports custom key extractor', () => {
    limiter = new RateLimiter({
      maxRequests: 1,
      keyExtractor: () => 'global',
    });

    limiter.check({ socket: { remoteAddress: '10.0.0.1' } });
    const result = limiter.check({ socket: { remoteAddress: '10.0.0.2' } });
    expect(result.allowed).toBe(false); // both share 'global' key
  });

  it('returns resetAt timestamp', () => {
    limiter = new RateLimiter({ maxRequests: 10, windowMs: 5_000 });
    const now = Date.now();
    const result = limiter.check({ socket: { remoteAddress: '127.0.0.1' } });

    expect(result.resetAt).toBeGreaterThanOrEqual(now);
    expect(result.resetAt).toBeLessThanOrEqual(now + 5_100);
  });
});

// ── readBodyWithLimit ───────────────────────────────────

describe('readBodyWithLimit', () => {
  function createMockRequest(body: string): import('node:http').IncomingMessage {
    const readable = new Readable({
      read() {
        this.push(Buffer.from(body));
        this.push(null);
      },
    });
    (readable as any).socket = { remoteAddress: '127.0.0.1' };
    return readable as any;
  }

  function createChunkedRequest(chunks: string[]): import('node:http').IncomingMessage {
    let i = 0;
    const readable = new Readable({
      read() {
        if (i < chunks.length) {
          this.push(Buffer.from(chunks[i]!));
          i++;
        } else {
          this.push(null);
        }
      },
    });
    (readable as any).socket = { remoteAddress: '127.0.0.1' };
    (readable as any).destroy = () => { readable.destroyed = true; };
    return readable as any;
  }

  it('reads a normal body', async () => {
    const req = createMockRequest('{"hello":"world"}');
    const result = await readBodyWithLimit(req);

    expect(result.error).toBeUndefined();
    expect(result.body).toBe('{"hello":"world"}');
  });

  it('reads empty body', async () => {
    const req = createMockRequest('');
    const result = await readBodyWithLimit(req);

    expect(result.error).toBeUndefined();
    expect(result.body).toBe('');
  });

  it('rejects body exceeding limit', async () => {
    const bigBody = 'x'.repeat(200);
    const req = createChunkedRequest([bigBody]);
    const result = await readBodyWithLimit(req, { maxBodyBytes: 100 });

    expect(result.error).toBeDefined();
    expect(result.error).toContain('exceeds limit');
  });

  it('uses default 100KB limit', async () => {
    const req = createMockRequest('short');
    const result = await readBodyWithLimit(req);

    expect(result.body).toBe('short');
  });

  it('handles request error', async () => {
    const readable = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    (readable as any).socket = { remoteAddress: '127.0.0.1' };

    const result = await readBodyWithLimit(readable as any);
    expect(result.error).toBeDefined();
  });
});

// ── applySecurityHeaders ────────────────────────────────

describe('applySecurityHeaders', () => {
  function createMockResponse(): { headers: Record<string, string>; setHeader: (k: string, v: string) => void } {
    const headers: Record<string, string> = {};
    return {
      headers,
      setHeader(key: string, value: string) { headers[key] = value; },
    };
  }

  it('sets default CORS headers', () => {
    const res = createMockResponse();
    applySecurityHeaders(res as any);

    expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
    expect(res.headers['Access-Control-Allow-Methods']).toContain('POST');
    expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  it('sets security headers', () => {
    const res = createMockResponse();
    applySecurityHeaders(res as any);

    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
    expect(res.headers['X-XSS-Protection']).toBe('1; mode=block');
    expect(res.headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('does not set HSTS by default', () => {
    const res = createMockResponse();
    applySecurityHeaders(res as any);

    expect(res.headers['Strict-Transport-Security']).toBeUndefined();
  });

  it('sets HSTS when enabled', () => {
    const res = createMockResponse();
    applySecurityHeaders(res as any, { hsts: true });

    expect(res.headers['Strict-Transport-Security']).toContain('max-age=');
    expect(res.headers['Strict-Transport-Security']).toContain('includeSubDomains');
  });

  it('allows custom CORS origins', () => {
    const res = createMockResponse();
    applySecurityHeaders(res as any, {
      cors: { origins: ['https://example.com'] },
    });

    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
  });

  it('allows custom CORS methods and headers', () => {
    const res = createMockResponse();
    applySecurityHeaders(res as any, {
      cors: { methods: ['GET'], headers: ['X-Custom'] },
    });

    expect(res.headers['Access-Control-Allow-Methods']).toBe('GET');
    expect(res.headers['Access-Control-Allow-Headers']).toBe('X-Custom');
  });
});
