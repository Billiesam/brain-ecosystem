/**
 * Telegram Bot — Bidirektionaler Message-Handler
 *
 * Empfängt Nachrichten via grammy Long Polling, routet sie durch
 * den MessageRouter und sendet die Antwort zurück.
 *
 * Voraussetzungen:
 *   npm install grammy (optional dependency)
 *   TELEGRAM_BOT_TOKEN in .env
 *   TELEGRAM_CHAT_ID in .env (optional: beschränkt auf einen Chat)
 */

import { getLogger } from '../utils/logger.js';
import type { MessageRouter } from './message-router.js';

export interface TelegramBotConfig {
  botToken?: string;
  /** If set, only respond in this chat. */
  chatId?: string;
  /** Allowed user IDs (if empty, all allowed). */
  allowedUsers?: string[];
}

export interface TelegramBotStatus {
  running: boolean;
  messagesReceived: number;
  messagesSent: number;
  errors: number;
  startedAt: number | null;
}

export class TelegramBot {
  private readonly log = getLogger();
  private readonly botToken: string | null;
  private readonly chatId: string | null;
  private readonly allowedUsers: Set<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  private router: MessageRouter | null = null;
  private running = false;
  private stats = {
    messagesReceived: 0,
    messagesSent: 0,
    errors: 0,
    startedAt: null as number | null,
  };

  constructor(config: TelegramBotConfig = {}) {
    this.botToken = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
    this.chatId = config.chatId ?? process.env.TELEGRAM_CHAT_ID ?? null;
    this.allowedUsers = new Set(config.allowedUsers ?? []);
  }

  /** Set the message router for dispatching incoming messages. */
  setRouter(router: MessageRouter): void {
    this.router = router;
  }

  /** Check if Telegram bot can start. */
  isConfigured(): boolean {
    return !!this.botToken;
  }

  /** Start listening for messages. */
  async start(): Promise<void> {
    if (!this.botToken) {
      this.log.debug('[TelegramBot] No TELEGRAM_BOT_TOKEN set, skipping');
      return;
    }
    if (this.running) return;

    try {
      const modulePath = 'grammy';
      const { Bot } = await import(/* webpackIgnore: true */ modulePath);
      this.bot = new Bot(this.botToken);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.bot.on('message:text', async (ctx: any) => {
        try {
          const senderId = String(ctx.from?.id ?? '');
          const senderName = ctx.from?.first_name ?? ctx.from?.username ?? 'unknown';
          const chatId = String(ctx.chat?.id ?? '');

          // Chat filter
          if (this.chatId && chatId !== this.chatId) return;

          // User filter
          if (this.allowedUsers.size > 0 && !this.allowedUsers.has(senderId)) {
            await ctx.reply('Zugriff verweigert.');
            return;
          }

          this.stats.messagesReceived++;

          if (!this.router) {
            await ctx.reply('MessageRouter nicht konfiguriert.');
            return;
          }

          const response = await this.router.route({
            text: ctx.message.text,
            senderId,
            senderName,
            platform: 'telegram',
            channelId: chatId,
          });

          if (response.code) {
            await ctx.reply(`<pre>${this.escapeHtml(response.text)}</pre>`, { parse_mode: 'HTML' });
          } else {
            await ctx.reply(response.text);
          }
          this.stats.messagesSent++;
        } catch (err) {
          this.stats.errors++;
          this.log.warn(`[TelegramBot] Error handling message: ${(err as Error).message}`);
          try { await ctx.reply('Interner Fehler.'); } catch { /* best effort */ }
        }
      });

      // Start polling (non-blocking)
      this.bot.start({
        onStart: () => {
          this.log.info('[TelegramBot] Bot started, listening for messages');
        },
      });
      this.running = true;
      this.stats.startedAt = Date.now();
    } catch (err) {
      this.log.warn(`[TelegramBot] Failed to start: ${(err as Error).message}`);
    }
  }

  /** Stop the bot. */
  async stop(): Promise<void> {
    if (this.bot && this.running) {
      try {
        await this.bot.stop();
      } catch { /* best effort */ }
      this.running = false;
    }
  }

  /** Get bot status. */
  getStatus(): TelegramBotStatus {
    return {
      running: this.running,
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      errors: this.stats.errors,
      startedAt: this.stats.startedAt,
    };
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
