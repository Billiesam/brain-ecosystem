import { getLogger } from '../utils/logger.js';
import type { CrossBrainClient } from './client.js';
import type { BorgConfig, SyncPacket, SyncItem, SyncHistoryEntry } from './borg-types.js';
import { DEFAULT_BORG_CONFIG } from './borg-types.js';

export interface BorgDataProvider {
  /** Return local items available for sharing. */
  getShareableItems(): SyncItem[];
  /** Import items received from a peer. Return count of accepted items. */
  importItems(items: SyncItem[], source: string): number;
}

/**
 * BorgSyncEngine — collective knowledge synchronization between brains.
 *
 * Opt-in. When enabled, periodically broadcasts local knowledge (rules, insights,
 * patterns, memories) to peer brains and imports their knowledge back.
 * Filtering by type, confidence, and relevance threshold.
 */
export class BorgSyncEngine {
  private logger = getLogger();
  private config: BorgConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private history: SyncHistoryEntry[] = [];
  private maxHistory = 200;

  constructor(
    private brainName: string,
    private crossBrain: CrossBrainClient,
    private dataProvider: BorgDataProvider,
    config?: Partial<BorgConfig>,
  ) {
    this.config = { ...DEFAULT_BORG_CONFIG, ...config };
  }

  /** Start the periodic sync loop (if enabled). */
  start(): void {
    if (!this.config.enabled) {
      this.logger.debug('Borg sync disabled — skipping');
      return;
    }

    this.logger.info(`Borg sync started (mode: ${this.config.mode}, interval: ${this.config.syncIntervalMs}ms)`);
    this.timer = setInterval(() => {
      this.syncCycle().catch(err => {
        this.logger.error(`Borg sync cycle error: ${(err as Error).message}`);
      });
    }, this.config.syncIntervalMs);

    // Initial sync after short delay
    setTimeout(() => {
      this.syncCycle().catch(() => {});
    }, 5000);
  }

  /** Stop the sync loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Borg sync stopped');
    }
  }

  /** Enable or disable Borg mode at runtime. */
  setEnabled(enabled: boolean): void {
    const wasEnabled = this.config.enabled;
    this.config.enabled = enabled;

    if (enabled && !wasEnabled) {
      this.start();
    } else if (!enabled && wasEnabled) {
      this.stop();
    }
  }

  /** Update config at runtime. */
  updateConfig(partial: Partial<BorgConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...partial };

    // Restart timer if interval changed and was running
    if (wasEnabled && this.config.enabled && this.timer) {
      this.stop();
      this.start();
    }
  }

  /** Get current config. */
  getConfig(): BorgConfig {
    return { ...this.config };
  }

  /** Get sync history. */
  getHistory(limit = 50): SyncHistoryEntry[] {
    return this.history.slice(-limit);
  }

  /** Get status summary. */
  getStatus(): {
    enabled: boolean;
    mode: string;
    syncIntervalMs: number;
    totalSyncs: number;
    totalSent: number;
    totalReceived: number;
    lastSync: string | null;
  } {
    const sent = this.history.filter(h => h.direction === 'sent');
    const received = this.history.filter(h => h.direction === 'received');
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      syncIntervalMs: this.config.syncIntervalMs,
      totalSyncs: this.history.length,
      totalSent: sent.reduce((s, h) => s + h.itemCount, 0),
      totalReceived: received.reduce((s, h) => s + h.accepted, 0),
      lastSync: this.history.length > 0 ? this.history[this.history.length - 1]!.timestamp : null,
    };
  }

  /** Run one sync cycle: broadcast own knowledge, then pull from peers. */
  async syncCycle(): Promise<void> {
    if (!this.config.enabled) return;

    // 1. Gather local items to share
    const allItems = this.dataProvider.getShareableItems();
    const filtered = this.filterOutgoing(allItems);

    if (filtered.length > 0) {
      const packet: SyncPacket = {
        source: this.brainName,
        timestamp: new Date().toISOString(),
        items: filtered,
      };

      // Broadcast to all peers
      try {
        const results = await this.crossBrain.broadcast('cross-brain.borgSync', packet);
        for (const r of results) {
          const res = r.result as { accepted?: number; rejected?: number } | null;
          this.addHistory({
            timestamp: new Date().toISOString(),
            direction: 'sent',
            peer: r.name,
            itemCount: filtered.length,
            accepted: res?.accepted ?? 0,
            rejected: res?.rejected ?? 0,
          });
        }
      } catch {
        this.logger.debug('Borg broadcast failed (peers may be offline)');
      }
    }

    // 2. Pull from peers
    try {
      const peerResults = await this.crossBrain.broadcast('cross-brain.borgExport', {
        requester: this.brainName,
      });

      for (const r of peerResults) {
        const packet = r.result as SyncPacket | null;
        if (!packet?.items?.length) continue;

        const incoming = this.filterIncoming(packet.items);
        const accepted = this.dataProvider.importItems(incoming, r.name);

        this.addHistory({
          timestamp: new Date().toISOString(),
          direction: 'received',
          peer: r.name,
          itemCount: packet.items.length,
          accepted,
          rejected: incoming.length - accepted,
        });
      }
    } catch {
      this.logger.debug('Borg pull failed (peers may be offline)');
    }
  }

  /** Handle incoming borgSync from a peer. */
  handleIncomingSync(packet: SyncPacket): { accepted: number; rejected: number } {
    if (!this.config.enabled) {
      return { accepted: 0, rejected: packet.items?.length ?? 0 };
    }

    const items = this.filterIncoming(packet.items ?? []);
    const accepted = this.dataProvider.importItems(items, packet.source);

    this.addHistory({
      timestamp: new Date().toISOString(),
      direction: 'received',
      peer: packet.source,
      itemCount: packet.items?.length ?? 0,
      accepted,
      rejected: (packet.items?.length ?? 0) - accepted,
    });

    return { accepted, rejected: (packet.items?.length ?? 0) - accepted };
  }

  /** Handle borgExport request — return our shareable items as a SyncPacket. */
  handleExportRequest(): SyncPacket {
    const items = this.config.enabled
      ? this.filterOutgoing(this.dataProvider.getShareableItems())
      : [];

    return {
      source: this.brainName,
      timestamp: new Date().toISOString(),
      items,
    };
  }

  /** Filter items before sending: apply mode, type, and confidence filters. */
  private filterOutgoing(items: SyncItem[]): SyncItem[] {
    return items.filter(item => {
      // Confidence gate
      if (item.confidence < this.config.minConfidence) return false;

      // Selective mode: only share configured types
      if (this.config.mode === 'selective') {
        return this.config.shareTypes.includes(item.type);
      }

      // Full mode: share everything
      return true;
    });
  }

  /** Filter items before importing: apply relevance threshold. */
  private filterIncoming(items: SyncItem[]): SyncItem[] {
    return items.filter(item => {
      // Don't import our own items back
      if (item.source === this.brainName) return false;

      // Confidence must meet our threshold
      if (item.confidence < this.config.relevanceThreshold) return false;

      // Selective mode: only accept configured types
      if (this.config.mode === 'selective') {
        return this.config.shareTypes.includes(item.type);
      }

      return true;
    });
  }

  private addHistory(entry: SyncHistoryEntry): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
  }
}
