import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';
import { c, icons, header, divider } from '../colors.js';

export function desiresCommand(): Command {
  const cmd = new Command('desires')
    .description('Show Brain self-improvement desires and wishes')
    .option('-a, --all', 'Show all desires (not just top 5)')
    .option('-f, --feedback', 'Show desire feedback stats (success/failure rates)')
    .action(async (opts) => {
      console.log(header('Brain Desires', icons.brain));
      console.log();

      await withIpc(async (client) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const desires = await client.request('desires.structured', {}) as any[];
        const limit = opts.all ? desires.length : 5;

        if (desires.length === 0) {
          console.log(`  ${c.green('All systems healthy — no improvement desires right now.')}`);
        } else {
          console.log(`  ${c.dim(`${desires.length} desire(s) found, showing top ${Math.min(limit, desires.length)}:`)}`);
          console.log();

          for (const desire of desires.slice(0, limit)) {
            const prio = desire.priority >= 8 ? c.red(`P${desire.priority}`)
              : desire.priority >= 5 ? c.orange(`P${desire.priority}`)
              : c.dim(`P${desire.priority}`);
            console.log(`  ${prio}  ${c.value(desire.suggestion)}`);
            if (desire.alternatives.length > 0) {
              console.log(`       ${c.dim(`Alternative: ${desire.alternatives[0]}`)}`);
            }
          }

          // Also show the text-form suggestions
          const textSuggestions = await client.request('desires.suggestions', {}) as string[];
          if (textSuggestions.length > 0) {
            console.log();
            console.log(`  ${icons.insight}  ${c.cyan.bold('Active Thought-Stream Desires:')}`);
            for (const s of textSuggestions.slice(0, 3)) {
              console.log(`     ${c.dim('→')} ${s.substring(0, 120)}${s.length > 120 ? '...' : ''}`);
            }
          }
        }

        // Feedback stats
        if (opts.feedback) {
          console.log();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fb = await client.request('desires.feedback', {}) as any;
          console.log(`  ${icons.insight}  ${c.cyan.bold('Desire Feedback:')}`);

          if (fb.outcomes?.length > 0) {
            console.log(`    ${c.dim('Outcomes:')}`);
            for (const o of fb.outcomes) {
              const rate = o.successes + o.failures > 0 ? (o.successes / (o.successes + o.failures) * 100).toFixed(0) : '?';
              const color = o.lastResult === 'success' ? c.green : c.red;
              console.log(`      ${color(o.key)}: ${o.successes}S/${o.failures}F (${rate}% success)`);
            }
          } else {
            console.log(`    ${c.dim('No outcomes recorded yet.')}`);
          }

          if (fb.categoryRates?.length > 0) {
            console.log(`    ${c.dim('Category Rates:')}`);
            for (const cr of fb.categoryRates) {
              console.log(`      ${c.value(cr.category)}: ${(cr.successRate * 100).toFixed(0)}% (${cr.total} actions)`);
            }
          }

          if (fb.crossBrainActive?.length > 0) {
            console.log(`    ${c.dim('Cross-Brain Active:')}`);
            for (const cb of fb.crossBrainActive) {
              console.log(`      ${c.value(cb.key)} → ${c.cyan(cb.brain)} (P${cb.priority})`);
            }
          }
        }

        console.log(`\n${divider()}`);
      });
    });

  return cmd;
}
