import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider } from '../colors.js';

export function strategyCommand(): Command {
  const cmd = new Command('strategy')
    .description('StrategyForge — autonomous strategy creation, backtesting & execution');

  cmd.command('list')
    .description('Show active strategies')
    .action(async () => {
      await withIpc(async (client) => {
        const strategies: any[] = await client.request('strategy.active') as any[];
        console.log(header(`Active Strategies (${strategies.length})`, '♟️'));
        for (const s of strategies) {
          const winRate = s.performance?.executions > 0 ? (s.performance.successes / s.performance.executions * 100).toFixed(0) + '%' : '-';
          console.log(`  ${c.dim(`#${s.id}`)} ${s.name} (${s.type}) — ${s.rules?.length ?? 0} rules, win=${c.value(winRate)}`);
        }
        console.log(divider());
      });
    });

  cmd.command('create')
    .description('Create a strategy from learned principles')
    .argument('<domain>', 'Knowledge domain (e.g. trading, marketing, research)')
    .action(async (domain) => {
      await withIpc(async (client) => {
        const result: any = await client.request('strategy.create', { domain });
        if (result) {
          console.log(`  ${c.green('Strategy created')} — #${result.id}: ${result.name} (${result.rules?.length ?? 0} rules)`);
        } else {
          console.log(`  ${c.dim('No principles found for domain:')} ${domain}`);
        }
      });
    });

  cmd.command('performance')
    .description('Show strategy performance')
    .argument('<id>', 'Strategy ID')
    .action(async (id) => {
      await withIpc(async (client) => {
        const perf: any = await client.request('strategy.performance', { id: parseInt(id, 10) });
        if (perf) {
          console.log(header(`Strategy #${id} Performance`, '📊'));
          console.log(keyValue('Executions', String(perf.executions)));
          console.log(keyValue('Successes', String(perf.successes)));
          console.log(keyValue('Win Rate', perf.executions > 0 ? `${(perf.successes / perf.executions * 100).toFixed(1)}%` : '-'));
          console.log(keyValue('Avg Return', `${(perf.avgReturn * 100).toFixed(2)}%`));
          console.log(divider());
        } else {
          console.log(`  ${c.red('Strategy not found')}`);
        }
      });
    });

  cmd.command('evolve')
    .description('Evolve new strategy from best active strategies')
    .action(async () => {
      await withIpc(async (client) => {
        const result: any = await client.request('strategy.evolve');
        if (result) {
          console.log(`  ${c.green('Evolved strategy')} — #${result.id}: ${result.name}`);
        } else {
          console.log(`  ${c.dim('Need at least 2 active strategies to evolve')}`);
        }
      });
    });

  cmd.action(async () => {
    await withIpc(async (client) => {
      const status: any = await client.request('strategy.status');
      console.log(header('StrategyForge Status', '♟️'));
      console.log(keyValue('Active', String(status.active)));
      console.log(keyValue('Total', String(status.total)));
      console.log(keyValue('Avg Performance', `${(status.avgPerformance * 100).toFixed(1)}%`));
      console.log(keyValue('Top Strategy', status.topStrategy ?? c.dim('none')));
      console.log(divider());
    });
  });

  return cmd;
}
