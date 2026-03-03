import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IpcClient } from '@timmeck/brain-core';
import type { IpcRouter } from '../ipc/router.js';

type BrainCall = (method: string, params?: unknown) => Promise<unknown> | unknown;

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text' as const, text }] };
}

export function registerEmotionalTools(server: McpServer, ipc: IpcClient): void {
  registerEmotionalToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

export function registerEmotionalToolsDirect(server: McpServer, router: IpcRouter): void {
  registerEmotionalToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerEmotionalToolsWithCaller(server: McpServer, call: BrainCall): void {
  server.tool(
    'brain_emotional_status',
    'Get the current emotional state of the brain — mood, dimensions (frustration, curiosity, surprise, confidence, satisfaction, stress, momentum, creativity), and overall status.',
    {},
    async () => {
      const status = await call('emotional.status') as Record<string, unknown>;
      const mood = status.currentMood as Record<string, unknown>;
      const dims = mood.dimensions as Record<string, number>;
      const lines = [
        `## Brain Emotional Status`,
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
    'brain_mood_history',
    'Get the emotional history of the brain over time — shows how mood and dimensions changed across cycles.',
    { limit: z.number().optional().default(20).describe('Number of history entries to return') },
    async ({ limit }) => {
      const history = await call('emotional.history', { limit }) as Array<Record<string, unknown>>;
      if (history.length === 0) return textResult('No emotional history yet.');
      const lines = ['## Brain Mood History', ''];
      for (const entry of history) {
        lines.push(`**Cycle ${entry.cycle_number}** — ${entry.dominant_mood} (${(entry.mood_score as number * 100).toFixed(0)}%) | ${entry.timestamp}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_mood_influences',
    'See what caused recent mood changes — which engines triggered emotional dimension shifts.',
    { limit: z.number().optional().default(10).describe('Number of influences to return') },
    async ({ limit }) => {
      const influences = await call('emotional.influences', { limit }) as Array<Record<string, unknown>>;
      if (influences.length === 0) return textResult('No mood influences recorded yet.');
      const lines = ['## Brain Mood Influences', ''];
      for (const inf of influences) {
        const delta = inf.delta as number;
        const arrow = delta > 0 ? '↑' : '↓';
        lines.push(`${arrow} **${inf.dimension}** ${(inf.old_value as number * 100).toFixed(0)}% → ${(inf.new_value as number * 100).toFixed(0)}% (${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%) — ${inf.source_engine}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_mood_advice',
    'Get behavior recommendations based on the current emotional state — what should the brain do given its mood?',
    {},
    async () => {
      const mood = await call('emotional.mood') as Record<string, unknown>;
      const recs = await call('emotional.recommendations') as string[];
      const lines = [
        `## Mood Advice (${mood.mood})`,
        '',
        ...recs.map((r, i) => `${i + 1}. ${r}`),
      ];
      return textResult(lines.join('\n'));
    },
  );
}
