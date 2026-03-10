import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Command } from 'commander';
import { withIpc } from '../ipc-helper.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultOutputPath(): string {
  return path.join(os.homedir(), '.brain', 'reports', `brain-report-${today()}.md`);
}

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try { return await p; } catch { return null; }
}

export function renderMarkdown(data: Record<string, Any>): string {
  const lines: string[] = [];
  const ln = (s = '') => lines.push(s);

  // --- Header ---
  ln(`# Brain Report — ${today()}`);
  ln();

  // --- 1. Executive Summary ---
  ln('## 1. Executive Summary');
  ln();
  const a = data.analytics;
  if (a) {
    ln(`| Metric | Count |`);
    ln(`|--------|-------|`);
    ln(`| Errors | ${a.totalErrors ?? a.errors ?? '?'} |`);
    ln(`| Solutions | ${a.totalSolutions ?? a.solutions ?? '?'} |`);
    ln(`| Rules | ${a.totalRules ?? a.rules ?? '?'} |`);
    ln(`| Insights | ${a.totalInsights ?? a.insights ?? '?'} |`);
  } else {
    ln('*Analytics not available.*');
  }
  ln();

  // --- 2. What Brain Needs From You ---
  ln('## 2. What Brain Needs From You');
  ln();

  const desires: Any[] = data.desires ?? [];
  if (desires.length > 0) {
    ln('### Desires (by priority)');
    ln();
    for (const d of desires.sort((a: Any, b: Any) => (b.priority ?? 0) - (a.priority ?? 0))) {
      ln(`- **P${d.priority ?? '?'}** — ${d.suggestion ?? d.description ?? 'No description'}`);
      if (d.alternatives?.length > 0) {
        ln(`  - Alternative: ${d.alternatives[0]}`);
      }
    }
    ln();
  }

  const suggestions: string[] = data.suggestions ?? [];
  if (suggestions.length > 0) {
    ln('### Thought-Stream Suggestions');
    ln();
    for (const s of suggestions) {
      ln(`- ${s}`);
    }
    ln();
  }

  const pending: Any[] = data.pending ?? [];
  if (pending.length > 0) {
    ln('### Pending Self-Modifications');
    ln();
    for (const m of pending) {
      const risk = m.risk_level ? ` [${m.risk_level}]` : '';
      ln(`- **#${m.id}** ${m.title}${risk}`);
    }
    ln();
  }

  if (desires.length === 0 && suggestions.length === 0 && pending.length === 0) {
    ln('*No pending desires, suggestions, or self-modifications.*');
    ln();
  }

  // --- 3. Confirmed Hypotheses ---
  ln('## 3. Hypotheses');
  ln();
  const hSummary = data.hypothesisSummary;
  if (hSummary) {
    ln('### Status Overview');
    ln();
    ln(`| Status | Count |`);
    ln(`|--------|-------|`);
    for (const [status, count] of Object.entries(hSummary)) {
      ln(`| ${status} | ${count} |`);
    }
    ln();
  }

  const confirmed: Any[] = data.confirmedHypotheses ?? [];
  if (confirmed.length > 0) {
    ln('### Confirmed');
    ln();
    for (const h of confirmed) {
      ln(`- **${h.hypothesis ?? h.title ?? 'Untitled'}** (confidence: ${h.confidence ?? '?'})`);
    }
    ln();
  } else if (!hSummary) {
    ln('*Hypothesis engine not available.*');
    ln();
  }

  // --- 4. Prediction Accuracy ---
  ln('## 4. Prediction Accuracy');
  ln();
  const pSummary = data.predictSummary;
  const pAccuracy = data.predictAccuracy;
  if (pSummary) {
    ln(`- Total predictions: ${pSummary.total ?? '?'}`);
    ln(`- Correct: ${pSummary.correct ?? '?'}`);
    ln(`- Accuracy: ${pSummary.accuracy != null ? (pSummary.accuracy * 100).toFixed(1) + '%' : '?'}`);
    ln();
  }
  if (pAccuracy && typeof pAccuracy === 'object') {
    const domains = Object.entries(pAccuracy);
    if (domains.length > 0) {
      ln('### By Domain');
      ln();
      ln(`| Domain | Accuracy |`);
      ln(`|--------|----------|`);
      for (const [domain, acc] of domains) {
        const val = typeof acc === 'number' ? (acc * 100).toFixed(1) + '%' : String(acc);
        ln(`| ${domain} | ${val} |`);
      }
      ln();
    }
  }
  if (!pSummary && !pAccuracy) {
    ln('*Prediction engine not available.*');
    ln();
  }

  // --- 5. Research Journal ---
  ln('## 5. Research Journal');
  ln();
  const milestones: Any[] = data.milestones ?? [];
  if (milestones.length > 0) {
    ln('### Milestones');
    ln();
    for (const m of milestones.slice(0, 10)) {
      ln(`- ${m.title ?? m.description ?? m.content ?? JSON.stringify(m)}`);
    }
    ln();
  }

  const entries: Any[] = data.journalEntries ?? [];
  if (entries.length > 0) {
    ln('### Recent Entries');
    ln();
    for (const e of entries.slice(0, 10)) {
      const ts = e.timestamp ?? e.created_at ?? '';
      const text = e.title ?? e.content ?? e.description ?? JSON.stringify(e);
      ln(`- ${ts ? `[${ts}] ` : ''}${text}`);
    }
    ln();
  }

  if (milestones.length === 0 && entries.length === 0) {
    ln('*No journal entries available.*');
    ln();
  }

  // --- 6. Cross-Brain Transfers ---
  ln('## 6. Cross-Brain Transfers');
  ln();
  const tStatus = data.transferStatus;
  if (tStatus) {
    ln(`- Total transfers: ${tStatus.total ?? '?'}`);
    ln(`- Successful: ${tStatus.successful ?? '?'}`);
    ln(`- Failed: ${tStatus.failed ?? '?'}`);
    ln();
  }

  const tHistory: Any[] = data.transferHistory ?? [];
  if (tHistory.length > 0) {
    ln('### Recent Transfers');
    ln();
    for (const t of tHistory.slice(0, 10)) {
      const dir = t.direction ?? '?';
      const peer = t.peer ?? t.target ?? '?';
      ln(`- ${dir} ↔ ${peer}: ${t.itemCount ?? t.count ?? '?'} items (accepted: ${t.accepted ?? '?'})`);
    }
    ln();
  }

  const borgStatus = data.borgStatus;
  if (borgStatus) {
    ln('### BorgSync');
    ln();
    ln(`- Enabled: ${borgStatus.enabled ?? false}`);
    ln(`- Mode: ${borgStatus.mode ?? '?'}`);
    ln(`- Total syncs: ${borgStatus.totalSyncs ?? 0}`);
    ln(`- Sent: ${borgStatus.totalSent ?? 0}, Received: ${borgStatus.totalReceived ?? 0}`);
    ln();
  }

  if (!tStatus && tHistory.length === 0 && !borgStatus) {
    ln('*Transfer data not available.*');
    ln();
  }

  // --- 7. Auto-Experiments ---
  ln('## 7. Auto-Experiments');
  ln();
  const expStatus = data.experimentStatus;
  if (expStatus) {
    ln(`- Running: ${expStatus.running ?? 0}`);
    ln(`- Completed: ${expStatus.completed ?? 0}`);
    ln(`- Successful: ${expStatus.successful ?? 0}`);
  } else {
    ln('*Auto-experiment engine not available.*');
  }
  ln();

  // --- 8. Governance ---
  ln('## 8. Governance');
  ln();
  const gov = data.governanceStatus;
  if (gov) {
    if (gov.engines && Array.isArray(gov.engines)) {
      ln(`| Engine | Status | Throttle |`);
      ln(`|--------|--------|----------|`);
      for (const e of gov.engines) {
        ln(`| ${e.name ?? e.id ?? '?'} | ${e.status ?? '?'} | ${e.throttled ? 'YES' : 'no'} |`);
      }
    } else {
      ln(`- Active engines: ${gov.activeEngines ?? gov.total ?? '?'}`);
      ln(`- Throttled: ${gov.throttled ?? 0}`);
      ln(`- Isolated: ${gov.isolated ?? 0}`);
    }
  } else {
    ln('*Governance not available.*');
  }
  ln();

  ln('---');
  ln(`*Generated by \`brain report\` at ${new Date().toISOString()}*`);

  return lines.join('\n');
}

export function reportCommand(): Command {
  const cmd = new Command('report')
    .description('Generate a Brain briefing report (Markdown)')
    .option('-o, --output <file>', 'Output file path')
    .option('--stdout', 'Print to terminal instead of file')
    .action(async (opts) => {
      await withIpc(async (client) => {
        // Gather all data in parallel with safe() wrapper
        const [
          analytics,
          desires,
          suggestions,
          pending,
          hypothesisSummary,
          confirmedHypotheses,
          milestones,
          journalEntries,
          predictSummary,
          predictAccuracy,
          transferStatus,
          transferHistory,
          borgStatus,
          experimentStatus,
          governanceStatus,
        ] = await Promise.all([
          safe(client.request('analytics.summary', {})),
          safe(client.request('desires.structured', {})),
          safe(client.request('desires.suggestions', {})),
          safe(client.request('selfmod.pending', {})),
          safe(client.request('hypothesis.summary', {})),
          safe(client.request('hypothesis.list', { status: 'confirmed' })),
          safe(client.request('journal.milestones', {})),
          safe(client.request('journal.entries', {})),
          safe(client.request('predict.summary', {})),
          safe(client.request('predict.accuracy', {})),
          safe(client.request('transfer.status', {})),
          safe(client.request('transfer.history', {})),
          safe(client.request('borg.status', {})),
          safe(client.request('autoexperiment.status', {})),
          safe(client.request('governance.status', {})),
        ]);

        const data = {
          analytics,
          desires,
          suggestions,
          pending,
          hypothesisSummary,
          confirmedHypotheses,
          milestones,
          journalEntries,
          predictSummary,
          predictAccuracy,
          transferStatus,
          transferHistory,
          borgStatus,
          experimentStatus,
          governanceStatus,
        };

        const markdown = renderMarkdown(data);

        if (opts.stdout) {
          console.log(markdown);
          return;
        }

        const outputPath = opts.output ?? defaultOutputPath();
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(outputPath, markdown, 'utf8');
        console.log(`Report written to ${outputPath}`);
      });
    });

  return cmd;
}
