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

/** Register curiosity tools using IPC client (for stdio MCP transport) */
export function registerCuriosityTools(server: McpServer, ipc: IpcClient): void {
  registerCuriosityToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

/** Register curiosity tools using router directly (for HTTP MCP transport inside daemon) */
export function registerCuriosityToolsDirect(server: McpServer, router: IpcRouter): void {
  registerCuriosityToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerCuriosityToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'brain_curiosity_status',
    'Get Brain curiosity status: knowledge gaps, unanswered questions, exploration rate (explore vs exploit), top bandit arms, and surprise count.',
    {},
    async () => {
      const status: AnyResult = await call('curiosity.status', {});
      const lines = [
        '# Curiosity Status',
        '',
        `**Gaps:** ${status.activeGaps} active / ${status.totalGaps} total`,
        `**Questions:** ${status.unansweredQuestions} unanswered / ${status.totalQuestions} total`,
        `**Explorations:** ${status.totalExplorations} (${(status.explorationRate * 100).toFixed(0)}% explore, ${((1 - status.explorationRate) * 100).toFixed(0)}% exploit)`,
        '',
      ];

      if (status.topGaps?.length > 0) {
        lines.push('## Top Knowledge Gaps');
        for (const g of status.topGaps) {
          lines.push(`- **${g.topic}** — ${g.gapType} (gap: ${(g.gapScore * 100).toFixed(0)}%, attention: ${(g.attentionScore * 100).toFixed(0)}%, knowledge: ${(g.knowledgeScore * 100).toFixed(0)}%)`);
        }
        lines.push('');
      }

      if (status.topArms?.length > 0) {
        lines.push('## Top Bandit Arms (by reward)');
        for (const a of status.topArms) {
          lines.push(`- **${a.topic}** — avg reward: ${a.averageReward.toFixed(2)}, pulls: ${a.pulls}`);
        }
      }

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_knowledge_gaps',
    'List Brain knowledge gaps: topics where attention is high but knowledge is low. Each gap has a type (dark_zone, shallow, contradictory, stale, unexplored), score, and auto-generated questions.',
    {
      limit: z.number().optional().describe('Max gaps to return (default: 10)'),
    },
    async (params) => {
      const gaps: AnyResult[] = await call('curiosity.gaps', { limit: params.limit ?? 10 }) as AnyResult[];
      if (!gaps?.length) return textResult('No knowledge gaps detected. Brain has good coverage of its focus areas.');

      const lines = [`# Knowledge Gaps: ${gaps.length}\n`];
      for (const g of gaps) {
        lines.push(`## ${g.topic} [${g.gapType}]`);
        lines.push(`Gap: ${(g.gapScore * 100).toFixed(0)}% | Attention: ${(g.attentionScore * 100).toFixed(0)}% | Knowledge: ${(g.knowledgeScore * 100).toFixed(0)}% | Explorations: ${g.explorationCount}`);
        if (g.questions?.length > 0) {
          lines.push('Questions:');
          for (const q of g.questions) lines.push(`  - ${q}`);
        }
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_explore_next',
    'Ask Brain what to explore next. Uses UCB1 multi-armed bandit to balance exploration (new topics) vs exploitation (deepening known topics). Returns the recommended topic and suggested actions.',
    {},
    async () => {
      const decision: AnyResult = await call('curiosity.select', {});
      if (!decision) return textResult('No topics to explore. Brain needs more attention data or knowledge gaps.');

      const lines = [
        `# Next: ${decision.action.toUpperCase()} "${decision.topic}"`,
        '',
        `**Reason:** ${decision.reason}`,
        `**UCB Score:** ${decision.ucbScore === 999 ? '∞' : decision.ucbScore.toFixed(2)}`,
        '',
        '## Suggested Actions',
      ];
      for (const a of decision.suggestedActions) lines.push(`- ${a}`);

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_surprises',
    'Detect surprises: things that violated Brain expectations. Finds confirmed-but-unlikely hypotheses, rejected-but-likely hypotheses, and experiments with unexpectedly large effects.',
    {},
    async () => {
      const surprises: AnyResult[] = await call('curiosity.surprises', {}) as AnyResult[];
      if (!surprises?.length) return textResult('No surprises. Everything matches expectations.');

      const lines = [`# Surprises: ${surprises.length}\n`];
      for (const s of surprises) {
        lines.push(`## ${s.topic}`);
        lines.push(`**Expected:** ${s.expected}`);
        lines.push(`**Actual:** ${s.actual}`);
        lines.push(`**Deviation:** ${(s.deviation * 100).toFixed(0)}%`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );
}
