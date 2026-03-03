import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '@timmeck/brain-core';
import type { IpcRouter } from '../ipc/router.js';

type BrainCall = (method: string, params?: unknown) => Promise<unknown> | unknown;

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

export function registerSelfmodTools(server: McpServer, ipc: IpcClient): void {
  registerSelfmodToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

export function registerSelfmodToolsDirect(server: McpServer, router: IpcRouter): void {
  registerSelfmodToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerSelfmodToolsWithCaller(server: McpServer, call: BrainCall): void {
  server.tool(
    'brain_selfmod_status',
    'Get the self-modification engine status — counts of proposed, testing, ready, applied, failed modifications.',
    {},
    async () => {
      const status = await call('selfmod.status') as Record<string, unknown>;
      const byStatus = status.byStatus as Record<string, number> || {};
      const lines = [
        '## Brain Self-Modification Status',
        `**Total:** ${status.totalModifications}`,
        '',
        `- Proposed: ${byStatus.proposed || 0}`,
        `- Testing: ${byStatus.testing || 0}`,
        `- Ready: ${byStatus.ready || 0}`,
        `- Applied: ${byStatus.applied || 0}`,
        `- Rejected: ${byStatus.rejected || 0}`,
        `- Failed: ${byStatus.failed || 0}`,
        `- Rolled back: ${byStatus.rolled_back || 0}`,
        '',
        `Last: ${status.lastModification || 'none'}`,
        `Root: ${status.projectRoot || 'not set'}`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_selfmod_pending',
    'List all pending self-modifications waiting for review — shows proposed and ready-for-approval code changes.',
    {},
    async () => {
      const pending = await call('selfmod.pending') as Array<Record<string, unknown>>;
      if (pending.length === 0) return textResult('No pending self-modifications.');
      const lines = ['## Pending Self-Modifications', ''];
      for (const mod of pending) {
        lines.push(`### #${mod.id}: ${mod.title} [${mod.status}]`);
        lines.push(`Problem: ${mod.problem_description}`);
        lines.push(`Files: ${(mod.target_files as string[]).join(', ')}`);
        lines.push(`Test: ${mod.test_result} | Tokens: ${mod.tokens_used} | Time: ${mod.generation_time_ms}ms`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_selfmod_approve',
    'Approve a self-modification and apply the code changes — only works for modifications with status "ready".',
    { id: z.number().describe('ID of the modification to approve') },
    async ({ id }) => {
      const result = await call('selfmod.approve', { id }) as Record<string, unknown>;
      return textResult(`Modification #${id} ${result.status === 'applied' ? 'approved and applied successfully!' : 'status: ' + result.status}`);
    },
  );

  server.tool(
    'brain_selfmod_history',
    'Get the history of all self-modifications — shows what changes the brain has proposed, tested, applied, and rejected.',
    { limit: z.number().optional().default(10).describe('Number of modifications to return') },
    async ({ limit }) => {
      const history = await call('selfmod.list', { limit }) as Array<Record<string, unknown>>;
      if (history.length === 0) return textResult('No self-modification history yet.');
      const lines = ['## Self-Modification History', ''];
      for (const mod of history) {
        const badge = mod.status === 'applied' ? '✓' : mod.status === 'failed' ? '✗' : mod.status === 'rejected' ? '✗' : '○';
        lines.push(`${badge} **#${mod.id}** ${mod.title} [${mod.status}] — ${mod.source_engine} | ${mod.tokens_used} tokens`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
