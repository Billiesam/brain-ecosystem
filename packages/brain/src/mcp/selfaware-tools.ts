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
    'brain_blind_spots',
    'Detect knowledge blind spots: areas where Brain has high activity but low understanding, or topics it systematically avoids.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('blindspot.detect', {});
        const lines = ['# Knowledge Blind Spots', ''];
        if (result?.blindSpots?.length > 0) {
          lines.push(`**Found:** ${result.blindSpots.length} blind spot(s)`, '');
          for (const bs of result.blindSpots) {
            lines.push(`## ${bs.topic}`);
            lines.push(`**Type:** ${bs.type} | **Severity:** ${(bs.severity * 100).toFixed(0)}%`);
            if (bs.reason) lines.push(`**Reason:** ${bs.reason}`);
            if (bs.suggestion) lines.push(`**Suggestion:** ${bs.suggestion}`);
            lines.push('');
          }
        } else {
          lines.push('No blind spots detected. Brain has good coverage across all active topics.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error detecting blind spots: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_meta_trends',
    'Get meta-learning trends: how Brain learning speed, hypothesis quality, and experiment success rates change over time.',
    { windowCycles: z.number().optional().describe('Number of cycles to analyze (default: 50)') },
    async (params) => {
      try {
        const result: AnyResult = await call('metatrend.get', { windowCycles: params.windowCycles });
        const lines = ['# Meta-Learning Trends', ''];
        if (result?.trends?.length > 0) {
          for (const t of result.trends) {
            lines.push(`## ${t.metric}`);
            lines.push(`**Current:** ${t.current?.toFixed(3) ?? 'N/A'} | **Average:** ${t.average?.toFixed(3) ?? 'N/A'} | **Trend:** ${t.direction ?? 'stable'}`);
            if (t.changePercent !== undefined) lines.push(`**Change:** ${t.changePercent > 0 ? '+' : ''}${t.changePercent.toFixed(1)}%`);
            lines.push('');
          }
        } else {
          lines.push('No trends available yet. Brain needs more cycles to establish trend data.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting meta trends: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_long_term_analysis',
    'Get long-term learning analysis: overall Brain growth trajectory, milestone detection, and learning velocity over days/weeks.',
    { days: z.number().optional().describe('Number of days to analyze (default: 7)') },
    async (params) => {
      try {
        const result: AnyResult = await call('metatrend.longterm', { days: params.days });
        const lines = ['# Long-Term Learning Analysis', ''];
        if (result) {
          if (result.summary) lines.push(result.summary, '');
          if (result.milestones?.length > 0) {
            lines.push('## Milestones');
            for (const m of result.milestones) {
              lines.push(`- **${m.date ?? m.cycle}**: ${m.description}`);
            }
            lines.push('');
          }
          if (result.velocity !== undefined) {
            lines.push(`## Learning Velocity`);
            lines.push(`**Current:** ${result.velocity.toFixed(3)} | **Trend:** ${result.velocityTrend ?? 'stable'}`);
          }
        } else {
          lines.push('Not enough data for long-term analysis yet.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error in long-term analysis: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_creative_hypotheses',
    'Generate creative hypotheses by combining unrelated knowledge domains, inverting assumptions, or applying analogies from other fields.',
    { count: z.number().optional().describe('Number of hypotheses to generate (default: 3)') },
    async (params) => {
      try {
        const result: AnyResult = await call('hypothesis.creative', { count: params.count });
        const hypotheses = Array.isArray(result) ? result : result?.hypotheses ?? [];
        if (!hypotheses.length) return textResult('No creative hypotheses could be generated. Brain needs more diverse knowledge first.');

        const lines = [`# Creative Hypotheses: ${hypotheses.length}`, ''];
        for (const h of hypotheses) {
          lines.push(`## ${h.statement ?? h.title}`);
          if (h.method) lines.push(`**Method:** ${h.method}`);
          if (h.confidence !== undefined) lines.push(`**Confidence:** ${(h.confidence * 100).toFixed(0)}%`);
          if (h.reasoning) lines.push(`**Reasoning:** ${h.reasoning}`);
          if (h.testable) lines.push(`**How to test:** ${h.testable}`);
          lines.push('');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error generating hypotheses: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_challenge_principle',
    'Challenge a principle or belief using Advocatus Diaboli: generate counter-arguments, find edge cases, and stress-test assumptions.',
    { statement: z.string().describe('The principle or statement to challenge') },
    async (params) => {
      try {
        const result: AnyResult = await call('challenge.principle', { statement: params.statement });
        const lines = [`# Advocatus Diaboli: Challenge`, '', `**Statement:** "${params.statement}"`, ''];
        if (result?.challenges?.length > 0) {
          lines.push('## Counter-Arguments');
          for (const c of result.challenges) {
            lines.push(`- **${c.type ?? 'challenge'}**: ${c.argument}`);
            if (c.strength) lines.push(`  Strength: ${c.strength}`);
          }
          lines.push('');
        }
        if (result?.verdict) lines.push(`## Verdict`, result.verdict, '');
        if (result?.score !== undefined) lines.push(`**Robustness Score:** ${(result.score * 100).toFixed(0)}%`);
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error challenging principle: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_dream_retrospective',
    'Analyze dream pruning retrospective: what was pruned, compressed, or strengthened during dream cycles, and whether pruning decisions were good.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('dream.retrospective', {});
        const lines = ['# Dream Retrospective', ''];
        if (result) {
          if (result.totalSessions !== undefined) lines.push(`**Sessions:** ${result.totalSessions} | **Last:** ${result.lastSession ?? 'never'}`);
          lines.push('');
          if (result.pruned?.length > 0) {
            lines.push('## Pruned (Removed)');
            for (const p of result.pruned) lines.push(`- ${p.topic ?? p.description}: weight ${p.weight?.toFixed(3) ?? 'N/A'}`);
            lines.push('');
          }
          if (result.compressed?.length > 0) {
            lines.push('## Compressed (Merged)');
            for (const c of result.compressed) lines.push(`- ${c.count ?? 2} items → "${c.result ?? c.topic}"`);
            lines.push('');
          }
          if (result.strengthened?.length > 0) {
            lines.push('## Strengthened');
            for (const s of result.strengthened) lines.push(`- ${s.topic}: ${s.oldWeight?.toFixed(3) ?? '?'} → ${s.newWeight?.toFixed(3) ?? '?'}`);
            lines.push('');
          }
          if (result.regrets?.length > 0) {
            lines.push('## Regrets (Questionable Prunes)');
            for (const r of result.regrets) lines.push(`- ${r.topic}: ${r.reason}`);
          }
        } else {
          lines.push('No dream sessions recorded yet.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting dream retrospective: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_cross_brain_dialogue',
    'Start a cross-brain dialogue: ask a question that gets perspectives from Brain, Trading Brain, and Marketing Brain.',
    { topic: z.string().describe('The topic or question to discuss across brains') },
    async (params) => {
      try {
        const result: AnyResult = await call('dialogue.ask', { topic: params.topic });
        const lines = [`# Cross-Brain Dialogue`, '', `**Topic:** "${params.topic}"`, ''];
        if (result?.perspectives?.length > 0) {
          for (const p of result.perspectives) {
            lines.push(`## ${p.brain ?? p.source}`);
            lines.push(p.response ?? p.perspective);
            if (p.confidence !== undefined) lines.push(`*Confidence: ${(p.confidence * 100).toFixed(0)}%*`);
            lines.push('');
          }
        }
        if (result?.synthesis) {
          lines.push('## Synthesis');
          lines.push(result.synthesis);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error in cross-brain dialogue: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_self_test',
    'Self-test all principles: verify each learned principle against recent evidence and flag contradictions or outdated knowledge.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('selftest.all', {});
        const lines = ['# Self-Test Results', ''];
        if (result) {
          lines.push(`**Tested:** ${result.tested ?? 0} | **Passed:** ${result.passed ?? 0} | **Failed:** ${result.failed ?? 0} | **Inconclusive:** ${result.inconclusive ?? 0}`);
          lines.push('');
          if (result.failures?.length > 0) {
            lines.push('## Failed Principles');
            for (const f of result.failures) {
              lines.push(`- **${f.principle}**: ${f.reason}`);
              if (f.evidence) lines.push(`  Evidence: ${f.evidence}`);
            }
            lines.push('');
          }
          if (result.warnings?.length > 0) {
            lines.push('## Warnings');
            for (const w of result.warnings) lines.push(`- ${w.principle}: ${w.reason}`);
          }
        } else {
          lines.push('No principles to test yet.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error running self-test: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_self_test_report',
    'Get understanding report: comprehensive overview of what Brain knows, how confident it is, and where knowledge is weakest.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('selftest.report', {});
        const lines = ['# Understanding Report', ''];
        if (result) {
          if (result.overallConfidence !== undefined) lines.push(`**Overall Confidence:** ${(result.overallConfidence * 100).toFixed(0)}%`);
          if (result.totalPrinciples !== undefined) lines.push(`**Principles:** ${result.totalPrinciples} | **Verified:** ${result.verified ?? 0}`);
          lines.push('');
          if (result.strongestAreas?.length > 0) {
            lines.push('## Strongest Areas');
            for (const a of result.strongestAreas) lines.push(`- ${a.topic}: ${(a.confidence * 100).toFixed(0)}% (${a.evidenceCount} evidence points)`);
            lines.push('');
          }
          if (result.weakestAreas?.length > 0) {
            lines.push('## Weakest Areas');
            for (const a of result.weakestAreas) lines.push(`- ${a.topic}: ${(a.confidence * 100).toFixed(0)}% — ${a.reason}`);
            lines.push('');
          }
          if (result.recommendations?.length > 0) {
            lines.push('## Recommendations');
            for (const r of result.recommendations) lines.push(`- ${r}`);
          }
        } else {
          lines.push('No understanding data available yet.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting understanding report: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_teach_create',
    'Create a teaching package: distill Brain knowledge into a transferable package for another brain.',
    { targetBrain: z.string().describe('Target brain to teach (e.g. "trading", "marketing")') },
    async (params) => {
      try {
        const result: AnyResult = await call('teach.create', { targetBrain: params.targetBrain });
        const lines = [`# Teaching Package for ${params.targetBrain}`, ''];
        if (result) {
          if (result.id) lines.push(`**Package ID:** ${result.id}`);
          lines.push(`**Principles:** ${result.principleCount ?? 0} | **Anti-Patterns:** ${result.antiPatternCount ?? 0} | **Strategies:** ${result.strategyCount ?? 0}`);
          lines.push('');
          if (result.topics?.length > 0) {
            lines.push('## Topics Included');
            for (const t of result.topics) lines.push(`- ${t}`);
            lines.push('');
          }
          if (result.summary) lines.push('## Summary', result.summary);
        } else {
          lines.push('Could not create teaching package. Brain may not have enough knowledge to share.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error creating teaching package: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_teach_packages',
    'List teaching packages: previously created knowledge packages for other brains.',
    { limit: z.number().optional().describe('Max packages to return (default: 10)') },
    async (params) => {
      try {
        const packages: AnyResult[] = await call('teach.list', { limit: params.limit ?? 10 }) as AnyResult[];
        if (!packages?.length) return textResult('No teaching packages created yet.');

        const lines = [`# Teaching Packages: ${packages.length}`, ''];
        for (const p of packages) {
          lines.push(`## ${p.targetBrain ?? 'unknown'} — ${p.created_at ?? ''}`);
          lines.push(`ID: ${p.id} | Principles: ${p.principleCount ?? 0} | Status: ${p.status ?? 'created'}`);
          if (p.summary) lines.push(p.summary);
          lines.push('');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error listing teaching packages: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_scout_status',
    'Get DataScout status: what external data sources are being monitored, last scan times, and discovery counts.',
    {},
    async () => {
      try {
        const result: AnyResult = await call('scout.status', {});
        const lines = ['# DataScout Status', ''];
        if (result) {
          lines.push(`**Active Sources:** ${result.activeSources ?? 0} | **Total Discoveries:** ${result.totalDiscoveries ?? 0}`);
          if (result.lastScan) lines.push(`**Last Scan:** ${result.lastScan}`);
          lines.push('');
          if (result.sources?.length > 0) {
            lines.push('## Sources');
            for (const s of result.sources) {
              lines.push(`- **${s.name}**: ${s.status ?? 'active'} (${s.discoveryCount ?? 0} discoveries, last: ${s.lastScan ?? 'never'})`);
            }
          }
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
    'brain_scout_discoveries',
    'Get scout discoveries: external data insights found by DataScout from monitored sources.',
    {
      source: z.string().optional().describe('Filter by source name'),
      limit: z.number().optional().describe('Max discoveries to return (default: 20)'),
    },
    async (params) => {
      try {
        const discoveries: AnyResult[] = await call('scout.discoveries', { source: params.source, limit: params.limit ?? 20 }) as AnyResult[];
        if (!discoveries?.length) return textResult('No discoveries yet. DataScout needs to scan external sources first.');

        const lines = [`# Scout Discoveries: ${discoveries.length}`, ''];
        for (const d of discoveries) {
          lines.push(`## ${d.title ?? d.topic}`);
          lines.push(`**Source:** ${d.source} | **Found:** ${d.discovered_at ?? d.created_at}`);
          if (d.relevance !== undefined) lines.push(`**Relevance:** ${(d.relevance * 100).toFixed(0)}%`);
          if (d.summary) lines.push(d.summary);
          lines.push('');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error getting discoveries: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_simulate',
    'Run a what-if simulation: predict what would happen if a metric changed by a given multiplier.',
    {
      metric: z.string().describe('The metric to simulate changes for (e.g. "error_rate", "resolution_speed")'),
      multiplier: z.number().describe('Multiplier for the metric (e.g. 2.0 = double, 0.5 = halve)'),
    },
    async (params) => {
      try {
        const result: AnyResult = await call('simulation.whatif', { metric: params.metric, multiplier: params.multiplier });
        const lines = [`# What-If Simulation`, '', `**Scenario:** ${params.metric} x${params.multiplier}`, ''];
        if (result) {
          if (result.predictions?.length > 0) {
            lines.push('## Predicted Effects');
            for (const p of result.predictions) {
              lines.push(`- **${p.metric ?? p.area}**: ${p.currentValue?.toFixed(3) ?? '?'} → ${p.predictedValue?.toFixed(3) ?? '?'} (${p.confidence ? (p.confidence * 100).toFixed(0) + '% confidence' : ''})`);
              if (p.explanation) lines.push(`  ${p.explanation}`);
            }
            lines.push('');
          }
          if (result.risks?.length > 0) {
            lines.push('## Risks');
            for (const r of result.risks) lines.push(`- ${r}`);
            lines.push('');
          }
          if (result.summary) lines.push('## Summary', result.summary);
        } else {
          lines.push('Simulation could not produce results. Not enough historical data for this metric.');
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error running simulation: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'brain_emergence_explain',
    'Explain an emergence event: provide detailed analysis of why an emergent behavior occurred and what it means.',
    { eventId: z.number().describe('The emergence event ID to explain') },
    async (params) => {
      try {
        const result: AnyResult = await call('emergence.explain', { eventId: params.eventId });
        const lines = [`# Emergence Explanation`, ''];
        if (result) {
          if (result.event) {
            lines.push(`## Event: ${result.event.title ?? result.event.type}`);
            lines.push(`**Type:** ${result.event.type} | **Surprise:** ${result.event.surprise_score !== undefined ? (result.event.surprise_score * 100).toFixed(0) + '%' : 'N/A'}`);
            if (result.event.description) lines.push(result.event.description);
            lines.push('');
          }
          if (result.explanation) {
            lines.push('## Explanation');
            lines.push(result.explanation);
            lines.push('');
          }
          if (result.contributing_factors?.length > 0) {
            lines.push('## Contributing Factors');
            for (const f of result.contributing_factors) lines.push(`- ${f}`);
            lines.push('');
          }
          if (result.implications?.length > 0) {
            lines.push('## Implications');
            for (const i of result.implications) lines.push(`- ${i}`);
          }
        } else {
          lines.push(`No emergence event found with ID ${params.eventId}.`);
        }
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Error explaining emergence: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
