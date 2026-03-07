/**
 * Message Router — Bidirektionale Messaging-Bridge
 *
 * Empfängt Nachrichten von Telegram/Discord, erkennt die Intention,
 * dispatcht an die richtige IPC-Route und formatiert die Antwort.
 *
 * Unterstützte Befehle:
 *   /status        → brain status
 *   /query <text>  → error query
 *   /intel         → intelligence stats
 *   /mission <t>   → create research mission
 *   /traces        → trace stats
 *   /help          → command list
 *   Freitext       → LLM query (if available)
 */

import { getLogger } from '../utils/logger.js';

/** Simple interface for dispatching IPC calls. */
export interface IpcDispatcher {
  request(method: string, params?: unknown): Promise<unknown>;
}

// ── Types ───────────────────────────────────────────────

export interface IncomingMessage {
  text: string;
  senderId: string;
  senderName: string;
  platform: 'telegram' | 'discord';
  channelId?: string;
}

export interface OutgoingResponse {
  text: string;
  /** If true, send as code/pre block */
  code?: boolean;
}

export interface MessageRouterConfig {
  /** Allowed sender IDs (if empty, all senders allowed) */
  allowedSenders?: string[];
  /** Prefix for commands. Default: '/' */
  commandPrefix?: string;
  /** Brain name for IPC routing. Default: 'brain' */
  brainName?: string;
}

export interface MessageRouterStatus {
  messagesReceived: number;
  messagesRouted: number;
  errors: number;
  lastMessageAt: number | null;
  uptime: number;
}

type IntentHandler = (args: string, msg: IncomingMessage) => Promise<OutgoingResponse>;

// ── Router ──────────────────────────────────────────────

export class MessageRouter {
  private readonly log = getLogger();
  private readonly prefix: string;
  private readonly allowedSenders: Set<string>;
  private readonly brainName: string;
  private ipcClient: IpcDispatcher | null = null;
  private intents = new Map<string, IntentHandler>();
  private stats = {
    messagesReceived: 0,
    messagesRouted: 0,
    errors: 0,
    lastMessageAt: null as number | null,
    startedAt: Date.now(),
  };

  constructor(config: MessageRouterConfig = {}) {
    this.prefix = config.commandPrefix ?? '/';
    this.allowedSenders = new Set(config.allowedSenders ?? []);
    this.brainName = config.brainName ?? 'brain';
    this.registerDefaultIntents();
  }

  /** Connect to Brain IPC for dispatching commands. */
  setIpcClient(client: IpcDispatcher): void {
    this.ipcClient = client;
  }

  /** Process an incoming message. Returns response text. */
  async route(msg: IncomingMessage): Promise<OutgoingResponse> {
    this.stats.messagesReceived++;
    this.stats.lastMessageAt = Date.now();

    // Access control
    if (this.allowedSenders.size > 0 && !this.allowedSenders.has(msg.senderId)) {
      return { text: 'Zugriff verweigert. Deine ID ist nicht autorisiert.' };
    }

    const text = msg.text.trim();

    // Command parsing
    if (text.startsWith(this.prefix)) {
      const withoutPrefix = text.slice(this.prefix.length);
      const spaceIdx = withoutPrefix.indexOf(' ');
      const command = spaceIdx >= 0 ? withoutPrefix.slice(0, spaceIdx).toLowerCase() : withoutPrefix.toLowerCase();
      const args = spaceIdx >= 0 ? withoutPrefix.slice(spaceIdx + 1).trim() : '';

      const handler = this.intents.get(command);
      if (handler) {
        try {
          this.stats.messagesRouted++;
          return await handler(args, msg);
        } catch (err) {
          this.stats.errors++;
          this.log.warn(`[MessageRouter] Command '${command}' failed: ${(err as Error).message}`);
          return { text: `Fehler: ${(err as Error).message}` };
        }
      }

      return { text: `Unbekannter Befehl: ${this.prefix}${command}\nTippe ${this.prefix}help für alle Befehle.` };
    }

    // Free text → query if IPC available
    if (this.ipcClient) {
      try {
        this.stats.messagesRouted++;
        const result = await this.ipcClient.request('query', { query: text }) as { results?: Array<{ title?: string; message?: string }> };
        if (result?.results?.length) {
          const top = result.results.slice(0, 3);
          const lines = top.map((r, i) => `${i + 1}. ${r.title ?? r.message ?? 'Ergebnis'}`);
          return { text: `Ergebnisse:\n${lines.join('\n')}` };
        }
        return { text: 'Keine Ergebnisse gefunden.' };
      } catch {
        return { text: 'Freitext-Suche fehlgeschlagen. Nutze /help für Befehle.' };
      }
    }

    return { text: `Ich verstehe Befehle mit ${this.prefix} Prefix. Tippe ${this.prefix}help für alle Befehle.` };
  }

  /** Register a custom intent handler. */
  registerIntent(command: string, handler: IntentHandler): void {
    this.intents.set(command.toLowerCase(), handler);
  }

  /** Get router status. */
  getStatus(): MessageRouterStatus {
    return {
      messagesReceived: this.stats.messagesReceived,
      messagesRouted: this.stats.messagesRouted,
      errors: this.stats.errors,
      lastMessageAt: this.stats.lastMessageAt,
      uptime: Math.floor((Date.now() - this.stats.startedAt) / 1000),
    };
  }

  // ── Default Intents ─────────────────────────────────

  private registerDefaultIntents(): void {
    this.intents.set('help', async () => ({
      text: [
        `Brain Befehle:`,
        `${this.prefix}status — Brain Status & Statistiken`,
        `${this.prefix}query <text> — Fehler/Lösungen suchen`,
        `${this.prefix}intel — Intelligence Stats`,
        `${this.prefix}mission <topic> — Research-Mission starten`,
        `${this.prefix}traces — Trace-Statistiken`,
        `${this.prefix}engines — Engine-Übersicht`,
        `${this.prefix}health — System-Gesundheit`,
        `${this.prefix}help — Diese Hilfe`,
        ``,
        `Oder einfach Freitext eingeben für Suche.`,
      ].join('\n'),
    }));

    this.intents.set('status', async () => {
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const status = await this.ipcClient.request('status', {}) as Record<string, unknown>;
        return {
          text: [
            `Brain Status:`,
            `Name: ${status.name ?? this.brainName}`,
            `Version: ${status.version ?? '?'}`,
            `Uptime: ${status.uptime ?? '?'}s`,
            `PID: ${status.pid ?? '?'}`,
            `Methods: ${status.methods ?? '?'}`,
          ].join('\n'),
          code: true,
        };
      } catch (err) {
        return { text: `Status-Abfrage fehlgeschlagen: ${(err as Error).message}` };
      }
    });

    this.intents.set('query', async (args) => {
      if (!args) return { text: 'Bitte Suchtext angeben: /query <text>' };
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const result = await this.ipcClient.request('error.search', { query: args, limit: 5 }) as { results?: Array<{ title?: string; message?: string; score?: number }> };
        if (!result?.results?.length) return { text: 'Keine Ergebnisse.' };
        const lines = result.results.map((r, i) =>
          `${i + 1}. ${r.title ?? r.message ?? '?'} (Score: ${r.score?.toFixed(2) ?? '?'})`,
        );
        return { text: `Suchergebnisse:\n${lines.join('\n')}` };
      } catch (err) {
        return { text: `Suche fehlgeschlagen: ${(err as Error).message}` };
      }
    });

    this.intents.set('intel', async () => {
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const stats = await this.ipcClient.request('intelligence.stats', {}) as Record<string, unknown>;
        const lines: string[] = ['Intelligence Stats:'];
        for (const [key, val] of Object.entries(stats)) {
          if (val && typeof val === 'object' && 'totalFacts' in (val as Record<string, unknown>)) {
            lines.push(`${key}: ${(val as Record<string, unknown>).totalFacts} facts`);
          } else if (val && typeof val === 'object' && 'totalTraces' in (val as Record<string, unknown>)) {
            lines.push(`${key}: ${(val as Record<string, unknown>).totalTraces} traces`);
          }
        }
        return { text: lines.length > 1 ? lines.join('\n') : 'Keine Intelligence-Daten.' };
      } catch {
        return { text: 'Intelligence-Abfrage fehlgeschlagen.' };
      }
    });

    this.intents.set('mission', async (args) => {
      if (!args) return { text: 'Bitte Thema angeben: /mission <topic>' };
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const result = await this.ipcClient.request('mission.create', { topic: args, depth: 'standard' }) as { id?: string };
        return { text: `Mission erstellt: ${result?.id ?? 'OK'}\nThema: ${args}` };
      } catch (err) {
        return { text: `Mission fehlgeschlagen: ${(err as Error).message}` };
      }
    });

    this.intents.set('traces', async () => {
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const stats = await this.ipcClient.request('trace.stats', {}) as Record<string, unknown>;
        return {
          text: [
            `Trace-Statistiken:`,
            `Traces: ${stats.totalTraces ?? 0}`,
            `Spans: ${stats.totalSpans ?? 0}`,
            `Tokens: ${stats.totalTokens ?? 0}`,
            `Kosten: $${(Number(stats.totalCost) || 0).toFixed(2)}`,
            `Aktiv: ${stats.activeTraces ?? 0}`,
            `Ø Latenz: ${stats.avgDurationMs ?? 0}ms`,
          ].join('\n'),
          code: true,
        };
      } catch {
        return { text: 'Trace-Abfrage fehlgeschlagen.' };
      }
    });

    this.intents.set('engines', async () => {
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const result = await this.ipcClient.request('consciousness.engines', {}) as Array<{ name?: string; active?: boolean }>;
        if (!Array.isArray(result) || result.length === 0) return { text: 'Keine Engines gefunden.' };
        const activeCount = result.filter(e => e.active).length;
        return { text: `Engines: ${result.length} registriert, ${activeCount} aktiv` };
      } catch {
        return { text: 'Engine-Abfrage fehlgeschlagen.' };
      }
    });

    this.intents.set('health', async () => {
      if (!this.ipcClient) return { text: 'IPC nicht verbunden.' };
      try {
        const status = await this.ipcClient.request('status', {}) as Record<string, unknown>;
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        return {
          text: [
            `System Health:`,
            `Uptime: ${status.uptime ?? '?'}s`,
            `Memory: ${memMB} MB`,
            `PID: ${status.pid ?? process.pid}`,
            `IPC: verbunden`,
          ].join('\n'),
          code: true,
        };
      } catch {
        return { text: 'Health-Check fehlgeschlagen.' };
      }
    });
  }
}
