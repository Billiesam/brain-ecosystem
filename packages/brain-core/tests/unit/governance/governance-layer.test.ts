import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GovernanceLayer, runGovernanceMigration } from '../../../src/governance/governance-layer.js';
import { LoopDetector, runLoopDetectorMigration } from '../../../src/governance/loop-detector.js';
import { EngineRegistry, runEngineRegistryMigration } from '../../../src/governance/engine-registry.js';

describe('GovernanceLayer', () => {
  let db: Database.Database;
  let layer: GovernanceLayer;
  let registry: EngineRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create tables the loop detector reads
    db.exec(`
      CREATE TABLE IF NOT EXISTS engine_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine TEXT, cycle INTEGER, insights INTEGER DEFAULT 0,
        anomalies INTEGER DEFAULT 0, predictions INTEGER DEFAULT 0,
        journal_entries INTEGER DEFAULT 0, thoughts INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0, duration_ms INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS engine_report_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine TEXT, grade TEXT, combined_score REAL,
        health_score REAL, value_score REAL, signal_to_noise REAL
      );
    `);
    registry = new EngineRegistry(db);
    registry.register({
      id: 'test_engine', reads: [], writes: [], emits: [], subscribes: [],
      frequency: 'every_cycle', frequencyN: 1, riskClass: 'low',
      expectedEffects: [], invariants: [], enabled: true,
    });

    layer = new GovernanceLayer(db);
    layer.setEngineRegistry(registry);
  });

  describe('shouldRun', () => {
    it('allows non-throttled engines', () => {
      expect(layer.shouldRun('test_engine', 1)).toBe(true);
    });

    it('blocks isolated engines', () => {
      layer.isolate('test_engine', 'test isolation', 1);
      expect(layer.shouldRun('test_engine', 2)).toBe(false);
    });

    it('blocks cooled-down engines before expiry', () => {
      layer.cooldown('test_engine', 'test cooldown', 100, 1);
      expect(layer.shouldRun('test_engine', 2)).toBe(false);
    });

    it('throttled engines skip odd cycles', () => {
      layer.throttle('test_engine', 'test throttle', 1);
      expect(layer.shouldRun('test_engine', 2)).toBe(true);  // even → runs
      expect(layer.shouldRun('test_engine', 3)).toBe(false); // odd → skipped
    });
  });

  describe('throttle', () => {
    it('records a throttle action', () => {
      layer.throttle('test_engine', 'too frequent', 5);
      const actions = layer.getHistory();
      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('throttle');
      expect(actions[0].engine).toBe('test_engine');
    });
  });

  describe('cooldown', () => {
    it('records a cooldown action with expiry', () => {
      layer.cooldown('test_engine', 'needs rest', 10, 5);
      const actions = layer.getHistory();
      expect(actions).toHaveLength(1);
      expect(actions[0].actionType).toBe('cooldown');
      expect(actions[0].expiresAt).toBeTruthy();
    });
  });

  describe('isolate', () => {
    it('records isolate and disables in registry', () => {
      layer.isolate('test_engine', 'critical issue', 5);
      expect(registry.get('test_engine')!.enabled).toBe(false);
      const actions = layer.getActiveActions('test_engine');
      expect(actions.some(a => a.actionType === 'isolate')).toBe(true);
    });
  });

  describe('escalate', () => {
    it('records escalation', () => {
      const journalEntries: Array<Record<string, unknown>> = [];
      layer.setJournalWriter({ write: (entry) => journalEntries.push(entry) });

      layer.escalate('test_engine', 'urgent attention needed', 5);
      const actions = layer.getHistory();
      expect(actions.some(a => a.actionType === 'escalate')).toBe(true);
      expect(journalEntries.length).toBeGreaterThan(0);
      expect(journalEntries[0].title).toContain('Escalation');
    });
  });

  describe('restore', () => {
    it('clears active actions and re-enables engine', () => {
      layer.isolate('test_engine', 'critical', 5);
      expect(registry.get('test_engine')!.enabled).toBe(false);
      expect(layer.shouldRun('test_engine', 6)).toBe(false);

      layer.restore('test_engine', 'issue resolved', 7);
      expect(registry.get('test_engine')!.enabled).toBe(true);
      expect(layer.shouldRun('test_engine', 8)).toBe(true);
    });

    it('clears all active actions for engine', () => {
      layer.throttle('test_engine', 'r1', 1);
      layer.cooldown('test_engine', 'r2', 10, 2);
      layer.restore('test_engine', 'all clear', 3);

      const activeActions = layer.getActiveActions('test_engine');
      // Only restore should be active
      const nonRestore = activeActions.filter(a => a.actionType !== 'restore');
      expect(nonRestore).toHaveLength(0);
    });
  });

  describe('review', () => {
    it('returns empty decisions when no issues', () => {
      const decisions = layer.review(10);
      expect(decisions).toHaveLength(0);
    });

    it('responds to loop detector stagnation with cooldown', () => {
      const loopDetector = new LoopDetector(db);
      layer.setLoopDetector(loopDetector);

      // Create stagnation
      for (let cycle = 1; cycle <= 6; cycle++) {
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('stagnant_engine', ?, 0, 0, 0, 0, 0, 100)
        `).run(cycle);
      }
      loopDetector.detect(6);

      // Register the engine so governance can act
      registry.register({
        id: 'stagnant_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'low',
        expectedEffects: [], invariants: [], enabled: true,
      });

      const decisions = layer.review(10);
      const cooldownDecisions = decisions.filter(d => d.action === 'cooldown');
      expect(cooldownDecisions.length).toBeGreaterThan(0);
    });

    it('responds to Grade F × 3 with cooldown', () => {
      // Simulate 3 F grades
      for (let i = 0; i < 4; i++) {
        db.prepare(`
          INSERT INTO engine_report_cards (engine, grade, combined_score, health_score, value_score, signal_to_noise)
          VALUES ('bad_engine', 'F', 0.1, 0.1, 0.1, 0.1)
        `).run();
      }

      layer.setMetaCognitionLayer({ evaluate: () => [] });
      const decisions = layer.review(10);
      const cooldowns = decisions.filter(d => d.engine === 'bad_engine' && d.action === 'cooldown');
      expect(cooldowns.length).toBeGreaterThan(0);
    });

    it('escalates multiple throttles to isolate', () => {
      // Record 3 throttles
      layer.throttle('trouble_engine', 'r1', 1);
      layer.throttle('trouble_engine', 'r2', 2);
      layer.throttle('trouble_engine', 'r3', 3);

      registry.register({
        id: 'trouble_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'high',
        expectedEffects: [], invariants: [], enabled: true,
      });

      const decisions = layer.review(5);
      const isolates = decisions.filter(d => d.engine === 'trouble_engine' && d.action === 'isolate');
      expect(isolates.length).toBeGreaterThan(0);
    });
  });

  describe('getHistory', () => {
    it('returns recent actions', () => {
      layer.throttle('a', 'r1', 1);
      layer.cooldown('b', 'r2', 5, 2);
      const history = layer.getHistory(10);
      expect(history).toHaveLength(2);
    });
  });

  describe('getActiveActions', () => {
    it('filters by engine', () => {
      layer.throttle('a', 'r1', 1);
      layer.throttle('b', 'r2', 2);
      const actions = layer.getActiveActions('a');
      expect(actions).toHaveLength(1);
      expect(actions[0].engine).toBe('a');
    });

    it('returns all active when no engine specified', () => {
      layer.throttle('a', 'r1', 1);
      layer.throttle('b', 'r2', 2);
      const actions = layer.getActiveActions();
      expect(actions).toHaveLength(2);
    });
  });

  describe('getStatus', () => {
    it('returns correct status', () => {
      layer.throttle('a', 'r1', 1);
      layer.isolate('b', 'r2', 2);

      const status = layer.getStatus();
      expect(status.totalActions).toBe(2);
      expect(status.activeActions).toBe(2);
      expect(status.throttledEngines).toContain('a');
      expect(status.isolatedEngines).toContain('b');
    });
  });

  describe('runGovernanceMigration', () => {
    it('is idempotent', () => {
      const db2 = new Database(':memory:');
      runGovernanceMigration(db2);
      runGovernanceMigration(db2);
      expect(true).toBe(true);
    });
  });
});
