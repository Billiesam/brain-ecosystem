import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider, table } from '../colors.js';

export function llmCommand(): Command {
  const cmd = new Command('llm')
    .description('LLM service — usage, providers, routing, templates');

  // Default action: overview
  cmd.action(async () => {
    await withIpc(async (client) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stats: any = await client.request('llm.status', {});
      console.log(header('LLM Overview', '🤖'));

      if (!stats) {
        console.log(`  ${c.dim('LLM Service not available')}`);
        console.log(divider());
        return;
      }

      // Summary
      const totalCalls = stats.totalCalls ?? 0;
      const totalTokens = stats.totalTokens ?? 0;
      const cacheHits = stats.cacheHits ?? 0;
      const cacheRate = totalCalls > 0 ? ((cacheHits / totalCalls) * 100).toFixed(1) : '0.0';
      console.log(keyValue('  Total Calls', totalCalls.toLocaleString()));
      console.log(keyValue('  Total Tokens', totalTokens.toLocaleString()));
      console.log(keyValue('  Cache Hits', `${cacheHits.toLocaleString()} (${cacheRate}%)`));

      // Budget
      if (stats.rateLimits) {
        const rl = stats.rateLimits;
        console.log(`\n  ${c.cyan.bold('Rate Limits')}`);
        console.log(keyValue('    Calls/h', `${rl.callsThisHour ?? 0}/${rl.maxCallsPerHour ?? '∞'}`));
        console.log(keyValue('    Tokens/h', `${(rl.tokensThisHour ?? 0).toLocaleString()}/${(rl.maxTokensPerHour ?? 0).toLocaleString()}`));
      }

      // Providers
      if (stats.providers?.length) {
        console.log(`\n  ${c.cyan.bold('Providers')}`);
        for (const p of stats.providers) {
          const status = p.available ? c.green('●') : c.red('●');
          const calls = p.usage?.totalCalls ?? 0;
          const tokens = p.usage?.totalTokens ?? 0;
          console.log(`  ${status} ${c.cyan(p.name)} ${c.dim(`(${p.type})`)}  ${calls} calls, ${tokens.toLocaleString()} tokens`);
        }
      }

      console.log(divider());
    });
  });

  // Subcommand: history
  cmd.command('history')
    .description('Hourly usage history')
    .option('-h, --hours <n>', 'Hours to show', '24')
    .action(async (opts: { hours: string }) => {
      await withIpc(async (client) => {
        const hours = parseInt(opts.hours, 10);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const history: any[] = await client.request('llm.history', { hours }) as any[];
        console.log(header(`LLM Usage — Last ${hours}h`, '📊'));

        if (!history?.length) {
          console.log(`  ${c.dim('No usage data')}`);
          console.log(divider());
          return;
        }

        const rows: string[][] = [
          ['Hour', 'Calls', 'Tokens', 'Cache', 'Avg Latency'],
          ...history.map((h) => [
            c.dim(h.hour ?? h.timestamp ?? '?'),
            String(h.calls ?? 0),
            (h.tokens ?? 0).toLocaleString(),
            String(h.cacheHits ?? 0),
            h.avgLatency ? `${Math.round(h.avgLatency)}ms` : '-',
          ]),
        ];
        console.log(table(rows));
        console.log(divider());
      });
    });

  // Subcommand: templates
  cmd.command('templates')
    .description('Usage breakdown by template')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const templates: any = await client.request('llm.byTemplate', {});
        console.log(header('LLM Templates', '📝'));

        const entries = Array.isArray(templates) ? templates : Object.entries(templates ?? {}).map(([name, data]) => ({ name, ...(data as object) }));
        if (!entries.length) {
          console.log(`  ${c.dim('No template usage data')}`);
          console.log(divider());
          return;
        }

        const rows: string[][] = [
          ['Template', 'Calls', 'Tokens', 'Avg Tokens', 'Cache'],
          ...entries.map((t: { name?: string; template?: string; calls?: number; tokens?: number; avgTokens?: number; cacheHits?: number }) => [
            c.cyan(t.name ?? t.template ?? '?'),
            String(t.calls ?? 0),
            (t.tokens ?? 0).toLocaleString(),
            t.avgTokens ? String(Math.round(t.avgTokens)) : '-',
            String(t.cacheHits ?? 0),
          ]),
        ];
        console.log(table(rows));
        console.log(divider());
      });
    });

  // Subcommand: routing
  cmd.command('routing')
    .description('Template → provider routing table')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await client.request('llm.routing', {});
        console.log(header('LLM Routing', '🔀'));

        const routes = result?.routes ?? result;
        if (!routes?.length) {
          console.log(`  ${c.dim('No routing rules configured')}`);
          console.log(divider());
          return;
        }

        const rows: string[][] = [
          ['Template', 'Provider', 'Model', 'Priority'],
          ...routes.map((r: { template?: string; pattern?: string; provider?: string; model?: string; priority?: number }) => [
            c.cyan(r.template ?? r.pattern ?? '*'),
            c.green(r.provider ?? '?'),
            r.model ?? 'default',
            String(r.priority ?? '-'),
          ]),
        ];
        console.log(table(rows));
        console.log(divider());
      });
    });

  // Subcommand: providers
  cmd.command('providers')
    .description('Detailed provider status')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const providers: any = await client.request('llm.providers', {});
        console.log(header('LLM Providers', '🔌'));

        const list = Array.isArray(providers) ? providers : providers?.providers ?? [];
        if (!list.length) {
          console.log(`  ${c.dim('No providers configured')}`);
          console.log(divider());
          return;
        }

        for (const p of list) {
          const status = p.available ? c.green('● Available') : c.red('● Unavailable');
          console.log(`\n  ${c.cyan.bold(p.name)} ${c.dim(`(${p.type ?? '?'})`)} ${status}`);
          if (p.models?.length) {
            console.log(keyValue('    Models', p.models.join(', ')));
          }
          if (p.defaultModel) {
            console.log(keyValue('    Default Model', p.defaultModel));
          }
          if (p.usage) {
            console.log(keyValue('    Calls', String(p.usage.totalCalls ?? 0)));
            console.log(keyValue('    Tokens', (p.usage.totalTokens ?? 0).toLocaleString()));
            console.log(keyValue('    Cache Hits', String(p.usage.cacheHits ?? 0)));
            if (p.usage.avgLatency) {
              console.log(keyValue('    Avg Latency', `${Math.round(p.usage.avgLatency)}ms`));
            }
          }
          if (p.errors) {
            console.log(keyValue('    Errors', c.red(String(p.errors))));
          }
        }

        // Ollama status
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ollama: any = await client.request('llm.ollamaStatus', {});
          if (ollama) {
            console.log(`\n  ${c.cyan.bold('Ollama')}`);
            console.log(keyValue('    Connected', ollama.connected ? c.green('yes') : c.red('no')));
            if (ollama.models?.length) {
              console.log(keyValue('    Models', ollama.models.map((m: { name: string }) => m.name).join(', ')));
            }
          }
        } catch { /* ollama not available */ }

        console.log(divider());
      });
    });

  return cmd;
}
