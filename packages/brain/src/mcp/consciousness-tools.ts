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

/** Register consciousness tools using IPC client (for stdio MCP transport) */
export function registerConsciousnessTools(server: McpServer, ipc: IpcClient): void {
  registerConsciousnessToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

/** Register consciousness tools using router directly (for HTTP MCP transport inside daemon) */
export function registerConsciousnessToolsDirect(server: McpServer, router: IpcRouter): void {
  registerConsciousnessToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerConsciousnessToolsWithCaller(server: McpServer, call: BrainCall): void {

  // ═══════════════════════════════════════════════════════════════════
  // Consciousness — Watch Brain Think in Real-Time
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'brain_consciousness_status',
    'Get Brain consciousness status: total thoughts, active engines, thought breakdown by engine/type/significance, and live dashboard client count.',
    {},
    async () => {
      const status: AnyResult = await call('consciousness.status', {});
      const lines = [
        'Consciousness Status:',
        `  Total thoughts: ${status.totalThoughts}`,
        `  Active engines: ${(status.activeEngines || []).join(', ') || 'none'}`,
        `  Dashboard clients: ${status.clients ?? 0}`,
        `  Uptime: ${Math.floor((status.uptime || 0) / 1000)}s`,
        '',
        'Thoughts by Engine:',
        ...Object.entries(status.thoughtsPerEngine || {}).map(([k, v]) => `  ${k}: ${v}`),
        '',
        'Thoughts by Type:',
        ...Object.entries(status.thoughtsPerType || {}).map(([k, v]) => `  ${k}: ${v}`),
        '',
        'Engine Activity:',
        ...(status.engines || []).map((e: AnyResult) =>
          `  ${e.engine} [${e.status}] — ${e.metrics.totalThoughts} thoughts, ${e.metrics.discoveries} discoveries`
        ),
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_consciousness_thoughts',
    'Get recent thoughts from Brain consciousness stream. Optionally filter by engine name. Shows what Brain is thinking in real-time.',
    {
      engine: z.string().optional().describe('Filter by engine (e.g., "dream", "self_observer", "anomaly_detective")'),
      limit: z.number().optional().describe('Max results (default: 20)'),
    },
    async (params) => {
      const thoughts: AnyResult[] = await call('consciousness.thoughts', {
        engine: params.engine,
        limit: params.limit ?? 20,
      }) as AnyResult[];
      if (!thoughts?.length) return textResult('No thoughts yet. Brain is quiet.');
      const lines = [`Recent Thoughts (${thoughts.length}):\n`];
      for (const t of thoughts) {
        const time = new Date(t.timestamp).toLocaleTimeString();
        lines.push(`  [${time}] ${t.engine} (${t.type}) [${t.significance}]`);
        lines.push(`    ${t.content}`);
      }
      return textResult(lines.join('\n'));
    },
  );
}
