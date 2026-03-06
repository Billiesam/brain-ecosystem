import { describe, it, expect, vi, beforeEach } from 'vitest';
import { borgCommand } from '../borg.js';

// Mock ipc-helper
vi.mock('../../ipc-helper.js', () => ({
  withIpc: vi.fn(async (fn) => {
    const mockClient = {
      request: vi.fn().mockImplementation((method: string) => {
        if (method === 'borg.status') {
          return {
            enabled: true,
            mode: 'selective',
            syncIntervalMs: 60000,
            totalSyncs: 5,
            totalSent: 12,
            totalReceived: 8,
            lastSync: '2026-03-06T12:00:00Z',
          };
        }
        if (method === 'borg.enable') return { enabled: true };
        if (method === 'borg.disable') return { enabled: false };
        if (method === 'borg.sync') return { synced: true };
        if (method === 'borg.history') {
          return [
            { timestamp: '2026-03-06T12:00:00Z', direction: 'sent', peer: 'trading-brain', itemCount: 5, accepted: 3, rejected: 2 },
            { timestamp: '2026-03-06T12:01:00Z', direction: 'received', peer: 'marketing-brain', itemCount: 4, accepted: 4, rejected: 0 },
          ];
        }
        return null;
      }),
    };
    return fn(mockClient);
  }),
}));

describe('borgCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('creates a valid commander command', () => {
    const cmd = borgCommand();
    expect(cmd.name()).toBe('borg');
    expect(cmd.commands.length).toBeGreaterThanOrEqual(5);
  });

  it('has status, enable, disable, sync, history subcommands', () => {
    const cmd = borgCommand();
    expect(cmd.commands.find(c => c.name() === 'status')).toBeDefined();
    expect(cmd.commands.find(c => c.name() === 'enable')).toBeDefined();
    expect(cmd.commands.find(c => c.name() === 'disable')).toBeDefined();
    expect(cmd.commands.find(c => c.name() === 'sync')).toBeDefined();
    expect(cmd.commands.find(c => c.name() === 'history')).toBeDefined();
  });

  it('status command shows borg information', async () => {
    const cmd = borgCommand();
    const statusCmd = cmd.commands.find(c => c.name() === 'status')!;
    await statusCmd.parseAsync([], { from: 'user' });

    const { withIpc } = await import('../../ipc-helper.js');
    expect(withIpc).toHaveBeenCalledTimes(1);
  });

  it('enable command enables borg mode', async () => {
    const cmd = borgCommand();
    const enableCmd = cmd.commands.find(c => c.name() === 'enable')!;
    await enableCmd.parseAsync([], { from: 'user' });

    const { withIpc } = await import('../../ipc-helper.js');
    expect(withIpc).toHaveBeenCalledTimes(1);
  });

  it('sync command triggers manual sync', async () => {
    const cmd = borgCommand();
    const syncCmd = cmd.commands.find(c => c.name() === 'sync')!;
    await syncCmd.parseAsync([], { from: 'user' });

    const { withIpc } = await import('../../ipc-helper.js');
    expect(withIpc).toHaveBeenCalledTimes(1);
  });

  it('history command shows sync history', async () => {
    const cmd = borgCommand();
    const historyCmd = cmd.commands.find(c => c.name() === 'history')!;
    await historyCmd.parseAsync([], { from: 'user' });

    const { withIpc } = await import('../../ipc-helper.js');
    expect(withIpc).toHaveBeenCalledTimes(1);
  });
});
