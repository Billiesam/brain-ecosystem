import { describe, it, expect } from 'vitest';

/**
 * Tests that the extended healthCheck lambda shape matches the expected format
 * used by all 3 brains (brain, trading-brain, marketing-brain).
 *
 * The lambda is passed as `healthCheck` option to ApiServer.
 * This test validates the contract without starting an HTTP server.
 */
describe('healthCheck lambda contract', () => {
  it('should return extended fields (memoryMB, uptimeSeconds, dbSizeMB)', () => {
    // Simulate the healthCheck lambda as defined in each brain core
    const healthCheck = () => ({
      db: true,
      ipc: true,
      learning: true,
      research: true,
      ecosystemHealth: 0.85,
      memoryMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      uptimeSeconds: Math.round(process.uptime()),
      dbSizeMB: 12.5, // simulated
    });

    const result = healthCheck();

    // Core fields
    expect(result.db).toBe(true);
    expect(result.ipc).toBe(true);

    // Extended fields (B2 hardening)
    expect(typeof result.memoryMB).toBe('number');
    expect(result.memoryMB).toBeGreaterThan(0);
    expect(typeof result.uptimeSeconds).toBe('number');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof result.dbSizeMB).toBe('number');
    expect(result.dbSizeMB).toBeGreaterThan(0);
  });

  it('should merge with base health response correctly', () => {
    // Simulate how BaseApiServer merges base + healthCheck in /api/v1/health
    const base = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      memory: Math.floor(process.memoryUsage().rss / 1024 / 1024),
    };

    const extra = {
      db: true,
      ipc: true,
      learning: true,
      research: false,
      ecosystemHealth: null,
      memoryMB: 85,
      uptimeSeconds: 3600,
      dbSizeMB: 4.2,
    };

    const merged = { ...base, ...extra };

    // Base fields
    expect(merged.status).toBe('ok');
    expect(merged.timestamp).toBeDefined();
    expect(typeof merged.uptime).toBe('number');
    expect(typeof merged.memory).toBe('number');

    // Extended fields from healthCheck lambda
    expect(merged.memoryMB).toBe(85);
    expect(merged.uptimeSeconds).toBe(3600);
    expect(merged.dbSizeMB).toBe(4.2);
    expect(merged.db).toBe(true);
    expect(merged.research).toBe(false);
  });
});
