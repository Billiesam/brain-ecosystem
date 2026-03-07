import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CheckpointManager } from '../checkpoint-manager.js';

describe('CheckpointManager', () => {
  let db: Database.Database;
  let cm: CheckpointManager;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    cm = new CheckpointManager(db);
  });

  describe('migration', () => {
    it('should create workflow_checkpoints table', () => {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'workflow_checkpoints'`,
      ).all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
    });
  });

  describe('save + load', () => {
    it('should save and load a checkpoint', () => {
      cm.save('wf-1', 5, { cycleCount: 10, stepsCompleted: ['observe', 'hypothesize'] });

      const cp = cm.load('wf-1');
      expect(cp).not.toBeNull();
      expect(cp!.workflow_id).toBe('wf-1');
      expect(cp!.step).toBe(5);
      expect(cp!.state).toEqual({ cycleCount: 10, stepsCompleted: ['observe', 'hypothesize'] });
    });

    it('should return latest checkpoint when multiple exist', () => {
      cm.save('wf-1', 1, { step: 'observe' });
      cm.save('wf-1', 5, { step: 'distill' });
      cm.save('wf-1', 3, { step: 'experiment' });

      const cp = cm.load('wf-1');
      expect(cp!.step).toBe(5); // highest step
    });

    it('should return null for unknown workflow', () => {
      expect(cm.load('nonexistent')).toBeNull();
    });

    it('should store workflow type and metadata', () => {
      cm.save('mission-42', 2, { phase: 'gather' }, {
        workflowType: 'mission',
        metadata: { missionId: 42, source: 'curiosity' },
      });

      const cp = cm.load('mission-42');
      expect(cp!.workflow_type).toBe('mission');
      expect(cp!.metadata).toEqual({ missionId: 42, source: 'curiosity' });
    });
  });

  describe('resumeStep', () => {
    it('should return 0 for unknown workflow', () => {
      expect(cm.resumeStep('nope')).toBe(0);
    });

    it('should return latest step number', () => {
      cm.save('wf-1', 10, {});
      cm.save('wf-1', 35, {});
      expect(cm.resumeStep('wf-1')).toBe(35);
    });
  });

  describe('history', () => {
    it('should return empty array for unknown workflow', () => {
      expect(cm.history('nope')).toEqual([]);
    });

    it('should return all checkpoints in step order', () => {
      cm.save('wf-1', 3, { a: 1 });
      cm.save('wf-1', 1, { b: 2 });
      cm.save('wf-1', 5, { c: 3 });

      const h = cm.history('wf-1');
      expect(h).toHaveLength(3);
      expect(h[0]!.step).toBe(1);
      expect(h[1]!.step).toBe(3);
      expect(h[2]!.step).toBe(5);
    });
  });

  describe('fork', () => {
    it('should copy all checkpoints to new workflow ID', () => {
      cm.save('wf-original', 1, { a: 1 });
      cm.save('wf-original', 5, { b: 2 });
      cm.save('wf-original', 10, { c: 3 });

      const count = cm.fork('wf-original', 'wf-fork');
      expect(count).toBe(3);

      const forked = cm.history('wf-fork');
      expect(forked).toHaveLength(3);
      expect(forked[0]!.state).toEqual({ a: 1 });
      expect(forked[2]!.metadata).toHaveProperty('forked_from', 'wf-original');
    });

    it('should return 0 when forking nonexistent workflow', () => {
      expect(cm.fork('nope', 'fork')).toBe(0);
    });
  });

  describe('listWorkflows', () => {
    it('should return empty list initially', () => {
      expect(cm.listWorkflows()).toEqual([]);
    });

    it('should list workflows with summaries', () => {
      cm.save('wf-a', 1, {});
      cm.save('wf-a', 5, {});
      cm.save('wf-b', 1, {}, { workflowType: 'mission' });

      const list = cm.listWorkflows();
      expect(list).toHaveLength(2);
      expect(list[0]!.workflow_id).toBeDefined();
      expect(list.find(w => w.workflow_id === 'wf-a')!.total_checkpoints).toBe(2);
      expect(list.find(w => w.workflow_id === 'wf-a')!.latest_step).toBe(5);
    });

    it('should respect limit', () => {
      for (let i = 0; i < 5; i++) cm.save(`wf-${i}`, 1, {});
      expect(cm.listWorkflows(3)).toHaveLength(3);
    });
  });

  describe('delete', () => {
    it('should delete all checkpoints for a workflow', () => {
      cm.save('wf-1', 1, {});
      cm.save('wf-1', 5, {});
      cm.save('wf-2', 1, {});

      const deleted = cm.delete('wf-1');
      expect(deleted).toBe(2);
      expect(cm.load('wf-1')).toBeNull();
      expect(cm.load('wf-2')).not.toBeNull();
    });

    it('should return 0 for nonexistent workflow', () => {
      expect(cm.delete('nope')).toBe(0);
    });
  });

  describe('prune', () => {
    it('should prune excess checkpoints per workflow', () => {
      for (let i = 0; i < 20; i++) cm.save('wf-1', i, { step: i });

      const pruned = cm.prune({ keepPerWorkflow: 5 });
      expect(pruned).toBe(15);

      const remaining = cm.history('wf-1');
      expect(remaining).toHaveLength(5);
      // Should keep the latest 5
      expect(remaining[remaining.length - 1]!.step).toBe(19);
    });

    it('should not prune if within limits', () => {
      cm.save('wf-1', 1, {});
      cm.save('wf-1', 2, {});

      const pruned = cm.prune({ keepPerWorkflow: 10 });
      expect(pruned).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('should return empty status initially', () => {
      const status = cm.getStatus();
      expect(status.totalCheckpoints).toBe(0);
      expect(status.totalWorkflows).toBe(0);
      expect(status.oldestAt).toBeNull();
    });

    it('should track checkpoint stats', () => {
      cm.save('wf-1', 1, {});
      cm.save('wf-1', 5, {});
      cm.save('mission-1', 2, {}, { workflowType: 'mission' });

      const status = cm.getStatus();
      expect(status.totalCheckpoints).toBe(3);
      expect(status.totalWorkflows).toBe(2);
      expect(status.byType['orchestrator']).toBe(2);
      expect(status.byType['mission']).toBe(1);
      expect(status.oldestAt).toBeDefined();
    });
  });
});
