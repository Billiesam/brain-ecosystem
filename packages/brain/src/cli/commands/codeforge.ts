import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider } from '../colors.js';

export function codeforgeCommand(): Command {
  const cmd = new Command('codeforge')
    .description('CodeForge — pattern extraction, code generation & auto-apply');

  cmd.command('patterns')
    .description('Show extracted code patterns')
    .action(async () => {
      await withIpc(async (client) => {
        const patterns: any[] = await client.request('codeforge.patterns') as any[];
        console.log(header(`Code Patterns (${patterns.length})`, '🔍'));
        for (const p of patterns) {
          console.log(`  ${c.dim(`#${p.id}`)} ${p.pattern} — ${p.occurrences} occurrences, similarity=${c.value((p.similarity * 100).toFixed(0) + '%')}`);
        }
        console.log(divider());
      });
    });

  cmd.command('products')
    .description('Show code products')
    .option('--status <status>', 'Filter by status (generated, tested, applied, failed)')
    .action(async (opts) => {
      await withIpc(async (client) => {
        const products: any[] = await client.request('codeforge.products', { status: opts.status }) as any[];
        console.log(header(`Code Products (${products.length})`, '📦'));
        for (const p of products) {
          const status = p.status === 'applied' ? c.green(p.status) : p.status === 'failed' ? c.red(p.status) : c.dim(p.status);
          console.log(`  ${c.dim(`#${p.id}`)} ${p.name} (${p.type}) — ${status} ${p.files?.length ?? 0} files`);
        }
        console.log(divider());
      });
    });

  cmd.command('apply')
    .description('Apply a code product')
    .argument('<id>', 'Product ID')
    .action(async (id) => {
      await withIpc(async (client) => {
        const result: any = await client.request('codeforge.apply', { id: parseInt(id, 10) });
        if (result.success) {
          console.log(`  ${c.green('Product applied successfully')}`);
        } else {
          console.log(`  ${c.red('Apply failed')}`);
        }
      });
    });

  cmd.command('status')
    .description('Show CodeForge status')
    .action(async () => {
      await withIpc(async (client) => {
        const status: any = await client.request('codeforge.status');
        console.log(header('CodeForge Status', '🔧'));
        console.log(keyValue('Patterns', String(status.patterns)));
        console.log(keyValue('Products', String(status.products)));
        console.log(keyValue('Applied', String(status.applied)));
        console.log(keyValue('Success Rate', `${(status.successRate * 100).toFixed(1)}%`));
        console.log(divider());
      });
    });

  cmd.action(async () => {
    await cmd.commands.find(c => c.name() === 'status')!.parseAsync([], { from: 'user' });
  });

  return cmd;
}
