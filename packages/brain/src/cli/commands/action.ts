import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider, table } from '../colors.js';

export function actionCommand(): Command {
  const cmd = new Command('action')
    .description('ActionBridge — risk-assessed auto-execution of proposed actions');

  cmd.command('queue')
    .description('Show pending action queue')
    .action(async () => {
      await withIpc(async (client) => {
        const queue: any[] = await client.request('action.queue', { status: 'pending' }) as any[];
        console.log(header(`Action Queue (${queue.length} pending)`, '⚡'));
        if (queue.length === 0) {
          console.log(`  ${c.dim('No pending actions')}`);
        } else {
          for (const a of queue) {
            const risk = a.riskLevel === 'high' ? c.red(a.riskLevel) : a.riskLevel === 'medium' ? c.orange(a.riskLevel) : c.green(a.riskLevel);
            console.log(`  ${c.dim(`#${a.id}`)} ${a.title} ${c.dim(`(${a.source}/${a.type})`)} risk=${risk} conf=${c.value((a.confidence * 100).toFixed(0) + '%')}`);
          }
        }
        console.log(divider());
      });
    });

  cmd.command('history')
    .description('Show action execution history')
    .option('-n, --limit <n>', 'Number of entries', '20')
    .action(async (opts) => {
      await withIpc(async (client) => {
        const history: any[] = await client.request('action.history', { limit: parseInt(opts.limit, 10) }) as any[];
        console.log(header(`Action History (${history.length} entries)`, '📜'));
        for (const a of history) {
          const status = a.status === 'completed' ? c.green(a.status) : a.status === 'failed' ? c.red(a.status) : c.dim(a.status);
          console.log(`  ${c.dim(`#${a.id}`)} ${a.title} → ${status} ${c.dim(a.executedAt ?? '')}`);
        }
        console.log(divider());
      });
    });

  cmd.command('execute')
    .description('Execute a pending action')
    .argument('<id>', 'Action ID')
    .action(async (id) => {
      await withIpc(async (client) => {
        const result: any = await client.request('action.execute', { id: parseInt(id, 10) });
        if (result.success) {
          console.log(`  ${c.green('Action executed successfully')}`);
        } else {
          console.log(`  ${c.red('Action failed:')} ${result.result}`);
        }
      });
    });

  cmd.command('stats')
    .description('Show action success rates')
    .action(async () => {
      await withIpc(async (client) => {
        const status: any = await client.request('action.status');
        console.log(header('ActionBridge Stats', '📊'));
        console.log(keyValue('Queue Size', String(status.queueSize)));
        console.log(keyValue('Executed (24h)', String(status.executed24h)));
        console.log(keyValue('Success Rate', `${(status.successRate * 100).toFixed(1)}%`));
        console.log(keyValue('Auto-Execute', status.autoExecuteEnabled ? c.green('enabled') : c.dim('disabled')));
        if (status.topSources?.length > 0) {
          console.log(keyValue('Top Sources', status.topSources.map((s: any) => `${s.source}(${s.count})`).join(', ')));
        }
        console.log(divider());
      });
    });

  cmd.action(async () => {
    await cmd.commands.find(c => c.name() === 'queue')!.parseAsync([], { from: 'user' });
  });

  return cmd;
}
