import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WatchdogService, createDefaultWatchdogConfig, type WatchdogConfig } from '../watchdog-service.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn().mockReturnValue({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
  }),
}));

// Mock IpcClient
vi.mock('../../ipc/client.js', () => ({
  IpcClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue({ status: 'ok' }),
    disconnect: vi.fn(),
  })),
}));

function createTestConfig(): WatchdogConfig {
  return {
    daemons: [
      {
        name: 'test-brain',
        entryPoint: '/fake/path/index.js',
        args: ['daemon'],
        pidPath: '/tmp/test-brain.pid',
        pipeName: '\\\\.\\pipe\\test-brain',
      },
      {
        name: 'test-trading',
        entryPoint: '/fake/path/trading/index.js',
        args: ['daemon'],
        pidPath: '/tmp/test-trading.pid',
        pipeName: '\\\\.\\pipe\\test-trading',
      },
    ],
    maxRestarts: 3,
    restartWindowMs: 60_000,
    baseBackoffMs: 100,
    healthCheckIntervalMs: 1000,
  };
}

describe('WatchdogService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates with configured daemons', () => {
    const config = createTestConfig();
    const watchdog = new WatchdogService(config);
    const status = watchdog.getStatus();

    expect(status).toHaveLength(2);
    expect(status[0].name).toBe('test-brain');
    expect(status[1].name).toBe('test-trading');
    expect(status[0].running).toBe(false);
    expect(status[0].restarts).toBe(0);
  });

  it('returns null for unknown daemon', () => {
    const watchdog = new WatchdogService(createTestConfig());
    expect(watchdog.getDaemonStatus('nonexistent')).toBeNull();
  });

  it('gets individual daemon status', () => {
    const watchdog = new WatchdogService(createTestConfig());
    const status = watchdog.getDaemonStatus('test-brain');
    expect(status).not.toBeNull();
    expect(status!.name).toBe('test-brain');
    expect(status!.pid).toBeNull();
    expect(status!.healthy).toBe(false);
  });

  it('restartDaemon returns false for unknown daemon', () => {
    const watchdog = new WatchdogService(createTestConfig());
    expect(watchdog.restartDaemon('nonexistent')).toBe(false);
  });

  it('stop is safe when not started', () => {
    const watchdog = new WatchdogService(createTestConfig());
    expect(() => watchdog.stop()).not.toThrow();
  });

  it('getStatus returns uptime as null when not started', () => {
    const watchdog = new WatchdogService(createTestConfig());
    const status = watchdog.getStatus();
    for (const s of status) {
      expect(s.uptime).toBeNull();
      expect(s.lastCrash).toBeNull();
    }
  });
});

describe('createDefaultWatchdogConfig', () => {
  it('creates config with 3 brain daemons', () => {
    const config = createDefaultWatchdogConfig();
    expect(config.daemons).toHaveLength(3);
    expect(config.daemons.map(d => d.name)).toEqual([
      'brain',
      'trading-brain',
      'marketing-brain',
    ]);
  });

  it('each daemon has required fields', () => {
    const config = createDefaultWatchdogConfig();
    for (const d of config.daemons) {
      expect(d.name).toBeTruthy();
      expect(d.entryPoint).toBeTruthy();
      expect(d.args).toContain('daemon');
      expect(d.pidPath).toBeTruthy();
      expect(d.pipeName).toBeTruthy();
    }
  });

  it('pipe names contain daemon name', () => {
    const config = createDefaultWatchdogConfig();
    expect(config.daemons[0].pipeName).toContain('brain');
    expect(config.daemons[1].pipeName).toContain('trading');
    expect(config.daemons[2].pipeName).toContain('marketing');
  });
});
