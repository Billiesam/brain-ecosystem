import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ActionBridgeEngine, runActionBridgeMigration } from '../action-bridge.js';

describe('ActionBridgeEngine', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('proposes an action and retrieves it', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    const id = engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Increase learning rate', confidence: 0.8 });
    expect(id).toBeGreaterThan(0);

    const queue = engine.getQueue('pending');
    expect(queue).toHaveLength(1);
    expect(queue[0].title).toBe('Increase learning rate');
    expect(queue[0].riskLevel).toBe('low');
  });

  it('evaluates risk correctly for each type', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    expect(engine.evaluateRisk('adjust_parameter')).toBe('low');
    expect(engine.evaluateRisk('create_goal')).toBe('low');
    expect(engine.evaluateRisk('start_mission')).toBe('low');
    expect(engine.evaluateRisk('publish_content')).toBe('medium');
    expect(engine.evaluateRisk('execute_trade')).toBe('medium');
    expect(engine.evaluateRisk('apply_code')).toBe('high');
  });

  it('auto-executes qualifying low-risk actions', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    const handler = vi.fn().mockResolvedValue({ adjusted: true });
    engine.registerHandler('adjust_parameter', handler);

    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Auto test', confidence: 0.8 });
    const executed = await engine.processQueue();
    expect(executed).toBe(1);
    expect(handler).toHaveBeenCalled();

    const history = engine.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('completed');
  });

  it('does not auto-execute when confidence too low', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('adjust_parameter', vi.fn());

    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Low conf', confidence: 0.3 });
    const executed = await engine.processQueue();
    expect(executed).toBe(0);
  });

  it('does not auto-execute apply_code (always high risk)', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('apply_code', vi.fn());

    engine.propose({ source: 'codegen', type: 'apply_code', title: 'Refactor', confidence: 0.99 });
    const executed = await engine.processQueue();
    expect(executed).toBe(0); // never auto for apply_code
  });

  it('executes action manually', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('publish_content', vi.fn().mockResolvedValue({ published: true }));

    const id = engine.propose({ source: 'creative', type: 'publish_content', title: 'Post insight', confidence: 0.5 });
    const result = await engine.executeAction(id);
    expect(result.success).toBe(true);
  });

  it('records failed execution', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('publish_content', vi.fn().mockRejectedValue(new Error('API down')));

    const id = engine.propose({ source: 'creative', type: 'publish_content', title: 'Fail test', confidence: 0.9 });
    const result = await engine.executeAction(id);
    expect(result.success).toBe(false);

    const action = engine.getAction(id);
    expect(action?.status).toBe('failed');
  });

  it('returns error when no handler registered', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    const id = engine.propose({ source: 'proactive', type: 'start_mission', title: 'No handler', confidence: 0.9 });

    const result = await engine.executeAction(id);
    expect(result.success).toBe(false);
    expect(result.result).toBe('No handler registered');
  });

  it('rolls back a completed action', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('adjust_parameter', vi.fn().mockResolvedValue({}));

    const id = engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Rollback test', confidence: 0.9 });
    await engine.executeAction(id);

    engine.rollback(id);
    const action = engine.getAction(id);
    expect(action?.status).toBe('rolled_back');
  });

  it('cannot rollback a pending action', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    const id = engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'No rollback', confidence: 0.5 });
    expect(() => engine.rollback(id)).toThrow('cannot be rolled back');
  });

  it('tracks success rate', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('adjust_parameter', vi.fn().mockResolvedValue({}));
    engine.registerHandler('create_goal', vi.fn().mockRejectedValue(new Error('fail')));

    const id1 = engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Success', confidence: 0.9 });
    const id2 = engine.propose({ source: 'proactive', type: 'create_goal', title: 'Fail', confidence: 0.9 });

    await engine.executeAction(id1);
    await engine.executeAction(id2);

    expect(engine.getSuccessRate()).toBe(0.5);
    expect(engine.getSuccessRate('adjust_parameter')).toBe(1);
    expect(engine.getSuccessRate(undefined, 'proactive')).toBe(0.5);
  });

  it('records outcome manually', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    const id = engine.propose({ source: 'mission', type: 'start_mission', title: 'Outcome test', confidence: 0.7 });

    // Manually mark as executing first by internal exec
    engine.registerHandler('start_mission', vi.fn().mockResolvedValue({}));

    engine.recordOutcome(id, { success: true, result: { missionId: 42 }, learnedLesson: 'Missions work' });
    const action = engine.getAction(id);
    expect(action?.status).toBe('completed');
    expect(action?.outcome?.learnedLesson).toBe('Missions work');
  });

  it('rejects proposal when queue is full', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test', maxPendingActions: 2 });
    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'One', confidence: 0.5 });
    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Two', confidence: 0.5 });
    const id = engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Three', confidence: 0.5 });
    expect(id).toBe(-1);
  });

  it('disables auto-execute when configured', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test', autoExecuteEnabled: false });
    engine.registerHandler('adjust_parameter', vi.fn());

    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'No auto', confidence: 0.9 });
    const executed = await engine.processQueue();
    expect(executed).toBe(0);
  });

  it('getStatus returns overview', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Test', confidence: 0.5 });
    const status = engine.getStatus();
    expect(status.queueSize).toBe(1);
    expect(status.autoExecuteEnabled).toBe(true);
    expect(status.topSources).toHaveLength(1);
    expect(status.topSources[0].source).toBe('proactive');
  });

  it('onOutcome callback fires on success', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('adjust_parameter', vi.fn().mockResolvedValue({ adjusted: true }));

    const cb = vi.fn();
    engine.onOutcome(cb);

    const id = engine.propose({ source: 'research', type: 'adjust_parameter', title: 'Callback test', confidence: 0.9 });
    await engine.executeAction(id);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].title).toBe('Callback test');
    expect(cb.mock.calls[0][1].success).toBe(true);
  });

  it('onOutcome callback fires on failure', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('create_goal', vi.fn().mockRejectedValue(new Error('goal fail')));

    const cb = vi.fn();
    engine.onOutcome(cb);

    const id = engine.propose({ source: 'desire', type: 'create_goal', title: 'Fail callback', confidence: 0.9 });
    await engine.executeAction(id);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1].success).toBe(false);
  });

  it('onOutcome callback fires during processQueue auto-execution', async () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.registerHandler('adjust_parameter', vi.fn().mockResolvedValue({}));

    const cb = vi.fn();
    engine.onOutcome(cb);

    engine.propose({ source: 'proactive', type: 'adjust_parameter', title: 'Auto cb', confidence: 0.8 });
    await engine.processQueue();

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('migration is idempotent', () => {
    const engine = new ActionBridgeEngine(db, { brainName: 'test' });
    engine.propose({ source: 'proactive', type: 'start_mission', title: 'Survives', confidence: 0.5 });
    runActionBridgeMigration(db);
    const queue = engine.getQueue('pending');
    expect(queue).toHaveLength(1);
  });
});
