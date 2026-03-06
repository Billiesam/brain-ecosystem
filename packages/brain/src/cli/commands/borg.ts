import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider } from '../colors.js';

export function borgCommand(): Command {
  const cmd = new Command('borg')
    .description('Borg Mode — collective knowledge sync between brains');

  cmd.command('status')
    .description('Show Borg sync status')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status: any = await client.request('borg.status');

        console.log(header('Borg Sync Status', '\u{1F916}'));
        console.log(keyValue('Enabled', status.enabled ? c.green('yes') : c.dim('no')));
        console.log(keyValue('Mode', c.value(status.mode ?? '-')));
        console.log(keyValue('Sync Interval', `${(status.syncIntervalMs ?? 60000) / 1000}s`));
        console.log(keyValue('Total Syncs', String(status.totalSyncs ?? 0)));
        console.log(keyValue('Items Sent', String(status.totalSent ?? 0)));
        console.log(keyValue('Items Received', String(status.totalReceived ?? 0)));
        console.log(keyValue('Last Sync', status.lastSync ? new Date(status.lastSync).toLocaleString() : c.dim('never')));
        console.log(divider());

        if (!status.enabled) {
          console.log(`  ${c.dim('Borg mode is disabled. Enable with: brain borg enable')}`);
        }
      });
    });

  cmd.command('enable')
    .description('Enable Borg sync')
    .action(async () => {
      await withIpc(async (client) => {
        await client.request('borg.enable');
        console.log(`  ${c.green('Borg mode enabled')} — collective sync started`);
      });
    });

  cmd.command('disable')
    .description('Disable Borg sync')
    .action(async () => {
      await withIpc(async (client) => {
        await client.request('borg.disable');
        console.log(`  ${c.dim('Borg mode disabled')}`);
      });
    });

  cmd.command('sync')
    .description('Trigger manual sync cycle')
    .action(async () => {
      await withIpc(async (client) => {
        await client.request('borg.sync');
        console.log(`  ${c.green('Sync cycle completed')}`);
      });
    });

  cmd.command('history')
    .description('Show recent sync history')
    .option('-n, --limit <n>', 'Number of entries', '20')
    .action(async (opts) => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const history: any[] = await client.request('borg.history', { limit: parseInt(opts.limit, 10) }) as any[];

        if (!history?.length) {
          console.log(`  ${c.dim('No sync history yet.')}`);
          return;
        }

        console.log(header(`${history.length} Sync Entries`, '\u{1F504}'));
        for (const h of history) {
          const dir = h.direction === 'sent' ? c.cyan('\u{2191} sent') : c.green('\u{2193} recv');
          const time = new Date(h.timestamp).toLocaleTimeString();
          console.log(`  ${c.dim(time)}  ${dir}  ${c.value(h.peer.padEnd(20))}  ${h.accepted}/${h.itemCount} accepted`);
        }
        console.log(divider());
      });
    });

  // Default action: status
  cmd.action(async () => {
    await cmd.commands.find(c => c.name() === 'status')!.parseAsync([], { from: 'user' });
  });

  return cmd;
}
