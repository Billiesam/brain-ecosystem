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

/** Register transfer tools using IPC client (for stdio MCP transport) */
export function registerTransferTools(server: McpServer, ipc: IpcClient): void {
  registerTransferToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

/** Register transfer tools using router directly (for HTTP MCP transport inside daemon) */
export function registerTransferToolsDirect(server: McpServer, router: IpcRouter): void {
  registerTransferToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerTransferToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'brain_transfer_status',
    'Get cross-domain knowledge transfer status: analogies found, transfers proposed/applied/validated, cross-domain rules, and effectiveness scores.',
    {},
    async () => {
      const status: AnyResult = await call('transfer.status', {});
      const lines = [
        'Transfer Engine Status:',
        `  Total analogies found: ${status.totalAnalogies}`,
        `  Total transfers: ${status.totalTransfers} (pending: ${status.pendingTransfers}, applied: ${status.appliedTransfers}, validated: ${status.validatedTransfers}, rejected: ${status.rejectedTransfers})`,
        `  Avg effectiveness: ${(status.avgEffectiveness * 100).toFixed(0)}%`,
        `  Rules: ${status.activeRules}/${status.totalRules} active`,
        '',
      ];

      if (status.recentAnalogies?.length > 0) {
        lines.push('Recent Analogies:');
        for (const a of status.recentAnalogies.slice(0, 5)) {
          lines.push(`  [${(a.similarity * 100).toFixed(0)}%] ${a.narrative}`);
        }
        lines.push('');
      }

      if (status.recentTransfers?.length > 0) {
        lines.push('Recent Transfers:');
        for (const t of status.recentTransfers.slice(0, 5)) {
          const eff = t.effectiveness !== null ? ` (${(t.effectiveness * 100).toFixed(0)}% effective)` : '';
          lines.push(`  [${t.status}] ${t.source_brain} → ${t.target_brain}: "${t.statement.substring(0, 60)}"${eff}`);
        }
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_transfer_analogies',
    'Find and list cross-domain analogies — knowledge that is structurally similar across different Brain domains.',
    {
      limit: z.number().optional().describe('Max analogies to show (default: 20)'),
    },
    async (params) => {
      const analogies: AnyResult[] = await call('transfer.analogies', { limit: params.limit ?? 20 }) as AnyResult[];
      if (!analogies?.length) return textResult('No analogies discovered yet. Run transfer.analyze to scan for cross-domain similarities.');

      const lines = [`Cross-Domain Analogies (${analogies.length}):\n`];
      for (const a of analogies) {
        lines.push(`[${(a.similarity * 100).toFixed(0)}%] ${a.source_brain} ↔ ${a.target_brain}`);
        lines.push(`  "${a.source_statement.substring(0, 70)}"`);
        lines.push(`  ≈ "${a.target_statement.substring(0, 70)}"`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_transfer_rules',
    'List cross-domain rules — automated triggers that fire when events in one Brain affect another Brain.',
    {},
    async () => {
      const rules: AnyResult[] = await call('transfer.rules', {}) as AnyResult[];
      if (!rules?.length) return textResult('No cross-domain rules configured.');

      const lines = [`Cross-Domain Rules (${rules.length}):\n`];
      for (const r of rules) {
        const status = r.enabled ? 'ACTIVE' : 'DISABLED';
        lines.push(`[${status}] "${r.name}"`);
        lines.push(`  ${r.source_brain}:${r.source_event} → ${r.target_brain}:${r.action}`);
        lines.push(`  Condition: ${r.condition} | Fired: ${r.fire_count}x | Cooldown: ${r.cooldown_ms / 1000}s`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );
}
