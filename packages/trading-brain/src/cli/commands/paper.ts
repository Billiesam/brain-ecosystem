import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, icons, header, keyValue, divider } from '../colors.js';

export function paperCommand(): Command {
  const cmd = new Command('paper')
    .description('Paper trading status and management')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const status: any = await client.request('paper.status', {});

        console.log(header('Paper Trading', icons.trade));

        const stateLabel = !status.enabled
          ? c.dim('DISABLED')
          : status.paused
            ? c.orange.bold('PAUSED')
            : status.running
              ? c.green.bold('RUNNING')
              : c.red.bold('STOPPED');

        console.log(`  Status: ${stateLabel}`);
        console.log();

        const pnlColor = status.totalPnl >= 0 ? c.green : c.red;
        const pnlSign = status.totalPnl >= 0 ? '+' : '';

        console.log(keyValue('Balance', `$${status.balance.toFixed(2)}`));
        console.log(keyValue('Equity', `$${status.equity.toFixed(2)}`));
        console.log(keyValue('Total P&L', pnlColor(`${pnlSign}$${status.totalPnl.toFixed(2)}`)));
        console.log(keyValue('Win Rate', `${status.winRate}%`));
        console.log(keyValue('Total Trades', String(status.totalTrades)));
        console.log(keyValue('Open Positions', `${status.openPositions} / ${10}`));
        console.log(keyValue('Symbols', String(status.symbols)));
        console.log(keyValue('Cycles', String(status.cycleCount)));
        if (status.lastCycleAt) {
          console.log(keyValue('Last Cycle', status.lastCycleAt));
        }
        console.log(`\n${divider()}`);
      });
    });

  cmd
    .command('portfolio')
    .description('Show open positions')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await client.request('paper.portfolio', {});

        console.log(header('Paper Portfolio', icons.trade));
        console.log(keyValue('Balance', `$${data.balance.toFixed(2)}`));
        console.log(keyValue('Equity', `$${data.equity.toFixed(2)}`));
        console.log();

        if (!data.positions || data.positions.length === 0) {
          console.log(`  ${c.dim('No open positions')}`);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const pos of data.positions as any[]) {
            const pnlColor = pos.pnlPct >= 0 ? c.green : c.red;
            const pnlSign = pos.pnlPct >= 0 ? '+' : '';
            console.log(`  ${c.cyan.bold(pos.symbol)} @ $${pos.entryPrice.toFixed(4)} → $${pos.currentPrice.toFixed(4)}`);
            console.log(`    P&L: ${pnlColor(`${pnlSign}${pos.pnlPct.toFixed(2)}%`)}  |  Size: $${pos.usdtAmount.toFixed(2)}  |  ${c.dim(pos.regime)}`);
            console.log(`    Opened: ${c.dim(pos.openedAt)}  |  Confidence: ${(pos.confidence * 100).toFixed(0)}%`);
            console.log();
          }
        }
        console.log(divider());
      });
    });

  cmd
    .command('history')
    .description('Show closed trades')
    .option('-l, --limit <n>', 'Number of trades', '20')
    .action(async (opts) => {
      await withIpc(async (client) => {
        const limit = parseInt(opts.limit, 10);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const trades: any[] = await client.request('paper.history', { limit }) as any[];

        console.log(header('Paper Trade History', icons.trade));

        if (!trades || trades.length === 0) {
          console.log(`  ${c.dim('No closed trades yet')}`);
        } else {
          for (const t of trades) {
            const win = t.pnlPct > 0;
            const pnlColor = win ? c.green : c.red;
            const label = win ? 'WIN' : 'LOSS';
            const pnlSign = win ? '+' : '';
            console.log(`  ${pnlColor.bold(label)} ${c.cyan(t.symbol)} | ${pnlColor(`${pnlSign}${t.pnlPct.toFixed(2)}%`)} ($${t.pnlUsdt.toFixed(2)}) | ${t.exitReason}`);
            console.log(`    Entry: $${t.entryPrice.toFixed(4)} → Exit: $${t.exitPrice.toFixed(4)} | ${c.dim(t.closedAt.slice(0, 16))}`);
          }
        }
        console.log(`\n${divider()}`);
      });
    });

  cmd
    .command('reset')
    .description('Reset paper trading (clear all positions and trades)')
    .action(async () => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await client.request('paper.reset', {});
        if (result?.success) {
          console.log(`${icons.check}  Paper trading reset. Balance: $${result.balance.toFixed(2)}`);
        } else {
          console.log(`${icons.error}  Reset failed`);
        }
      });
    });

  return cmd;
}
