import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '@timmeck/brain-core';
import type { IpcRouter } from '../ipc/router.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyResult = any;
type BrainCall = (method: string, params?: unknown) => Promise<unknown> | unknown;

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

/** Register reposignal tools using IPC client (for stdio MCP transport) */
export function registerReposignalTools(server: McpServer, ipc: IpcClient): void {
  registerReposignalToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

/** Register reposignal tools using router directly (for HTTP MCP transport inside daemon) */
export function registerReposignalToolsDirect(server: McpServer, router: IpcRouter): void {
  registerReposignalToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerReposignalToolsWithCaller(server: McpServer, call: BrainCall): void {

  // ═══════════════════════════════════════════════════════════════════
  // Reposignal Import — Learn from the entire Open Source ecosystem
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'brain_import_reposignal',
    'Import tech intelligence from a Reposignal/aisurvival SQLite database. Imports trending repos, HN mentions, and tech trends as research discoveries and journal entries. Brain learns about the entire open source ecosystem.',
    {
      db_path: z.string().describe('Path to the reposignal/aisurvival SQLite database file'),
      min_signal_level: z.enum(['noise', 'watch', 'signal', 'breakout']).optional().describe('Minimum signal level to import (default: watch)'),
      batch_size: z.number().optional().describe('Max repos to import per run (default: 5000)'),
      include_hn: z.boolean().optional().describe('Import HackerNews mentions too (default: true)'),
    },
    async (params) => {
      const result: AnyResult = await call('import.reposignal', {
        dbPath: params.db_path,
        options: {
          minSignalLevel: params.min_signal_level,
          batchSize: params.batch_size,
          includeHnMentions: params.include_hn,
        },
      });

      const lines = [
        `Reposignal Import Complete`,
        `  DB: ${result.dbPath}`,
        `  Total repos in DB: ${result.totalReposInDb}`,
        `  Repos imported: ${result.reposImported}`,
        `  Discoveries created: ${result.discoveriesCreated}`,
        `  Journal entries: ${result.journalEntriesCreated}`,
        `  HN mentions: ${result.hnMentionsImported}`,
        `  Metrics recorded: ${result.metricsRecorded}`,
        `  Duplicates skipped: ${result.skippedDuplicates}`,
        `  Duration: ${result.duration_ms}ms`,
        '',
        'Signal Breakdown:',
      ];

      for (const [level, count] of Object.entries(result.signalBreakdown || {})) {
        lines.push(`  ${level}: ${count}`);
      }

      lines.push('', 'Top Languages:');
      const langs = Object.entries(result.languageBreakdown || {})
        .sort(([, a], [, b]) => (b as number) - (a as number))
        .slice(0, 10);
      for (const [lang, count] of langs) {
        lines.push(`  ${lang}: ${count}`);
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_reposignal_stats',
    'Get statistics about imported reposignal data — how many repos imported, signal level breakdown, last import time.',
    {},
    async () => {
      const result: AnyResult = await call('import.reposignal.stats', {});
      if (!result || result.totalImported === 0) return textResult('No reposignal data imported yet. Use brain_import_reposignal to import.');
      return textResult(result);
    },
  );
}
