import { Command } from 'commander';
import fs from 'node:fs';
import { withIpc } from '../ipc-helper.js';
import { c, icons, header } from '../colors.js';

export function strategyCommand(): Command {
  const cmd = new Command('strategy')
    .description('Strategy management (export/import)');

  cmd
    .command('export <id>')
    .description('Export a strategy as JSON')
    .option('-f, --file <path>', 'Output file path')
    .action(async (id: string, opts) => {
      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await client.request('strategy.export', { id: parseInt(id, 10) });
        const json = JSON.stringify(result, null, 2);

        if (opts.file) {
          fs.writeFileSync(opts.file, json);
          console.log(`${icons.ok}  ${c.green(`Strategy exported to ${opts.file}`)}`);
        } else {
          console.log(json);
        }
      });
    });

  cmd
    .command('import <file>')
    .description('Import a strategy from JSON file')
    .action(async (file: string) => {
      await withIpc(async (client) => {
        if (!fs.existsSync(file)) {
          console.error(`${icons.error}  File not found: ${file}`);
          process.exit(1);
        }

        const json = fs.readFileSync(file, 'utf-8');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result: any = await client.request('strategy.import', { json });

        if (!result.success) {
          console.error(`${icons.error}  Import failed: ${result.error}`);
          process.exit(1);
        }

        console.log(header('Strategy Imported', icons.ok));
        console.log(`  Name: ${c.green(result.strategyName)}`);
        console.log(`  ID:   ${c.cyan(String(result.strategyId))}`);
        console.log(`  Status: ${c.dim('draft')}`);
        console.log();
        console.log(c.dim(`  Tip: Run 'trading backtest strategy ${result.strategyId}' to validate`));
      });
    });

  return cmd;
}
