import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportCommand, renderMarkdown, getReportWarnings, getReportViolations } from '../report.js';

// Mock data matching REAL IPC response shapes

// analytics.summary returns nested objects, not flat numbers
const mockAnalytics = {
  errors: { total: 42, unresolved: 12, last7d: 5 },
  solutions: { total: 15 },
  rules: { active: 8 },
  insights: { active: 23 },
};
const mockDesires = [
  { priority: 9, suggestion: 'Add retry logic to API calls', alternatives: ['Use circuit breaker'] },
  { priority: 5, suggestion: 'Refactor database queries', alternatives: [] },
];
const mockSuggestions = ['Consider caching frequently accessed data', 'Improve error messages'];
const mockPending = [{ id: 7, title: 'Auto-optimize query planner', risk_level: 'medium' }];

// hypothesis.summary may include topConfirmed (Hypothesis[]) alongside scalar counts
const mockHypothesisSummary = {
  confirmed: 3,
  testing: 2,
  proposed: 5,
  topConfirmed: [{ id: 1, statement: 'Caching reduces latency' }],
};

// Confirmed hypotheses use `statement` field, not `hypothesis`
const mockConfirmed = [{ statement: 'Caching reduces latency by 40%', confidence: 0.92 }];

const mockMilestones = [{ title: 'Reached 1000 errors analyzed' }];

// Journal entries have Unix-ms timestamps
const mockJournalEntries = [
  { timestamp: 1710064800000, title: 'Pattern detected in API failures' },
  { timestamp: '2026-03-10T08:00:00Z', title: 'Already ISO string entry' },
];

// predict.summary uses total_predictions and accuracy_rate
const mockPredictSummary = { total_predictions: 50, correct: 35, accuracy_rate: 0.7 };

// predict.accuracy returns PredictionAccuracy[] (array), not a dict
const mockPredictAccuracy = [
  { domain: 'errors', total: 30, correct: 24, accuracy_rate: 0.8 },
  { domain: 'performance', total: 20, correct: 12, accuracy_rate: 0.6 },
];

// transfer.status uses totalTransfers, appliedTransfers, rejectedTransfers, avgEffectiveness
const mockTransferStatus = {
  totalTransfers: 20,
  appliedTransfers: 18,
  rejectedTransfers: 2,
  avgEffectiveness: 0.85,
  recentTransfers: [{ sourceDomain: 'errors', targetDomain: 'trading-brain', itemCount: 5, applied: 4 }],
};
const mockTransferHistory = [{ direction: 'sent', peer: 'trading-brain', itemCount: 5, accepted: 4 }];
const mockBorgStatus = { enabled: true, mode: 'selective', totalSyncs: 10, totalSent: 30, totalReceived: 25 };
const mockExperimentStatus = { running: 1, completed: 5, successful: 3 };
const mockGovernanceStatus = { activeEngines: 12, throttled: 1, isolated: 0 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const routeMap: Record<string, any> = {
  'analytics.summary': mockAnalytics,
  'desires.structured': mockDesires,
  'desires.suggestions': mockSuggestions,
  'selfmod.pending': mockPending,
  'hypothesis.summary': mockHypothesisSummary,
  'hypothesis.list': mockConfirmed,
  'journal.milestones': mockMilestones,
  'journal.entries': mockJournalEntries,
  'predict.summary': mockPredictSummary,
  'predict.accuracy': mockPredictAccuracy,
  'transfer.status': mockTransferStatus,
  'transfer.history': mockTransferHistory,
  'borg.status': mockBorgStatus,
  'autoexperiment.status': mockExperimentStatus,
  'governance.status': mockGovernanceStatus,
};

vi.mock('../../ipc-helper.js', () => ({
  withIpc: vi.fn(async (fn) => {
    const mockClient = {
      request: vi.fn().mockImplementation((method: string) => routeMap[method] ?? null),
    };
    return fn(mockClient);
  }),
}));

describe('renderMarkdown', () => {
  it('renders analytics with nested object shape (Bug 1)', () => {
    const md = renderMarkdown({ analytics: mockAnalytics });
    expect(md).toContain('| Errors | 42 |');
    expect(md).toContain('| Solutions | 15 |');
    expect(md).toContain('| Rules | 8 |');
    expect(md).toContain('| Insights | 23 |');
    expect(md).not.toContain('[object Object]');
  });

  it('renders hypotheses with statement field (Bug 2)', () => {
    const md = renderMarkdown({ confirmedHypotheses: mockConfirmed });
    expect(md).toContain('Caching reduces latency by 40%');
    expect(md).not.toContain('Untitled');
  });

  it('filters non-scalar values from hypothesis summary (Bug 3)', () => {
    const md = renderMarkdown({ hypothesisSummary: mockHypothesisSummary });
    expect(md).toContain('| confirmed | 3 |');
    expect(md).toContain('| testing | 2 |');
    expect(md).not.toContain('topConfirmed');
    expect(md).not.toContain('[object Object]');
  });

  it('renders prediction accuracy as array (Bug 4)', () => {
    const md = renderMarkdown({ predictAccuracy: mockPredictAccuracy });
    expect(md).toContain('| errors |');
    expect(md).toContain('80.0%');
    expect(md).toContain('| performance |');
    expect(md).toContain('60.0%');
    expect(md).not.toContain('[object Object]');
  });

  it('uses correct prediction summary field names (Bug 5)', () => {
    const md = renderMarkdown({ predictSummary: mockPredictSummary });
    expect(md).toContain('Total predictions: 50');
    expect(md).toContain('70.0%');
    expect(md).not.toContain('?');
  });

  it('uses correct transfer status field names (Bug 6)', () => {
    const md = renderMarkdown({ transferStatus: mockTransferStatus });
    expect(md).toContain('Total transfers: 20');
    expect(md).toContain('Applied: 18');
    expect(md).toContain('Rejected: 2');
    expect(md).toContain('85.0%');
  });

  it('converts Unix-ms timestamps to ISO strings (Bug 7)', () => {
    const md = renderMarkdown({ journalEntries: mockJournalEntries });
    // Unix-ms 1710064800000 should become a readable date, not a raw number
    expect(md).not.toMatch(/\[1710064800000\]/);
    expect(md).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(md).toContain('Pattern detected in API failures');
  });

  it('handles all null data gracefully', () => {
    const md = renderMarkdown({});
    expect(md).toContain('## 1. Executive Summary');
    expect(md).toContain('not available');
    expect(md).not.toContain('[object Object]');
  });

  it('logs warnings for unexpected field types', () => {
    // Pass predictAccuracy as object instead of expected array — normalized, not rejected
    renderMarkdown({ predictAccuracy: { errors: 0.8 } });
    const warnings = getReportWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('predict.accuracy');
  });

  it('no warnings for correctly shaped data', () => {
    renderMarkdown({
      analytics: mockAnalytics,
      predictAccuracy: mockPredictAccuracy,
    });
    const warnings = getReportWarnings();
    expect(warnings).toHaveLength(0);
  });

  // --- Normalize-or-Reject ---

  it('rejects analytics with completely wrong shape', () => {
    const md = renderMarkdown({ analytics: 'garbage' });
    // String is not an object — normalizer returns null, but data.analytics is truthy → "unreliable"
    expect(md).not.toContain('| Errors |');
    expect(md).not.toContain('[object Object]');
  });

  it('rejects analytics that has data but no extractable metrics', () => {
    const md = renderMarkdown({ analytics: { foo: 'bar', baz: true } });
    expect(md).toContain('unreliable');
    const violations = getReportViolations();
    expect(violations.some(v => v.source === 'analytics' && v.rejected)).toBe(true);
  });

  it('normalizes predictAccuracy dict shape with warning', () => {
    const md = renderMarkdown({ predictAccuracy: { errors: 0.8 } });
    // Should still render the data (normalized from dict to array)
    expect(md).toContain('| errors |');
    const violations = getReportViolations();
    expect(violations.some(v => v.source === 'predict' && !v.rejected)).toBe(true);
  });

  it('rejects predictSummary with missing total field', () => {
    const md = renderMarkdown({ predictSummary: { foo: 'bar' } });
    expect(md).toContain('unreliable');
    expect(md).not.toContain('Total predictions:');
    const violations = getReportViolations();
    expect(violations.some(v => v.source === 'predict' && v.rejected)).toBe(true);
  });

  it('rejects transferStatus with non-numeric total', () => {
    const md = renderMarkdown({ transferStatus: { totalTransfers: 'many' } });
    expect(md).toContain('unreliable');
    const violations = getReportViolations();
    expect(violations.some(v => v.source === 'transfer' && v.rejected)).toBe(true);
  });

  it('shows Data Quality section with rejected + normalized counts', () => {
    const md = renderMarkdown({
      analytics: { foo: true },           // rejected
      predictAccuracy: { errors: 0.8 },   // normalized
    });
    expect(md).toContain('## Data Quality');
    expect(md).toContain('rejected');
    expect(md).toContain('normalized');
  });
});

describe('reportCommand', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('creates a valid commander command named "report"', () => {
    const cmd = reportCommand();
    expect(cmd.name()).toBe('report');
  });

  it('has --output and --stdout options', () => {
    const cmd = reportCommand();
    const opts = cmd.options.map(o => o.long);
    expect(opts).toContain('--output');
    expect(opts).toContain('--stdout');
  });

  it('renders all 8 sections to stdout', async () => {
    const cmd = reportCommand();
    await cmd.parseAsync(['--stdout'], { from: 'user' });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('## 1. Executive Summary');
    expect(output).toContain('## 2. What Brain Needs From You');
    expect(output).toContain('## 3. Hypotheses');
    expect(output).toContain('## 4. Prediction Accuracy');
    expect(output).toContain('## 5. Research Journal');
    expect(output).toContain('## 6. Cross-Brain Transfers');
    expect(output).toContain('## 7. Auto-Experiments');
    expect(output).toContain('## 8. Governance');
  });

  it('includes desires data sorted by priority', async () => {
    const cmd = reportCommand();
    await cmd.parseAsync(['--stdout'], { from: 'user' });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('**P9**');
    expect(output).toContain('Add retry logic to API calls');
    expect(output).toContain('Alternative: Use circuit breaker');
    const p9Pos = output.indexOf('**P9**');
    const p5Pos = output.indexOf('**P5**');
    expect(p9Pos).toBeLessThan(p5Pos);
  });

  it('stdout output has no [object Object] anywhere', async () => {
    const cmd = reportCommand();
    await cmd.parseAsync(['--stdout'], { from: 'user' });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).not.toContain('[object Object]');
  });

  it('writes file to default path when no --stdout', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const cmd = reportCommand();
    await cmd.parseAsync([], { from: 'user' });

    expect(mkdirSpy).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenPath = writeSpy.mock.calls[0][0] as string;
    expect(writtenPath).toContain('.brain');
    expect(writtenPath).toContain('reports');
    expect(writtenPath).toContain('brain-report-');
    expect(writtenPath).toMatch(/\.md$/);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    existsSpy.mockRestore();
  });

  it('writes file to custom --output path', async () => {
    const customPath = path.join(os.tmpdir(), 'test-brain-report.md');
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const cmd = reportCommand();
    await cmd.parseAsync(['--output', customPath], { from: 'user' });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toBe(customPath);

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
    existsSpy.mockRestore();
  });

  it('shows "not available" when engines return null', async () => {
    const origMap = { ...routeMap };
    for (const key of Object.keys(routeMap)) {
      routeMap[key] = null;
    }

    const cmd = reportCommand();
    await cmd.parseAsync(['--stdout'], { from: 'user' });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('not available');
    expect(output).toContain('## 1.');
    expect(output).toContain('## 8.');

    Object.assign(routeMap, origMap);
  });
});
