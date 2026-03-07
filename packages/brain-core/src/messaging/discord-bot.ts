/**
 * Discord Bot — Bidirektionaler Message-Handler
 *
 * Empfängt Nachrichten via discord.js Gateway, routet sie durch
 * den MessageRouter und sendet die Antwort zurück.
 *
 * Voraussetzungen:
 *   npm install discord.js (optional dependency)
 *   DISCORD_BOT_TOKEN in .env
 *   DISCORD_CHANNEL_ID in .env (optional: beschränkt auf einen Channel)
 */

import { getLogger } from '../utils/logger.js';
import type { MessageRouter } from './message-router.js';

export interface DiscordBotConfig {
  botToken?: string;
  /** If set, only respond in this channel. */
  channelId?: string;
  /** Allowed user IDs (if empty, all allowed). */
  allowedUsers?: string[];
  /** Only respond when mentioned or prefixed. Default: false */
  mentionOnly?: boolean;
}

export interface DiscordBotStatus {
  running: boolean;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
  startedAt: number | null;
  guilds: number;
}

export class DiscordBot {
  private readonly log = getLogger();
  private readonly botToken: string | null;
  private readonly channelId: string | null;
  private readonly allowedUsers: Set<string>;
  private readonly mentionOnly: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private router: MessageRouter | null = null;
  private running = false;
  private stats = {
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
    startedAt: null as number | null,
    guilds: 0,
  };

  constructor(config: DiscordBotConfig = {}) {
    this.botToken = config.botToken ?? process.env.DISCORD_BOT_TOKEN ?? null;
    this.channelId = config.channelId ?? process.env.DISCORD_CHANNEL_ID ?? null;
    this.allowedUsers = new Set(config.allowedUsers ?? []);
    this.mentionOnly = config.mentionOnly ?? false;
  }

  /** Set the message router for dispatching incoming messages. */
  setRouter(router: MessageRouter): void {
    this.router = router;
  }

  /** Check if Discord bot can start. */
  isConfigured(): boolean {
    return !!this.botToken;
  }

  /** Start listening for messages. */
  async start(): Promise<void> {
    if (!this.botToken) {
      this.log.debug('[DiscordBot] No DISCORD_BOT_TOKEN set, skipping');
      return;
    }
    if (this.running) return;

    try {
      const modulePath = 'discord.js';
      const { Client, GatewayIntentBits } = await import(/* webpackIgnore: true */ modulePath);

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.on('ready', (c: any) => {
        this.stats.guilds = c.guilds?.cache?.size ?? 0;
        this.log.info(`[DiscordBot] Bot ready in ${this.stats.guilds} guilds`);
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.on('messageCreate', async (msg: any) => {
        try {
          // Ignore own messages
          if (msg.author?.bot) return;

          // Channel filter
          if (this.channelId && msg.channel?.id !== this.channelId) return;

          // Mention filter
          if (this.mentionOnly && !msg.mentions?.has(this.client.user)) {
            // Still allow /commands
            if (!msg.content?.startsWith('/')) return;
          }

          const senderId = String(msg.author?.id ?? '');
          const senderName = msg.author?.username ?? 'unknown';

          // User filter
          if (this.allowedUsers.size > 0 && !this.allowedUsers.has(senderId)) return;

          this.stats.messagesReceived++;

          if (!this.router) {
            await msg.reply('MessageRouter nicht konfiguriert.');
            return;
          }

          // Strip bot mention from beginning of text
          let text = msg.content ?? '';
          if (this.client.user) {
            text = text.replace(new RegExp(`^<@!?${this.client.user.id}>\\s*`), '');
          }

          const response = await this.router.route({
            text,
            senderId,
            senderName,
            platform: 'discord',
            channelId: msg.channel?.id,
          });

          if (response.code) {
            await msg.reply(`\`\`\`\n${response.text}\n\`\`\``);
          } else {
            await msg.reply(response.text);
          }
          this.stats.messagesSent++;
        } catch (err) {
          this.stats.errors++;
          this.log.warn(`[DiscordBot] Error handling message: ${(err as Error).message}`);
          try { await msg.reply('Interner Fehler.'); } catch { /* best effort */ }
        }
      });

      await this.client.login(this.botToken);
      this.running = true;
      this.stats.startedAt = Date.now();
    } catch (err) {
      this.log.warn(`[DiscordBot] Failed to start: ${(err as Error).message}`);
    }
  }

  /** Stop the bot. */
  async stop(): Promise<void> {
    if (this.client && this.running) {
      try {
        await this.client.destroy();
      } catch { /* best effort */ }
      this.running = false;
      this.client = null;
    }
  }

  /** Get bot status. */
  getStatus(): DiscordBotStatus {
    return {
      running: this.running,
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      errors: this.stats.errors,
      startedAt: this.stats.startedAt,
      guilds: this.stats.guilds,
    };
  }
}
