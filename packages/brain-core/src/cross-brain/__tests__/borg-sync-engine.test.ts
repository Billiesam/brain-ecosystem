import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BorgSyncEngine, type BorgDataProvider } from '../borg-sync-engine.js';
import type { SyncItem, SyncPacket } from '../borg-types.js';

// Mock CrossBrainClient
function createMockClient() {
  return {
    broadcast: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue(null),
    getAvailablePeers: vi.fn().mockResolvedValue([]),
    getPeerNames: vi.fn().mockReturnValue(['trading-brain', 'marketing-brain']),
    addPeer: vi.fn(),
    removePeer: vi.fn(),
  };
}

function createMockProvider(items: SyncItem[] = []): BorgDataProvider {
  return {
    getShareableItems: vi.fn().mockReturnValue(items),
    importItems: vi.fn().mockReturnValue(0),
  };
}

function makeItem(overrides: Partial<SyncItem> = {}): SyncItem {
  return {
    type: 'rule',
    id: 'r1',
    title: 'Test Rule',
    content: 'Always test your code',
    confidence: 0.8,
    source: 'brain',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('BorgSyncEngine', () => {
  let client: ReturnType<typeof createMockClient>;
  let provider: BorgDataProvider;

  beforeEach(() => {
    client = createMockClient();
    provider = createMockProvider();
    vi.useFakeTimers();
  });

  it('starts disabled by default', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider);
    const status = engine.getStatus();
    expect(status.enabled).toBe(false);
    expect(status.totalSyncs).toBe(0);
  });

  it('getConfig returns config copy', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider, { enabled: true });
    const config = engine.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.mode).toBe('selective');
    expect(config.minConfidence).toBe(0.6);
  });

  it('setEnabled toggles borg mode', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider);
    expect(engine.getConfig().enabled).toBe(false);

    engine.setEnabled(true);
    expect(engine.getConfig().enabled).toBe(true);

    engine.setEnabled(false);
    expect(engine.getConfig().enabled).toBe(false);
    engine.stop(); // cleanup
  });

  it('updateConfig merges partial config', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider);
    engine.updateConfig({ minConfidence: 0.9, mode: 'full' });
    const config = engine.getConfig();
    expect(config.minConfidence).toBe(0.9);
    expect(config.mode).toBe('full');
  });

  it('filterOutgoing respects minConfidence', async () => {
    const items = [
      makeItem({ id: 'r1', confidence: 0.8 }),
      makeItem({ id: 'r2', confidence: 0.3 }), // below threshold
    ];
    provider = createMockProvider(items);

    const engine = new BorgSyncEngine('brain', client as any, provider, { enabled: true });
    client.broadcast.mockResolvedValue([
      { name: 'trading-brain', result: { accepted: 1, rejected: 0 } },
    ]);

    await engine.syncCycle();

    // Should have broadcast only the high-confidence item
    expect(client.broadcast).toHaveBeenCalledWith(
      'cross-brain.borgSync',
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'r1' }),
        ]),
      }),
    );
    // The low-confidence item should not be included
    const broadcastCall = client.broadcast.mock.calls[0];
    const packet = broadcastCall[1] as SyncPacket;
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0].id).toBe('r1');

    engine.stop();
  });

  it('filterOutgoing in selective mode only shares configured types', async () => {
    const items = [
      makeItem({ id: 'r1', type: 'rule', confidence: 0.9 }),
      makeItem({ id: 'p1', type: 'pattern', confidence: 0.9 }), // not in default shareTypes
    ];
    provider = createMockProvider(items);

    const engine = new BorgSyncEngine('brain', client as any, provider, {
      enabled: true,
      shareTypes: ['rule', 'insight'], // pattern not included
    });

    client.broadcast.mockResolvedValue([]);
    await engine.syncCycle();

    const call = client.broadcast.mock.calls[0];
    const packet = call[1] as SyncPacket;
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0].type).toBe('rule');

    engine.stop();
  });

  it('filterOutgoing in full mode shares all types', async () => {
    const items = [
      makeItem({ id: 'r1', type: 'rule', confidence: 0.9 }),
      makeItem({ id: 'p1', type: 'pattern', confidence: 0.9 }),
      makeItem({ id: 'm1', type: 'memory', confidence: 0.9 }),
    ];
    provider = createMockProvider(items);

    const engine = new BorgSyncEngine('brain', client as any, provider, {
      enabled: true,
      mode: 'full',
    });

    client.broadcast.mockResolvedValue([]);
    await engine.syncCycle();

    const call = client.broadcast.mock.calls[0];
    const packet = call[1] as SyncPacket;
    expect(packet.items).toHaveLength(3);

    engine.stop();
  });

  it('handleIncomingSync filters by relevanceThreshold and rejects own items', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider, {
      enabled: true,
      relevanceThreshold: 0.5,
    });

    (provider.importItems as ReturnType<typeof vi.fn>).mockReturnValue(1);

    const result = engine.handleIncomingSync({
      source: 'trading-brain',
      timestamp: new Date().toISOString(),
      items: [
        makeItem({ id: 'r1', source: 'trading-brain', confidence: 0.8 }), // accept
        makeItem({ id: 'r2', source: 'brain', confidence: 0.9 }), // reject (own)
        makeItem({ id: 'r3', source: 'trading-brain', confidence: 0.2 }), // reject (low confidence)
      ],
    });

    // importItems should be called with only the first item
    expect(provider.importItems).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'r1' })],
      'trading-brain',
    );
    expect(result.accepted).toBe(1);

    engine.stop();
  });

  it('handleIncomingSync returns all rejected when disabled', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider);
    // Default: disabled

    const result = engine.handleIncomingSync({
      source: 'trading-brain',
      timestamp: new Date().toISOString(),
      items: [makeItem(), makeItem({ id: 'r2' })],
    });

    expect(result.accepted).toBe(0);
    expect(result.rejected).toBe(2);
    expect(provider.importItems).not.toHaveBeenCalled();
  });

  it('handleExportRequest returns shareable items when enabled', () => {
    const items = [makeItem({ id: 'r1', confidence: 0.9 })];
    provider = createMockProvider(items);

    const engine = new BorgSyncEngine('brain', client as any, provider, { enabled: true });
    const packet = engine.handleExportRequest();

    expect(packet.source).toBe('brain');
    expect(packet.items).toHaveLength(1);
    expect(packet.items[0].id).toBe('r1');
  });

  it('handleExportRequest returns empty when disabled', () => {
    const items = [makeItem({ id: 'r1', confidence: 0.9 })];
    provider = createMockProvider(items);

    const engine = new BorgSyncEngine('brain', client as any, provider);
    const packet = engine.handleExportRequest();

    expect(packet.items).toHaveLength(0);
  });

  it('tracks sync history', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider, { enabled: true });

    engine.handleIncomingSync({
      source: 'trading-brain',
      timestamp: new Date().toISOString(),
      items: [makeItem({ source: 'trading-brain' })],
    });

    const history = engine.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].direction).toBe('received');
    expect(history[0].peer).toBe('trading-brain');
  });

  it('getStatus returns summary', () => {
    const engine = new BorgSyncEngine('brain', client as any, provider, { enabled: true });

    engine.handleIncomingSync({
      source: 'trading-brain',
      timestamp: new Date().toISOString(),
      items: [makeItem({ source: 'trading-brain' })],
    });

    const status = engine.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.mode).toBe('selective');
    expect(status.totalSyncs).toBe(1);
    expect(status.lastSync).toBeTruthy();
  });

  it('syncCycle does nothing when disabled', async () => {
    const engine = new BorgSyncEngine('brain', client as any, provider);
    await engine.syncCycle();
    expect(client.broadcast).not.toHaveBeenCalled();
  });

  it('syncCycle pulls from peers and imports', async () => {
    const items = [makeItem({ id: 'local1', confidence: 0.9 })];
    provider = createMockProvider(items);
    (provider.importItems as ReturnType<typeof vi.fn>).mockReturnValue(2);

    const engine = new BorgSyncEngine('brain', client as any, provider, { enabled: true });

    // First broadcast call (borgSync) returns empty
    // Second broadcast call (borgExport) returns peer data
    client.broadcast
      .mockResolvedValueOnce([{ name: 'trading-brain', result: { accepted: 1, rejected: 0 } }])
      .mockResolvedValueOnce([{
        name: 'trading-brain',
        result: {
          source: 'trading-brain',
          timestamp: new Date().toISOString(),
          items: [
            makeItem({ id: 'peer1', source: 'trading-brain', confidence: 0.7 }),
            makeItem({ id: 'peer2', source: 'trading-brain', confidence: 0.8 }),
          ],
        },
      }]);

    await engine.syncCycle();

    // Should have called broadcast twice: borgSync and borgExport
    expect(client.broadcast).toHaveBeenCalledTimes(2);
    expect(client.broadcast).toHaveBeenCalledWith('cross-brain.borgSync', expect.any(Object));
    expect(client.broadcast).toHaveBeenCalledWith('cross-brain.borgExport', expect.any(Object));

    // Should have imported peer items
    expect(provider.importItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'peer1' }),
        expect.objectContaining({ id: 'peer2' }),
      ]),
      'trading-brain',
    );

    engine.stop();
  });
});
