import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, icons, header, keyValue } from '../colors.js';

export function backtestCommand(): Command {
  const cmd = new Command('backtest')
    .description('Run backtests on historical data');

  cmd
    .command('strategy <id>')
    .description('Backtest a StrategyForge strategy on historical OHLCV data')
    .option('-p, --pair <pair>', 'Trading pair', 'BTC/USDT')
    .option('-d, --days <n>', 'Days of history', '30')
    .action(async (id: string, opts) => {
      await withIpc(async (client) => {
        console.log(header('Strategy Backtest', icons.chart));
        console.log(c.dim(`  Testing strategy #${id} on ${opts.pair} (${opts.days}d)...\n`));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await client.request('backtest.strategy', {
          strategyId: parseInt(id, 10),
          pair: opts.pair,
          days: parseInt(opts.days, 10),
        });

        if (result.totalTrades === 0) {
          console.log(c.orange(`  ${icons.warn} No trades generated. Strategy rules may not match the data.`));
          return;
        }

        const winColor = result.winRate >= 0.5 ? c.green : c.red;
        const returnColor = result.totalReturnPct >= 0 ? c.green : c.red;

        console.log(keyValue('Strategy', result.strategyName));
        console.log(keyValue('Pair', result.pair));
        console.log(keyValue('Period', `${result.days} days`));
        console.log(keyValue('Total Trades', String(result.totalTrades)));
        console.log(keyValue('Win Rate', winColor(`${(result.winRate * 100).toFixed(1)}% (${result.wins}W / ${result.losses}L)`)));
        console.log(keyValue('Total Return', returnColor(`${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}%`)));
        console.log(keyValue('Avg Return', `${result.avgReturnPct.toFixed(2)}%`));
        console.log(keyValue('Max Drawdown', c.red(`${result.maxDrawdownPct.toFixed(2)}%`)));
        console.log(keyValue('Profit Factor', result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)));
        console.log(keyValue('Sharpe Ratio', result.sharpeRatio.toFixed(2)));
      });
    });

  return cmd;
}
