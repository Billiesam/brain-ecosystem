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

/** Register narrative tools using IPC client (for stdio MCP transport) */
export function registerNarrativeTools(server: McpServer, ipc: IpcClient): void {
  registerNarrativeToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

/** Register narrative tools using router directly (for HTTP MCP transport inside daemon) */
export function registerNarrativeToolsDirect(server: McpServer, router: IpcRouter): void {
  registerNarrativeToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerNarrativeToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'brain_explain',
    'Ask Brain to explain what it knows about a topic. Returns principles, hypotheses, experiments, journal entries, and predictions — composed into a natural language narrative with confidence scores.',
    {
      topic: z.string().describe('The topic to explain (e.g. "error patterns", "trading signals", "deployment failures")'),
    },
    async (params) => {
      const result: AnyResult = await call('narrative.explain', { topic: params.topic });

      const lines = [
        `# Explanation: ${result.topic}`,
        '',
        result.summary,
        '',
      ];

      if (result.details?.length > 0) {
        lines.push('## Details');
        for (const d of result.details) {
          lines.push(`- ${d}`);
        }
        lines.push('');
      }

      lines.push(`**Confidence:** ${(result.confidence * 100).toFixed(0)}% | **Sources:** ${result.sources?.length ?? 0}`);

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_ask',
    'Ask Brain a natural language question. Brain searches across its knowledge base (principles, hypotheses, journal, experiments) and composes an answer. Supports German and English.',
    {
      question: z.string().describe('The question to ask (e.g. "why do errors spike at night?", "warum scheitern Trades bei hoher Volatilität?")'),
    },
    async (params) => {
      const result: AnyResult = await call('narrative.ask', { question: params.question });

      const lines = [
        `# Q: ${result.question}`,
        '',
        result.answer,
        '',
      ];

      if (result.relatedTopics?.length > 0) {
        lines.push(`**Related topics:** ${result.relatedTopics.join(', ')}`);
      }
      lines.push(`**Confidence:** ${(result.confidence * 100).toFixed(0)}% | **Sources:** ${result.sources?.length ?? 0}`);

      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'brain_weekly_digest',
    'Generate a weekly digest — a comprehensive Markdown report of what Brain learned, discovered, predicted, and experimented with in the past N days.',
    {
      days: z.number().optional().describe('Number of days to cover (default: 7)'),
    },
    async (params) => {
      const result: AnyResult = await call('narrative.digest', { days: params.days ?? 7 });
      return textResult(result.markdown);
    },
  );

  server.tool(
    'brain_contradictions',
    'Find contradictions in Brain\'s knowledge — hypotheses vs anti-patterns, conflicting principles, failed predictions. Shows trade-offs and severity.',
    {},
    async () => {
      const contradictions: AnyResult[] = await call('narrative.contradictions', {}) as AnyResult[];
      if (!contradictions?.length) return textResult('No contradictions found. Brain\'s knowledge is internally consistent.');

      const lines = [`# Contradictions Found: ${contradictions.length}\n`];
      for (const c of contradictions) {
        lines.push(`## [${c.severity.toUpperCase()}] ${c.type.replace(/_/g, ' ')}`);
        lines.push(`**A:** ${c.statement_a}`);
        lines.push(`  _(${c.source_a})_`);
        lines.push(`**B:** ${c.statement_b}`);
        lines.push(`  _(${c.source_b})_`);
        lines.push(`**Trade-off:** ${c.tradeoff}`);
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );
}
