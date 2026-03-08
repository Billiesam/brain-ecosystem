import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, header, keyValue, divider } from '../colors.js';

export function contentCommand(): Command {
  const cmd = new Command('content')
    .description('ContentForge — autonomous content generation & publishing');

  cmd.command('generate')
    .description('Generate content from a source')
    .argument('<sourceType>', 'Source type: insight, mission, trend, principle')
    .option('--platform <platform>', 'Target platform', 'bluesky')
    .action(async (sourceType, opts) => {
      await withIpc(async (client) => {
        const result: any = await client.request('content.generate', { sourceType, insight: 'Generated via CLI', noveltyScore: 0.5, platform: opts.platform });
        console.log(`  ${c.green('Content generated')} — #${result.id}: ${result.title}`);
      });
    });

  cmd.command('publish')
    .description('Publish a content piece')
    .argument('<id>', 'Content piece ID')
    .action(async (id) => {
      await withIpc(async (client) => {
        const result: any = await client.request('content.publish', { id: parseInt(id, 10) });
        if (result.success) {
          console.log(`  ${c.green('Published')} — post ID: ${result.postId ?? '?'}`);
        } else {
          console.log(`  ${c.red('Publish failed')}`);
        }
      });
    });

  cmd.command('schedule')
    .description('Show scheduled content')
    .action(async () => {
      await withIpc(async (client) => {
        const schedule: any[] = await client.request('content.list') as any[];
        console.log(header(`Scheduled Content (${schedule.length})`, '📅'));
        for (const p of schedule) {
          console.log(`  ${c.dim(`#${p.id}`)} ${p.title} → ${c.value(p.platform)} ${c.dim(p.scheduledFor ?? 'no time')}`);
        }
        console.log(divider());
      });
    });

  cmd.command('best')
    .description('Show best performing content')
    .option('-n, --limit <n>', 'Number of entries', '10')
    .action(async (opts) => {
      await withIpc(async (client) => {
        const best: any[] = await client.request('content.best', { limit: parseInt(opts.limit, 10) }) as any[];
        console.log(header(`Top Content (${best.length})`, '🏆'));
        for (const p of best) {
          const eng = p.engagement ? `likes=${p.engagement.likes} reposts=${p.engagement.reposts} replies=${p.engagement.replies}` : 'no data';
          console.log(`  ${c.dim(`#${p.id}`)} ${p.title} — ${c.value(eng)}`);
        }
        console.log(divider());
      });
    });

  cmd.action(async () => {
    await withIpc(async (client) => {
      const status: any = await client.request('content.status');
      console.log(header('ContentForge Status', '✍️'));
      console.log(keyValue('Drafts', String(status.drafts)));
      console.log(keyValue('Scheduled', String(status.scheduled)));
      console.log(keyValue('Published', String(status.published)));
      console.log(keyValue('Avg Engagement', status.avgEngagement.toFixed(1)));
      console.log(divider());
    });
  });

  return cmd;
}
