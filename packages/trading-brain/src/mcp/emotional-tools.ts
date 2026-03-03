import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '@timmeck/brain-core';

type BrainCall = (method: string, params?: unknown) => Promise<unknown> | unknown;

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

export function registerEmotionalTools(server: McpServer, ipc: IpcClient): void {
  registerEmotionalToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

function registerEmotionalToolsWithCaller(server: McpServer, call: BrainCall): void {
  server.tool(
    'trading_emotional_status',
    'Get the trading brain\'s emotional state — mood, dimensions, and overall status for trading context.',
    {},
    async () => {
      const status = await call('emotional.status') as Record<string, unknown>;
      const mood = status.currentMood as Record<string, unknown>;
      const dims = mood.dimensions as Record<string, number>;
      const lines = [
        `## Trading Brain Emotional Status`,
        `**Mood:** ${mood.mood} (score: ${(mood.score as number * 100).toFixed(0)}%)`,
        `**Valence:** ${mood.valence as number > 0 ? '+' : ''}${(mood.valence as number).toFixed(2)} | **Arousal:** ${(mood.arousal as number).toFixed(2)}`,
        '',
        '### Dimensions',
        ...Object.entries(dims).map(([k, v]) => `- **${k}:** ${(v * 100).toFixed(0)}%`),
        '',
        `Cycles: ${status.cycleCount} | History: ${status.historyCount} entries`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_mood_history',
    'Get the trading brain\'s emotional history — track mood evolution across trading cycles.',
    { limit: z.number().optional().default(20).describe('Number of history entries') },
    async ({ limit }) => {
      const history = await call('emotional.history', { limit }) as Array<Record<string, unknown>>;
      if (history.length === 0) return textResult('No emotional history yet.');
      const lines = ['## Trading Mood History', ''];
      for (const entry of history) {
        lines.push(`**Cycle ${entry.cycle_number}** — ${entry.dominant_mood} (${(entry.mood_score as number * 100).toFixed(0)}%) | ${entry.timestamp}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_mood_influences',
    'See what caused recent mood changes in the trading brain — which signals shifted emotional dimensions.',
    { limit: z.number().optional().default(10).describe('Number of influences') },
    async ({ limit }) => {
      const influences = await call('emotional.influences', { limit }) as Array<Record<string, unknown>>;
      if (influences.length === 0) return textResult('No mood influences recorded yet.');
      const lines = ['## Trading Mood Influences', ''];
      for (const inf of influences) {
        const delta = inf.delta as number;
        const arrow = delta > 0 ? '↑' : '↓';
        lines.push(`${arrow} **${inf.dimension}** ${(inf.old_value as number * 100).toFixed(0)}% → ${(inf.new_value as number * 100).toFixed(0)}% (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%) — ${inf.source_engine}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_mood_advice',
    'Get trading-specific behavior recommendations based on current mood — e.g. reduce risk when anxious.',
    {},
    async () => {
      const mood = await call('emotional.mood') as Record<string, unknown>;
      const recs = await call('emotional.recommendations') as string[];
      const lines = [
        `## Trading Mood Advice (${mood.mood})`,
        '',
        ...recs.map((r, i) => `${i + 1}. ${r}`),
      ];
      return textResult(lines.join('\n'));
    },
  );
}
