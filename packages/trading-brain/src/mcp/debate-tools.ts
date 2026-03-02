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

export function registerDebateTools(server: McpServer, ipc: IpcClient): void {
  registerDebateToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

export function registerDebateToolsDirect(server: McpServer, router: IpcRouter): void {
  registerDebateToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerDebateToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'trading_debate_start',
    'Start a multi-perspective debate on a question. Trading Brain generates its perspective from principles, hypotheses, journal, anomalies, and predictions.',
    { question: z.string().describe('The question to debate') },
    async (params) => {
      const debate: AnyResult = await call('debate.start', { question: params.question });
      const lines = [
        `# Debate #${debate.id}: ${debate.question}`,
        `Status: ${debate.status}`,
        '',
        '## Perspectives:',
      ];
      for (const p of debate.perspectives || []) {
        lines.push(`### ${p.brainName} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
        lines.push(p.position);
        if (p.arguments?.length > 0) {
          lines.push('**Arguments:**');
          for (const a of p.arguments.slice(0, 5)) {
            lines.push(`- [${a.source}] ${a.claim} (strength: ${(a.strength * 100).toFixed(0)}%)`);
          }
        }
        lines.push('');
      }
      lines.push(`*Add more perspectives from other brains, then call trading_debate_synthesize with debateId=${debate.id}*`);
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_debate_synthesize',
    'Synthesize a debate: compare all perspectives, detect conflicts, build weighted consensus, generate recommendations.',
    { debateId: z.number().describe('ID of the debate to synthesize') },
    async (params) => {
      const synthesis: AnyResult = await call('debate.synthesize', { debateId: params.debateId });
      if (!synthesis) return textResult('Debate not found or has no perspectives.');
      const lines = [
        '# Debate Synthesis',
        '',
        `**Participants:** ${synthesis.participantCount}`,
        `**Confidence:** ${(synthesis.confidence * 100).toFixed(0)}%`,
        '',
      ];
      if (synthesis.consensus) {
        lines.push('## Consensus');
        lines.push(synthesis.consensus);
        lines.push('');
      }
      if (synthesis.conflicts?.length > 0) {
        lines.push(`## Conflicts (${synthesis.conflicts.length})`);
        for (const c of synthesis.conflicts) {
          lines.push(`- **${c.perspectiveA}** vs **${c.perspectiveB}**: ${c.resolution}`);
          lines.push(`  A: ${c.claimA}`);
          lines.push(`  B: ${c.claimB}`);
          lines.push(`  → ${c.reason}`);
        }
        lines.push('');
      }
      lines.push('## Resolution');
      lines.push(synthesis.resolution);
      if (synthesis.recommendations?.length > 0) {
        lines.push('', '## Recommendations');
        for (const r of synthesis.recommendations) lines.push(`- ${r}`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_debate_perspective',
    'Generate Trading Brain\'s perspective on a question without starting a full debate. Useful for cross-brain debates.',
    { question: z.string().describe('The question to form a perspective on') },
    async (params) => {
      const p: AnyResult = await call('debate.perspective', { question: params.question });
      const lines = [
        `# ${p.brainName}'s Perspective`,
        `Confidence: ${(p.confidence * 100).toFixed(0)}% | Relevance: ${(p.relevance * 100).toFixed(0)}%`,
        '',
        `**Position:** ${p.position}`,
        '',
        '## Arguments:',
      ];
      for (const a of p.arguments || []) {
        lines.push(`- [${a.source}] ${a.claim} (strength: ${(a.strength * 100).toFixed(0)}%)`);
      }
      return textResult(lines.join('\n'));
    },
  );

  server.tool(
    'trading_debate_history',
    'View past Trading Brain debates with their questions, perspectives, synthesis, and conflicts.',
    { limit: z.number().optional().describe('Max debates to show (default: 10)') },
    async (params) => {
      const debates: AnyResult[] = await call('debate.list', { limit: params.limit ?? 10 }) as AnyResult[];
      if (!debates?.length) return textResult('No debates yet. Start one with trading_debate_start.');
      const lines = [`# Debate History: ${debates.length} debates\n`];
      for (const d of debates) {
        lines.push(`## #${d.id}: ${d.question}`);
        lines.push(`Status: ${d.status} | Perspectives: ${d.perspectives?.length ?? 0} | ${d.created_at}`);
        if (d.synthesis) {
          lines.push(`Confidence: ${(d.synthesis.confidence * 100).toFixed(0)}% | Conflicts: ${d.synthesis.conflicts?.length ?? 0}`);
          if (d.synthesis.consensus) lines.push(`Consensus: ${d.synthesis.consensus.substring(0, 150)}...`);
        }
        lines.push('');
      }
      return textResult(lines.join('\n'));
    },
  );
}
