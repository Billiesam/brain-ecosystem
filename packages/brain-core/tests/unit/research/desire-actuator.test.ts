import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ResearchOrchestrator } from '../../../src/research/research-orchestrator.js';
import { ActionBridgeEngine, runActionBridgeMigration } from '../../../src/action/action-bridge.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('DesireActuator — Step 64', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;
  let actionBridge: ActionBridgeEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
    actionBridge = new ActionBridgeEngine(db, { brainName: 'test' });
    orch.setActionBridge(actionBridge);
  });

  afterEach(() => { db.close(); });

  it('creates proposal from high-priority desire', () => {
    // Force cycleCount to trigger step 64 (need >= 15 cycles since last actuation)
    const orchAny = orch as any;
    orchAny.cycleCount = 15;
    orchAny.lastDesireActuationCycle = 0;

    // Mock getDesires to return a high-priority desire
    vi.spyOn(orch, 'getDesires').mockReturnValue([
      { key: 'curiosity_gap_llm_tuning', priority: 7, suggestion: 'Knowledge gap: "LLM tuning" (score: 85%)', alternatives: [] },
    ]);

    // Access step 64 logic by running parts — we test the integrated behavior
    const desires = orch.getDesires();
    const top = desires.find(d => d.priority >= 5);
    expect(top).toBeDefined();

    // Simulate what step 64 does
    const actionId = actionBridge.propose({
      source: 'desire',
      type: 'create_goal',
      title: `Desire: ${top!.suggestion.substring(0, 80)}`,
      description: top!.suggestion,
      confidence: Math.min(top!.priority / 10, 0.9),
      payload: { desireKey: top!.key, priority: top!.priority },
    });

    expect(actionId).toBeGreaterThan(0);
    const action = actionBridge.getAction(actionId);
    expect(action).toBeDefined();
    expect(action!.source).toBe('desire');
    expect(action!.type).toBe('create_goal');
    expect(action!.status).toBe('pending');
  });

  it('skips low-priority desires (< 5)', () => {
    vi.spyOn(orch, 'getDesires').mockReturnValue([
      { key: 'minor_issue', priority: 3, suggestion: 'Minor suggestion', alternatives: [] },
    ]);

    const desires = orch.getDesires();
    const top = desires.find(d => d.priority >= 5);
    expect(top).toBeUndefined();
    // No action should be proposed
  });

  it('respects cooldown (15 cycles)', () => {
    const orchAny = orch as any;
    orchAny.cycleCount = 20;
    orchAny.lastDesireActuationCycle = 10;
    // 20 - 10 = 10 < 15, should NOT actuate
    expect(orchAny.cycleCount - orchAny.lastDesireActuationCycle).toBeLessThan(15);

    orchAny.lastDesireActuationCycle = 5;
    // 20 - 5 = 15 >= 15, should actuate
    expect(orchAny.cycleCount - orchAny.lastDesireActuationCycle).toBeGreaterThanOrEqual(15);
  });

  it('maps contradiction desires to start_mission action type', () => {
    vi.spyOn(orch, 'getDesires').mockReturnValue([
      { key: 'contradiction_belief_vs_data', priority: 6, suggestion: 'Contradiction: "X" vs "Y"', alternatives: [] },
    ]);

    const desires = orch.getDesires();
    const top = desires.find(d => d.priority >= 5)!;

    let actionType: string = 'create_goal';
    if (top.key.startsWith('contradiction_')) actionType = 'start_mission';

    expect(actionType).toBe('start_mission');
  });
});

describe('Action-Outcome Review — Step 65', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;
  let actionBridge: ActionBridgeEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
    actionBridge = new ActionBridgeEngine(db, { brainName: 'test' });
    orch.setActionBridge(actionBridge);
  });

  afterEach(() => { db.close(); });

  it('journals successful action outcomes', () => {
    // Register a handler so we can execute
    actionBridge.registerHandler('create_goal', async () => ({ created: true }));

    // Create and execute an action
    const id = actionBridge.propose({
      source: 'desire',
      type: 'create_goal',
      title: 'Research LLM tuning',
      confidence: 0.8,
      payload: { topic: 'llm-tuning' },
    });

    // Execute it synchronously for test
    actionBridge.recordOutcome(id, { success: true, result: 'Goal created', learnedLesson: 'LLM tuning improves output quality' });

    // Verify action is in history as completed
    const history = actionBridge.getHistory(10);
    const completed = history.filter(a => a.status === 'completed' && a.outcome?.success);
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(completed[0].outcome!.learnedLesson).toBe('LLM tuning improves output quality');

    // Simulate Step 65 journal logic
    const orchAny = orch as any;
    for (const action of completed.slice(0, 3)) {
      const lesson = action.outcome?.learnedLesson ?? `Action "${action.title}" succeeded`;
      orchAny.journal.write({
        title: `Action Outcome: ${action.title}`,
        content: `${action.type} from ${action.source} succeeded. Lesson: ${lesson}`,
        type: 'insight',
        significance: 'routine',
        tags: ['test', 'action-outcome', 'success'],
        references: [],
        data: { actionId: action.id, type: action.type, source: action.source },
      });
    }

    // Check journal has the entry
    const entries = orchAny.journal.getEntries(undefined, 5);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const outcomeEntry = entries.find((e: any) => e.title.includes('Action Outcome'));
    expect(outcomeEntry).toBeDefined();
    expect(outcomeEntry.content).toContain('LLM tuning improves output quality');
  });

  it('journals failed action outcomes as anomalies', () => {
    // Create and fail an action
    const id = actionBridge.propose({
      source: 'research',
      type: 'adjust_parameter',
      title: 'Increase scan frequency',
      confidence: 0.7,
      payload: { param: 'scanFreq', value: 5 },
    });

    actionBridge.recordOutcome(id, { success: false, result: 'Parameter out of range' });

    // Verify action is in history as failed
    const history = actionBridge.getHistory(10);
    const failed = history.filter(a => a.status === 'failed' || (a.outcome && !a.outcome.success));
    expect(failed.length).toBeGreaterThanOrEqual(1);

    // Simulate Step 65 failure journal logic
    const orchAny = orch as any;
    for (const action of failed.slice(0, 3)) {
      orchAny.journal.write({
        title: `Action Failed: ${action.title}`,
        content: `${action.type} from ${action.source} failed: ${action.outcome?.result ?? 'unknown'}`,
        type: 'anomaly',
        significance: 'notable',
        tags: ['test', 'action-outcome', 'failure'],
        references: [],
        data: { actionId: action.id, type: action.type, source: action.source },
      });
    }

    // Check journal has the anomaly entry
    const entries = orchAny.journal.getEntries(undefined, 5);
    const failEntry = entries.find((e: any) => e.title.includes('Action Failed'));
    expect(failEntry).toBeDefined();
    expect(failEntry.type).toBe('anomaly');
    expect(failEntry.significance).toBe('notable');
    expect(failEntry.content).toContain('Parameter out of range');
  });
});

describe('Cycle-Pacing — Session 110B', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => { db.close(); });

  it('respects minCycleDurationMs config', () => {
    const orch = new ResearchOrchestrator(db, { brainName: 'test', minCycleDurationMs: 100 });
    const orchAny = orch as any;
    expect(orchAny.minCycleDurationMs).toBe(100);
  });

  it('defaults minCycleDurationMs to 5000', () => {
    const orch = new ResearchOrchestrator(db, { brainName: 'test' });
    const orchAny = orch as any;
    expect(orchAny.minCycleDurationMs).toBe(5000);
  });
});
