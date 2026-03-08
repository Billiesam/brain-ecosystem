import dgram from 'node:dgram';
import { getPipeName } from '../utils/paths.js';

const MULTICAST_GROUP = '224.0.0.42';
const MULTICAST_PORT = 42420;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PEER_TIMEOUT_MS = 90_000;

export interface PeerInfo {
  name: string;
  pipeName: string;
  httpPort: number;
  packageVersion: string;
  knowledgeSummary: { principles: number; hypotheses: number; experiments: number };
  lastSeen: number;
  status: 'online' | 'offline';
  discoveredAt: number;
}

export interface PeerNetworkConfig {
  brainName: string;
  httpPort: number;
  packageVersion: string;
  getKnowledgeSummary?: () => { principles: number; hypotheses: number; experiments: number };
}

export interface PeerNetworkStatus {
  brainName: string;
  discoveryActive: boolean;
  onlinePeers: number;
  offlinePeers: number;
  totalDiscovered: number;
  peers: PeerInfo[];
}

interface AnnouncePacket {
  type: 'brain-announce';
  name: string;
  pipeName: string;
  httpPort: number;
  packageVersion: string;
  knowledgeSummary: { principles: number; hypotheses: number; experiments: number };
  timestamp: number;
}

export class PeerNetwork {
  readonly peers = new Map<string, PeerInfo>();
  private socket: dgram.Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryActive = false;

  private onDiscoveredCallbacks: Array<(peer: PeerInfo) => void> = [];
  private onLostCallbacks: Array<(peer: PeerInfo) => void> = [];

  constructor(private config: PeerNetworkConfig) {}

  onPeerDiscovered(cb: (peer: PeerInfo) => void): void {
    this.onDiscoveredCallbacks.push(cb);
  }

  onPeerLost(cb: (peer: PeerInfo) => void): void {
    this.onLostCallbacks.push(cb);
  }

  startDiscovery(): void {
    if (this.discoveryActive) return;
    this.discoveryActive = true;

    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        // Non-fatal — log and continue
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          // Another brain already bound — that's fine, we can still send
          return;
        }
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleMessage(msg, rinfo);
      });

      this.socket.bind(MULTICAST_PORT, () => {
        try {
          this.socket!.addMembership(MULTICAST_GROUP);
          this.socket!.setMulticastTTL(1);
          this.socket!.setBroadcast(true);
        } catch {
          // Multicast may not be available in all environments
        }
      });

      // Start heartbeat
      this.announce();
      this.heartbeatTimer = setInterval(() => this.announce(), HEARTBEAT_INTERVAL_MS);

      // Start cleanup check
      this.cleanupTimer = setInterval(() => this.checkTimeouts(), HEARTBEAT_INTERVAL_MS);
    } catch {
      this.discoveryActive = false;
    }
  }

  stopDiscovery(): void {
    if (!this.discoveryActive) return;
    this.discoveryActive = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.dropMembership(MULTICAST_GROUP);
      } catch { /* ignore */ }
      try {
        this.socket.close();
      } catch { /* ignore */ }
      this.socket = null;
    }

    // Clear callback references to prevent memory leaks
    this.onDiscoveredCallbacks = [];
    this.onLostCallbacks = [];
  }

  announce(): void {
    if (!this.socket) return;

    const summary = this.config.getKnowledgeSummary?.() ?? { principles: 0, hypotheses: 0, experiments: 0 };

    const packet: AnnouncePacket = {
      type: 'brain-announce',
      name: this.config.brainName,
      pipeName: getPipeName(this.config.brainName),
      httpPort: this.config.httpPort,
      packageVersion: this.config.packageVersion,
      knowledgeSummary: summary,
      timestamp: Date.now(),
    };

    const buf = Buffer.from(JSON.stringify(packet));
    try {
      this.socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_GROUP);
    } catch {
      // Send may fail if network is unavailable — non-fatal
    }
  }

  getAvailablePeers(): PeerInfo[] {
    return [...this.peers.values()].filter(p => p.status === 'online');
  }

  getStatus(): PeerNetworkStatus {
    const allPeers = [...this.peers.values()];
    return {
      brainName: this.config.brainName,
      discoveryActive: this.discoveryActive,
      onlinePeers: allPeers.filter(p => p.status === 'online').length,
      offlinePeers: allPeers.filter(p => p.status === 'offline').length,
      totalDiscovered: allPeers.length,
      peers: allPeers,
    };
  }

  private handleMessage(msg: Buffer, _rinfo: dgram.RemoteInfo): void {
    let packet: AnnouncePacket;
    try {
      packet = JSON.parse(msg.toString()) as AnnouncePacket;
    } catch {
      return; // Malformed packet — ignore
    }

    if (packet.type !== 'brain-announce') return;
    if (packet.name === this.config.brainName) return; // Ignore self

    const existing = this.peers.get(packet.name);
    const now = Date.now();

    if (existing) {
      // Update existing peer
      existing.lastSeen = now;
      existing.httpPort = packet.httpPort;
      existing.packageVersion = packet.packageVersion;
      existing.knowledgeSummary = packet.knowledgeSummary;
      if (existing.status === 'offline') {
        existing.status = 'online';
        for (const cb of this.onDiscoveredCallbacks) {
          try { cb(existing); } catch { /* callback error — ignore */ }
        }
      }
    } else {
      // New peer
      const peer: PeerInfo = {
        name: packet.name,
        pipeName: packet.pipeName,
        httpPort: packet.httpPort,
        packageVersion: packet.packageVersion,
        knowledgeSummary: packet.knowledgeSummary,
        lastSeen: now,
        status: 'online',
        discoveredAt: now,
      };
      this.peers.set(packet.name, peer);
      for (const cb of this.onDiscoveredCallbacks) {
        try { cb(peer); } catch { /* callback error — ignore */ }
      }
    }
  }

  private checkTimeouts(): void {
    const now = Date.now();
    for (const [, peer] of this.peers) {
      if (peer.status === 'online' && now - peer.lastSeen > PEER_TIMEOUT_MS) {
        peer.status = 'offline';
        for (const cb of this.onLostCallbacks) {
          try { cb(peer); } catch { /* callback error — ignore */ }
        }
      }
    }
  }
}
