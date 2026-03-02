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

export function registerTransferTools(server: McpServer, ipc: IpcClient): void {
  registerTransferToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

export function registerTransferToolsDirect(server: McpServer, router: IpcRouter): void {
  registerTransferToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerTransferToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'trading_transfer_status',
    'Get cross-domain knowledge transfer status for Trading Brain: analogies, transfers, rules, effectiveness.',
    {},
    async () => {
      const status: AnyResult = await call('transfer.status', {});
      const lines = [
        'Transfer Engine Status (Trading):',
        `  Analogies: ${status.totalAnalogies} | Transfers: ${status.totalTransfers} (pending: ${status.pendingTransfers})`,
        `  Avg effectiveness: ${(status.avgEffectiveness * 100).toFixed(0)}% | Rules: ${status.activeRules}/${status.totalRules} active`,
      ];
      if (status.recentAnalogies?.length > 0) {
        lines.push('', 'Recent Analogies:');
        for (const a of status.recentAnalogies.slice(0, 5)) {
          lines.push(`  [${(a.similarity * 100).toFixed(0)}%] ${a.narrative}`);
        }
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_transfer_analogies',
    'Find cross-domain analogies relevant to trading — patterns similar across Brain domains.',
    { limit: z.number().optional().describe('Max analogies (default: 20)') },
    async (params) => {
      const analogies: AnyResult[] = await call('transfer.analogies', { limit: params.limit ?? 20 }) as AnyResult[];
      if (!analogies?.length) return textResult('No analogies discovered yet.');
      const lines = analogies.map((a: AnyResult) => `[${(a.similarity * 100).toFixed(0)}%] ${a.source_brain} ↔ ${a.target_brain}: ${a.narrative}`);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_transfer_rules',
    'List cross-domain rules affecting Trading Brain.',
    {},
    async () => {
      const rules: AnyResult[] = await call('transfer.rules', {}) as AnyResult[];
      if (!rules?.length) return textResult('No cross-domain rules configured.');
      const lines = rules.map((r: AnyResult) => `[${r.enabled ? 'ON' : 'OFF'}] "${r.name}" ${r.source_brain}:${r.source_event} → ${r.target_brain}:${r.action} (fired ${r.fire_count}x)`);
      return textResult(lines.join('\n'));
    },
  );
}
