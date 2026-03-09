import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider } from '../colors.js';

export function governanceCommand(): Command {
  const cmd = new Command('governance')
    .description('Engine Governance — registry, loop detection, throttle/cooldown/isolate/restore');

  cmd.command('status')
    .description('Show governance overview')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const registry: any = await client.request('governance.status');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const loops: any = await client.request('governance.loop_status');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gov: any = await client.request('governance.layer_status');

        console.log(header('Engine Governance', '\u2696\uFE0F'));
        console.log(keyValue('Total Engines', String(registry?.totalEngines ?? '?')));
        console.log(keyValue('Enabled', String(registry?.enabledEngines ?? '?')));
        console.log(keyValue('Active Loops', loops?.activeDetections > 0
          ? c.orange(String(loops.activeDetections))
          : c.green('0')));
        console.log(keyValue('Gov Actions', String(gov?.activeActions ?? 0)));

        if (gov?.throttledEngines?.length) {
          console.log(keyValue('Throttled', c.orange(gov.throttledEngines.join(', '))));
        }
        if (gov?.isolatedEngines?.length) {
          console.log(keyValue('Isolated', c.red(gov.isolatedEngines.join(', '))));
        }
        console.log(divider());
      });
    });

  cmd.command('actions')
    .description('Show governance action history')
    .option('-l, --limit <n>', 'Number of actions to show', '20')
    .action(async (opts) => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const actions: any = await client.request('governance.actions', { limit: parseInt(opts.limit, 10) });
        console.log(header('Governance Actions', '\u{1F4CB}'));
        if (!actions?.length) {
          console.log(`  ${c.dim('No governance actions recorded')}`);
        } else {
          for (const a of actions) {
            const typeColor = a.actionType === 'isolate' ? c.red
              : a.actionType === 'throttle' ? c.orange
              : a.actionType === 'restore' ? c.green : c.cyan;
            console.log(`  ${typeColor(a.actionType.padEnd(10))} ${c.cyan(a.engine?.padEnd(25) ?? '?')} ${c.dim(a.reason || '')}`);
          }
        }
        console.log(divider());
      });
    });

  cmd.command('throttle')
    .description('Throttle an engine (runs every other cycle)')
    .argument('<engine>', 'Engine ID to throttle')
    .argument('[reason]', 'Reason for throttle', 'manual CLI throttle')
    .action(async (engine, reason) => {
      await withIpc(async (client) => {
        await client.request('governance.throttle', { engine, reason });
        console.log(`  ${c.orange('Throttled')} ${c.cyan(engine)}: ${reason}`);
      });
    });

  cmd.command('cooldown')
    .description('Cooldown an engine for N cycles')
    .argument('<engine>', 'Engine ID to cooldown')
    .option('-c, --cycles <n>', 'Cooldown duration in cycles', '20')
    .option('-r, --reason <text>', 'Reason', 'manual CLI cooldown')
    .action(async (engine, opts) => {
      await withIpc(async (client) => {
        await client.request('governance.cooldown', { engine, reason: opts.reason, cycles: parseInt(opts.cycles, 10) });
        console.log(`  ${c.orange('Cooled down')} ${c.cyan(engine)} for ${opts.cycles} cycles: ${opts.reason}`);
      });
    });

  cmd.command('isolate')
    .description('Isolate an engine (manual restore required)')
    .argument('<engine>', 'Engine ID to isolate')
    .argument('[reason]', 'Reason for isolation', 'manual CLI isolation')
    .action(async (engine, reason) => {
      await withIpc(async (client) => {
        await client.request('governance.isolate', { engine, reason });
        console.log(`  ${c.red('Isolated')} ${c.cyan(engine)}: ${reason}`);
      });
    });

  cmd.command('restore')
    .description('Restore an engine (clear all active governance actions)')
    .argument('<engine>', 'Engine ID to restore')
    .argument('[reason]', 'Reason for restore', 'manual CLI restore')
    .action(async (engine, reason) => {
      await withIpc(async (client) => {
        await client.request('governance.restore', { engine, reason });
        console.log(`  ${c.green('Restored')} ${c.cyan(engine)}: ${reason}`);
      });
    });

  // Default action: status
  cmd.action(async () => {
    await cmd.commands.find(c => c.name() === 'status')!.parseAsync([], { from: 'user' });
  });

  return cmd;
}
