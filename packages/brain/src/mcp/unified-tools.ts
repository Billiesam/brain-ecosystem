import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '@timmeck/brain-core';
import type { IpcRouter } from '../ipc/router.js';

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

type BrainCall = (method: string, params?: unknown) => Promise<unknown> | unknown;

/** Register unified dashboard tools using IPC client (for stdio MCP transport) */
export function registerUnifiedTools(server: McpServer, ipc: IpcClient): void {
  registerUnifiedToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

/** Register unified dashboard tools using router directly (for HTTP MCP transport inside daemon) */
export function registerUnifiedToolsDirect(server: McpServer, router: IpcRouter): void {
  registerUnifiedToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerUnifiedToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'brain_unified_status',
    'Get Unified Dashboard status: connected clients and dashboard URL. The Unified Dashboard on port 7788 shows all brains, attention, transfer, and notifications in one place.',
    {},
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const status: any = await call('unified.clients', {});
      const lines = [
        'Unified Dashboard:',
        `  URL: http://localhost:${status.port}`,
        `  Connected clients: ${status.clients}`,
        '',
        'Sections: Overview, Notifications, Attention, Transfer, Engines',
        'Links: Brain :7784, Trading :7785, Marketing :7786, CodeGen :7787',
      ];
      return textResult(lines.join('\n'));
    },
  );
}
