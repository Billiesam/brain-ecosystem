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

export function registerSelfawareTools(server: McpServer, ipc: IpcClient): void {
  registerSelfawareToolsWithCaller(server, (method, params) => ipc.request(method, params));
}

export function registerSelfawareToolsDirect(server: McpServer, router: IpcRouter): void {
  registerSelfawareToolsWithCaller(server, (method, params) => router.handle(method, params));
}

function registerSelfawareToolsWithCaller(server: McpServer, call: BrainCall): void {

  server.tool(
    'marketing_blind_spots',
    'Detect Marketing Brain knowledge blind spots: areas with high activity but low understanding.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('blindspot.detect', {});
        const lines = ['# Marketing Blind Spots', ''];
        if (result?.blindSpots?.length > 0) {
          lines.push(`**Found:** ${result.blindSpots.length} blind spot(s)`, '');
          for (const bs of result.blindSpots) {
            lines.push(`- **${bs.topic}** [${bs.type}]: severity ${(bs.severity * 100).toFixed(0)}%${bs.reason ? ` — ${bs.reason}` : ''}`);
          }
        } else {
          lines.push('No blind spots detected.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error detecting blind spots: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_meta_trends',
    'Get Marketing Brain meta-learning trends: learning speed, hypothesis quality, experiment success rates.',
    { windowCycles: z.number().optional().describe('Number of cycles to analyze (default: 50)') },
    async (params) => {
      try {
        const result: AnyResult = await call('metatrend.get', { windowCycles: params.windowCycles });
        const lines = ['# Marketing Meta-Learning Trends', ''];
        if (result?.trends?.length > 0) {
          for (const t of result.trends) {
            lines.push(`- **${t.metric}**: ${t.current?.toFixed(3) ?? 'N/A'} (avg: ${t.average?.toFixed(3) ?? 'N/A'}, trend: ${t.direction ?? 'stable'})`);
          }
        } else {
          lines.push('No trends available yet.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting meta trends: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_long_term_analysis',
    'Get Marketing Brain long-term learning analysis: growth trajectory, milestones, learning velocity.',
    { days: z.number().optional().describe('Number of days to analyze (default: 7)') },
    async (params) => {
      try {
        const result: AnyResult = await call('metatrend.longterm', { days: params.days });
        const lines = ['# Marketing Long-Term Analysis', ''];
        if (result?.summary) lines.push(result.summary, '');
        if (result?.milestones?.length > 0) {
          lines.push('## Milestones');
          for (const m of result.milestones) lines.push(`- **${m.date ?? m.cycle}**: ${m.description}`);
        }
        if (result?.velocity !== undefined) lines.push('', `**Learning Velocity:** ${result.velocity.toFixed(3)} (${result.velocityTrend ?? 'stable'})`);
        if (!result) lines.push('Not enough data for long-term analysis.');
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error in long-term analysis: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_creative_hypotheses',
    'Generate creative marketing hypotheses by combining unrelated domains, inverting assumptions, or applying analogies.',
    { count: z.number().optional().describe('Number of hypotheses (default: 3)') },
    async (params) => {
      try {
        const result: AnyResult = await call('hypothesis.creative', { count: params.count });
        const hypotheses = Array.isArray(result) ? result : result?.hypotheses ?? [];
        if (!hypotheses.length) return textResult('No creative hypotheses generated.');

        const lines = [`# Creative Marketing Hypotheses: ${hypotheses.length}`, ''];
        for (const h of hypotheses) {
          lines.push(`- **${h.statement ?? h.title}** (${h.method ?? 'creative'}, confidence: ${h.confidence !== undefined ? (h.confidence * 100).toFixed(0) + '%' : 'N/A'})`);
          if (h.reasoning) lines.push(`  ${h.reasoning}`);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error generating hypotheses: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_challenge_principle',
    'Challenge a marketing principle using Advocatus Diaboli: find counter-arguments and edge cases.',
    { statement: z.string().describe('The principle or statement to challenge') },
    async (params) => {
      try {
        const result: AnyResult = await call('challenge.principle', { statement: params.statement });
        const lines = [`# Challenge: "${params.statement}"`, ''];
        if (result?.challenges?.length > 0) {
          for (const c of result.challenges) lines.push(`- **${c.type ?? 'counter'}**: ${c.argument}`);
          lines.push('');
        }
        if (result?.verdict) lines.push(`**Verdict:** ${result.verdict}`);
        if (result?.score !== undefined) lines.push(`**Robustness:** ${(result.score * 100).toFixed(0)}%`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error challenging principle: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_dream_retrospective',
    'Analyze Marketing Brain dream pruning: what was pruned, compressed, or strengthened, and whether decisions were good.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('dream.retrospective', {});
        const lines = ['# Marketing Dream Retrospective', ''];
        if (result) {
          lines.push(`**Sessions:** ${result.totalSessions ?? 0} | **Last:** ${result.lastSession ?? 'never'}`, '');
          if (result.pruned?.length > 0) { lines.push('## Pruned'); for (const p of result.pruned) lines.push(`- ${p.topic ?? p.description}`); lines.push(''); }
          if (result.compressed?.length > 0) { lines.push('## Compressed'); for (const c of result.compressed) lines.push(`- ${c.count ?? 2} items → "${c.result ?? c.topic}"`); lines.push(''); }
          if (result.strengthened?.length > 0) { lines.push('## Strengthened'); for (const s of result.strengthened) lines.push(`- ${s.topic}: ${s.oldWeight?.toFixed(3) ?? '?'} → ${s.newWeight?.toFixed(3) ?? '?'}`); lines.push(''); }
          if (result.regrets?.length > 0) { lines.push('## Regrets'); for (const r of result.regrets) lines.push(`- ${r.topic}: ${r.reason}`); }
        } else {
          lines.push('No dream sessions recorded.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting dream retrospective: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_cross_brain_dialogue',
    'Start cross-brain dialogue from Marketing Brain perspective on a topic.',
    { topic: z.string().describe('Topic or question to discuss') },
    async (params) => {
      try {
        const result: AnyResult = await call('dialogue.ask', { topic: params.topic });
        const lines = [`# Cross-Brain Dialogue: "${params.topic}"`, ''];
        if (result?.perspectives?.length > 0) {
          for (const p of result.perspectives) {
            lines.push(`## ${p.brain ?? p.source}`);
            lines.push(p.response ?? p.perspective);
            lines.push('');
          }
        }
        if (result?.synthesis) lines.push('## Synthesis', result.synthesis);
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error in dialogue: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_self_test',
    'Self-test all Marketing Brain principles: verify against recent evidence, flag contradictions.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('selftest.all', {});
        const lines = ['# Marketing Self-Test Results', ''];
        if (result) {
          lines.push(`**Tested:** ${result.tested ?? 0} | **Passed:** ${result.passed ?? 0} | **Failed:** ${result.failed ?? 0}`, '');
          if (result.failures?.length > 0) {
            lines.push('## Failures');
            for (const f of result.failures) lines.push(`- **${f.principle}**: ${f.reason}`);
          }
        } else {
          lines.push('No principles to test.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error running self-test: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_self_test_report',
    'Get Marketing Brain understanding report: what it knows, confidence levels, weakest areas.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('selftest.report', {});
        const lines = ['# Marketing Understanding Report', ''];
        if (result) {
          if (result.overallConfidence !== undefined) lines.push(`**Overall Confidence:** ${(result.overallConfidence * 100).toFixed(0)}%`);
          if (result.totalPrinciples !== undefined) lines.push(`**Principles:** ${result.totalPrinciples}`);
          lines.push('');
          if (result.strongestAreas?.length > 0) { lines.push('## Strongest'); for (const a of result.strongestAreas) lines.push(`- ${a.topic}: ${(a.confidence * 100).toFixed(0)}%`); lines.push(''); }
          if (result.weakestAreas?.length > 0) { lines.push('## Weakest'); for (const a of result.weakestAreas) lines.push(`- ${a.topic}: ${(a.confidence * 100).toFixed(0)}% — ${a.reason}`); }
        } else {
          lines.push('No understanding data available.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting report: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_teach_create',
    'Create a teaching package from Marketing Brain knowledge for another brain.',
    { targetBrain: z.string().describe('Target brain (e.g. "brain", "trading")') },
    async (params) => {
      try {
        const result: AnyResult = await call('teach.create', { targetBrain: params.targetBrain });
        const lines = [`# Marketing Teaching Package → ${params.targetBrain}`, ''];
        if (result) {
          lines.push(`**Principles:** ${result.principleCount ?? 0} | **Anti-Patterns:** ${result.antiPatternCount ?? 0} | **Strategies:** ${result.strategyCount ?? 0}`);
          if (result.topics?.length > 0) { lines.push('', '## Topics'); for (const t of result.topics) lines.push(`- ${t}`); }
        } else {
          lines.push('Could not create teaching package.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error creating package: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_teach_packages',
    'List Marketing Brain teaching packages.',
    { limit: z.number().optional().describe('Max packages (default: 10)') },
    async (params) => {
      try {
        const packages: AnyResult[] = await call('teach.list', { limit: params.limit ?? 10 }) as AnyResult[];
        if (!packages?.length) return textResult('No teaching packages created yet.');
        const lines = [`# Marketing Teaching Packages: ${packages.length}`, ''];
        for (const p of packages) lines.push(`- **${p.targetBrain}** (${p.created_at}): ${p.principleCount ?? 0} principles, status: ${p.status ?? 'created'}`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error listing packages: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_scout_status',
    'Get Marketing Brain DataScout status: monitored sources, scan times, discovery counts.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('scout.status', {});
        const lines = ['# Marketing DataScout Status', ''];
        if (result) {
          lines.push(`**Sources:** ${result.activeSources ?? 0} | **Discoveries:** ${result.totalDiscoveries ?? 0} | **Last Scan:** ${result.lastScan ?? 'never'}`, '');
          if (result.sources?.length > 0) { for (const s of result.sources) lines.push(`- **${s.name}**: ${s.discoveryCount ?? 0} discoveries`); }
        } else {
          lines.push('DataScout not initialized.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting scout status: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_scout_discoveries',
    'Get Marketing Brain scout discoveries from monitored sources.',
    {
      source: z.string().optional().describe('Filter by source'),
      limit: z.number().optional().describe('Max discoveries (default: 20)'),
    },
    async (params) => {
      try {
        const discoveries: AnyResult[] = await call('scout.discoveries', { source: params.source, limit: params.limit ?? 20 }) as AnyResult[];
        if (!discoveries?.length) return textResult('No discoveries yet.');
        const lines = [`# Marketing Discoveries: ${discoveries.length}`, ''];
        for (const d of discoveries) {
          lines.push(`- **${d.title ?? d.topic}** (${d.source}, ${d.discovered_at ?? d.created_at})${d.relevance !== undefined ? ` — relevance: ${(d.relevance * 100).toFixed(0)}%` : ''}`);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting discoveries: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_simulate',
    'Run what-if simulation on Marketing Brain: predict effects of metric changes.',
    {
      metric: z.string().describe('Metric to simulate (e.g. "engagement_rate", "post_frequency")'),
      multiplier: z.number().describe('Multiplier (e.g. 2.0 = double, 0.5 = halve)'),
    },
    async (params) => {
      try {
        const result: AnyResult = await call('simulation.whatif', { metric: params.metric, multiplier: params.multiplier });
        const lines = [`# Marketing Simulation: ${params.metric} x${params.multiplier}`, ''];
        if (result?.predictions?.length > 0) {
          for (const p of result.predictions) lines.push(`- **${p.metric ?? p.area}**: ${p.currentValue?.toFixed(3) ?? '?'} → ${p.predictedValue?.toFixed(3) ?? '?'}`);
          lines.push('');
        }
        if (result?.risks?.length > 0) { lines.push('## Risks'); for (const r of result.risks) lines.push(`- ${r}`); }
        if (result?.summary) lines.push('', result.summary);
        if (!result) lines.push('Not enough data for simulation.');
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error running simulation: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'marketing_emergence_explain',
    'Explain an emergence event in Marketing Brain: why it occurred and what it means.',
    { eventId: z.number().describe('Emergence event ID') },
    async (params) => {
      try {
        const result: AnyResult = await call('emergence.explain', { eventId: params.eventId });
        const lines = ['# Marketing Emergence Explanation', ''];
        if (result?.event) {
          lines.push(`**Event:** ${result.event.title ?? result.event.type} | **Surprise:** ${result.event.surprise_score !== undefined ? (result.event.surprise_score * 100).toFixed(0) + '%' : 'N/A'}`);
          if (result.event.description) lines.push(result.event.description);
          lines.push('');
        }
        if (result?.explanation) lines.push('## Explanation', result.explanation, '');
        if (result?.contributing_factors?.length > 0) { lines.push('## Factors'); for (const f of result.contributing_factors) lines.push(`- ${f}`); }
        if (!result) lines.push(`No event found with ID ${params.eventId}.`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error explaining emergence: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
