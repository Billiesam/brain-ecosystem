import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EngineRegistry, getDefaultEngineProfiles } from '../../../src/governance/engine-registry.js';
import { RuntimeInfluenceTracker } from '../../../src/governance/runtime-influence-tracker.js';
import { LoopDetector } from '../../../src/governance/loop-detector.js';
import { GovernanceLayer } from '../../../src/governance/governance-layer.js';

describe('Governance Integration', () => {
  let db: Database.Database;
  let registry: EngineRegistry;
  let tracker: RuntimeInfluenceTracker;
  let loopDetector: LoopDetector;
  let governance: GovernanceLayer;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create all tables the governance system reads from
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS hypotheses (id INTEGER PRIMARY KEY AUTOINCREMENT, statement TEXT, status TEXT DEFAULT 'active', confidence REAL DEFAULT 0.5);
      CREATE TABLE IF NOT EXISTS journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS predictions (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT);
      CREATE TABLE IF NOT EXISTS principles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS causal_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT);
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
      CREATE TABLE IF NOT EXISTS meta_trends (id INTEGER PRIMARY KEY AUTOINCREMENT, metric TEXT, value REAL);
      CREATE TABLE IF NOT EXISTS contradictions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT (datetime('now')));
    `);

    registry = new EngineRegistry(db);
    tracker = new RuntimeInfluenceTracker(db);
    loopDetector = new LoopDetector(db);
    loopDetector.setInfluenceTracker(tracker);
    governance = new GovernanceLayer(db);
    governance.setLoopDetector(loopDetector);
    governance.setEngineRegistry(registry);
  });

  describe('Full Pipeline: Registry → Tracker → Detector → Governance', () => {
    it('registers all default profiles', () => {
      for (const p of getDefaultEngineProfiles()) registry.register(p);
      expect(registry.list().length).toBe(25);
      const status = registry.getStatus();
      expect(status.enabledEngines).toBe(25);
    });

    it('tracker captures before/after, detector finds stagnation, governance responds', () => {
      // Register an engine
      registry.register({
        id: 'stagnant_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'low',
        expectedEffects: [], invariants: [], enabled: true,
      });

      // Simulate 6 cycles of zero-output
      for (let cycle = 1; cycle <= 6; cycle++) {
        tracker.snapshotBefore('stagnant_engine', cycle);
        tracker.snapshotAfter('stagnant_engine', cycle);
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('stagnant_engine', ?, 0, 0, 0, 0, 0, 100)
        `).run(cycle);
      }

      // Detector finds stagnation
      const detections = loopDetector.detect(6);
      expect(detections.length).toBeGreaterThan(0);
      expect(detections[0].loopType).toBe('stagnation');

      // Governance responds
      const decisions = governance.review(10);
      expect(decisions.length).toBeGreaterThan(0);
      const cooldownDecision = decisions.find(d => d.engine === 'stagnant_engine' && d.action === 'cooldown');
      expect(cooldownDecision).toBeDefined();

      // Engine should be blocked from running
      expect(governance.shouldRun('stagnant_engine', 11)).toBe(false);
    });

    it('governance restore allows engine to run again', () => {
      registry.register({
        id: 'recovering_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'low',
        expectedEffects: [], invariants: [], enabled: true,
      });

      governance.isolate('recovering_engine', 'test isolation', 1);
      expect(governance.shouldRun('recovering_engine', 2)).toBe(false);
      expect(registry.get('recovering_engine')!.enabled).toBe(false);

      governance.restore('recovering_engine', 'recovered', 3);
      expect(governance.shouldRun('recovering_engine', 4)).toBe(true);
      expect(registry.get('recovering_engine')!.enabled).toBe(true);
    });

    it('influence graph feeds into causal graph', () => {
      // Simulate engine making changes across multiple cycles
      for (let cycle = 1; cycle <= 5; cycle++) {
        tracker.snapshotBefore('productive_engine', cycle);
        db.prepare('INSERT INTO insights (title) VALUES (?)').run(`insight_${cycle}`);
        db.prepare('INSERT INTO anomalies (title) VALUES (?)').run(`anomaly_${cycle}`);
        tracker.snapshotAfter('productive_engine', cycle);
      }

      // Build and check influence graph
      const graph = tracker.buildInfluenceGraph(10);
      expect(graph.edges.length).toBeGreaterThan(0);

      // Feed into mock causal graph
      const events: Array<{ source: string; type: string; data: unknown }> = [];
      tracker.feedIntoCausalGraph({
        recordEvent: (source: string, type: string, data?: unknown) => events.push({ source, type, data }),
      });
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.source.startsWith('engine:'))).toBe(true);
    });

    it('KPI gaming + escalation pipeline works end to end', () => {
      // Declining knowledge quality
      for (let i = 0; i < 5; i++) {
        db.prepare('INSERT INTO meta_trends (metric, value) VALUES (?, ?)').run('knowledge_quality', 0.8 - i * 0.05);
      }

      // Rising engine scores
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO engine_report_cards (engine, grade, combined_score, health_score, value_score, signal_to_noise)
          VALUES ('gaming_engine', 'B', ?, 0.7, 0.7, 0.7)
        `).run(0.5 + i * 0.05);
      }

      registry.register({
        id: 'gaming_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'high',
        expectedEffects: [], invariants: [], enabled: true,
      });

      // Detect KPI gaming
      const detections = loopDetector.detect(10);
      const gaming = detections.filter(d => d.loopType === 'kpi_gaming');
      expect(gaming.length).toBeGreaterThan(0);

      // Governance escalates
      const journalEntries: Array<Record<string, unknown>> = [];
      governance.setJournalWriter({ write: (e) => journalEntries.push(e) });

      const decisions = governance.review(10);
      const escalations = decisions.filter(d => d.action === 'escalate');
      expect(escalations.length).toBeGreaterThan(0);
      expect(journalEntries.length).toBeGreaterThan(0);
    });

    it('dependency graph correctly identifies producer-consumer chains', () => {
      for (const p of getDefaultEngineProfiles()) registry.register(p);
      const graph = registry.getDependencyGraph();

      // Knowledge distiller reads insights → should depend on engines that write insights
      const distillerDeps = graph.get('knowledge_distiller');
      expect(distillerDeps).toBeDefined();
      // self_observer writes to self_observations, not insights, so shouldn't be dep

      // evolution_engine depends on engines writing to parameter_registry + engine_report_cards
      const evolutionDeps = graph.get('evolution_engine');
      expect(evolutionDeps).toBeDefined();
      expect(evolutionDeps!.length).toBeGreaterThan(0);
    });

    it('concurrent governance actions work correctly', () => {
      registry.register({
        id: 'multi_action_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'medium',
        expectedEffects: [], invariants: [], enabled: true,
      });

      // Apply throttle, then cooldown, then restore
      governance.throttle('multi_action_engine', 'reason1', 1);
      governance.cooldown('multi_action_engine', 'reason2', 10, 2);

      // Both active
      const active = governance.getActiveActions('multi_action_engine');
      expect(active.length).toBe(2);

      // Restore clears all
      governance.restore('multi_action_engine', 'all clear', 3);
      const afterRestore = governance.getActiveActions('multi_action_engine');
      // Only restore should be active
      expect(afterRestore.filter(a => a.actionType !== 'restore')).toHaveLength(0);
    });

    it('getStatus aggregates across all subsystems', () => {
      for (const p of getDefaultEngineProfiles()) registry.register(p);

      const registryStatus = registry.getStatus();
      expect(registryStatus.totalEngines).toBe(25);

      const trackerStatus = tracker.getStatus();
      expect(trackerStatus.totalSnapshots).toBe(0); // nothing tracked yet

      const loopStatus = loopDetector.getStatus();
      expect(loopStatus.totalDetections).toBe(0);

      const govStatus = governance.getStatus();
      expect(govStatus.totalActions).toBe(0);
    });

    it('multiple throttles escalate to isolate in review', () => {
      registry.register({
        id: 'problem_engine', reads: [], writes: [], emits: [], subscribes: [],
        frequency: 'every_cycle', frequencyN: 1, riskClass: 'high',
        expectedEffects: [], invariants: [], enabled: true,
      });

      governance.throttle('problem_engine', 'too fast', 1);
      governance.throttle('problem_engine', 'still too fast', 2);
      governance.throttle('problem_engine', 'way too fast', 3);

      const decisions = governance.review(5);
      const isolateDecision = decisions.find(d => d.engine === 'problem_engine' && d.action === 'isolate');
      expect(isolateDecision).toBeDefined();
      expect(governance.shouldRun('problem_engine', 6)).toBe(false);
    });
  });
});
