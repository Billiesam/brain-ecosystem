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

export function registerCuriosityTools(server: McpServer, ipc: IpcClient): void {
  registerCuriosityToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

export function registerCuriosityToolsDirect(server: McpServer, router: IpcRouter): void {
  registerCuriosityToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerCuriosityToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'marketing_curiosity_status',
    'Get Marketing Brain curiosity status: knowledge gaps, unanswered questions, exploration rate, top bandit arms.',
    {},
    async () => {
      const status: AnyResult = await call('curiosity.status', {});
      const lines = [
        '# Marketing Curiosity Status',
        '',
        `**Gaps:** ${status.activeGaps} active / ${status.totalGaps} total`,
        `**Questions:** ${status.unansweredQuestions} unanswered / ${status.totalQuestions} total`,
        `**Explorations:** ${status.totalExplorations} (${(status.explorationRate * 100).toFixed(0)}% explore)`,
      ];
      if (status.topGaps?.length > 0) {
        lines.push('', '## Top Gaps');
        for (const g of status.topGaps) lines.push(`- **${g.topic}** [${g.gapType}] gap=${(g.gapScore * 100).toFixed(0)}%`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'marketing_knowledge_gaps',
    'List Marketing Brain knowledge gaps: topics with high attention but low knowledge.',
    { limit: z.number().optional().describe('Max gaps (default: 10)') },
    async (params) => {
      const gaps: AnyResult[] = await call('curiosity.gaps', { limit: params.limit ?? 10 }) as AnyResult[];
      if (!gaps?.length) return textResult('No knowledge gaps detected.');
      const lines = [`# Knowledge Gaps: ${gaps.length}\n`];
      for (const g of gaps) {
        lines.push(`## ${g.topic} [${g.gapType}]`);
        lines.push(`Gap: ${(g.gapScore * 100).toFixed(0)}% | Attention: ${(g.attentionScore * 100).toFixed(0)}% | Knowledge: ${(g.knowledgeScore * 100).toFixed(0)}%`);
        if (g.questions?.length > 0) for (const q of g.questions) lines.push(`  - ${q}`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'marketing_explore_next',
    'Ask Marketing Brain what to explore next using UCB1 multi-armed bandit.',
    {},
    async () => {
      const decision: AnyResult = await call('curiosity.select', {});
      if (!decision) return textResult('No topics to explore.');
      const lines = [
        `# Next: ${decision.action.toUpperCase()} "${decision.topic}"`,
        `**Reason:** ${decision.reason}`,
        '', '## Suggested Actions',
      ];
      for (const a of decision.suggestedActions) lines.push(`- ${a}`);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'marketing_surprises',
    'Detect surprises in Marketing Brain: things that violated expectations.',
    {},
    async () => {
      const surprises: AnyResult[] = await call('curiosity.surprises', {}) as AnyResult[];
      if (!surprises?.length) return textResult('No surprises.');
      const lines = [`# Surprises: ${surprises.length}\n`];
      for (const s of surprises) {
        lines.push(`## ${s.topic}`);
        lines.push(`Expected: ${s.expected} | Actual: ${s.actual} | Deviation: ${(s.deviation * 100).toFixed(0)}%`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );
}
