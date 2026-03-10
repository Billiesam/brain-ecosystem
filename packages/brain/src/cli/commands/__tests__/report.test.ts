import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportCommand } from '../report.js';

// Mock data for IPC responses
const mockAnalytics = { totalErrors: 42, totalSolutions: 15, totalRules: 8, totalInsights: 23 };
const mockDesires = [
  { priority: 9, suggestion: 'Add retry logic to API calls', alternatives: ['Use circuit breaker'] },
  { priority: 5, suggestion: 'Refactor database queries', alternatives: [] },
];
const mockSuggestions = ['Consider caching frequently accessed data', 'Improve error messages'];
const mockPending = [{ id: 7, title: 'Auto-optimize query planner', risk_level: 'medium' }];
const mockHypothesisSummary = { confirmed: 3, testing: 2, proposed: 5 };
const mockConfirmed = [{ hypothesis: 'Caching reduces latency by 40%', confidence: 0.92 }];
const mockMilestones = [{ title: 'Reached 1000 errors analyzed' }];
const mockJournalEntries = [{ timestamp: '2026-03-10T08:00:00Z', title: 'Pattern detected in API failures' }];
const mockPredictSummary = { total: 50, correct: 35, accuracy: 0.7 };
const mockPredictAccuracy = { errors: 0.8, performance: 0.6 };
const mockTransferStatus = { total: 20, successful: 18, failed: 2 };
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
    // P9 should appear before P5
    const p9Pos = output.indexOf('**P9**');
    const p5Pos = output.indexOf('**P5**');
    expect(p9Pos).toBeLessThan(p5Pos);
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
    // Override all routes to return null (simulating unavailable engines)
    const origMap = { ...routeMap };
    for (const key of Object.keys(routeMap)) {
      routeMap[key] = null;
    }

    const cmd = reportCommand();
    await cmd.parseAsync(['--stdout'], { from: 'user' });

    const output = logSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('not available');
    // All 8 section headers should still be present
    expect(output).toContain('## 1.');
    expect(output).toContain('## 8.');

    // Restore
    Object.assign(routeMap, origMap);
  });
});
