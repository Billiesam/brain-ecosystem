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
    'marketing_emotional_status',
    'Get the marketing brain\'s emotional state — mood and dimensions for content strategy context.',
    {},
    async () => {
      const status = await call('emotional.status') as Record<string, unknown>;
      const mood = status.currentMood as Record<string, unknown>;
      const dims = mood.dimensions as Record<string, number>;
      const lines = [
        `## Marketing Brain Emotional Status`,
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
    'marketing_mood_history',
    'Get the marketing brain\'s emotional history — track mood evolution across content cycles.',
    { limit: z.number().optional().default(20).describe('Number of history entries') },
    async ({ limit }) => {
      const history = await call('emotional.history', { limit }) as Array<Record<string, unknown>>;
      if (history.length === 0) return textResult('No emotional history yet.');
      const lines = ['## Marketing Mood History', ''];
      for (const entry of history) {
        lines.push(`**Cycle ${entry.cycle_number}** — ${entry.dominant_mood} (${(entry.mood_score as number * 100).toFixed(0)}%) | ${entry.timestamp}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'marketing_mood_influences',
    'See what caused recent mood changes in the marketing brain — which content signals shifted dimensions.',
    { limit: z.number().optional().default(10).describe('Number of influences') },
    async ({ limit }) => {
      const influences = await call('emotional.influences', { limit }) as Array<Record<string, unknown>>;
      if (influences.length === 0) return textResult('No mood influences recorded yet.');
      const lines = ['## Marketing Mood Influences', ''];
      for (const inf of influences) {
        const delta = inf.delta as number;
        const arrow = delta > 0 ? '↑' : '↓';
        lines.push(`${arrow} **${inf.dimension}** ${(inf.old_value as number * 100).toFixed(0)}% → ${(inf.new_value as number * 100).toFixed(0)}% (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%) — ${inf.source_engine}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'marketing_mood_advice',
    'Get marketing-specific behavior recommendations based on current mood — e.g. explore new content when bored.',
    {},
    async () => {
      const mood = await call('emotional.mood') as Record<string, unknown>;
      const recs = await call('emotional.recommendations') as string[];
      const lines = [
        `## Marketing Mood Advice (${mood.mood})`,
        '',
        ...recs.map((r, i) => `${i + 1}. ${r}`),
      ];
      return textResult(lines.join('\n'));
    },
  );
}
