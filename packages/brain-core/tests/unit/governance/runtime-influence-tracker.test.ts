import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { RuntimeInfluenceTracker, runRuntimeInfluenceMigration } from '../../../src/governance/runtime-influence-tracker.js';

describe('RuntimeInfluenceTracker', () => {
  let db: Database.Database;
  let tracker: RuntimeInfluenceTracker;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create the tables the tracker reads from
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS hypotheses (id INTEGER PRIMARY KEY AUTOINCREMENT, statement TEXT);
      CREATE TABLE IF NOT EXISTS journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS predictions (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT);
      CREATE TABLE IF NOT EXISTS principles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE IF NOT EXISTS causal_edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT);
    `);
    tracker = new RuntimeInfluenceTracker(db);
  });

  describe('snapshotBefore / snapshotAfter', () => {
    it('records before and after snapshots', () => {
      tracker.snapshotBefore('test_engine', 1);
      // Insert data between snapshots
      db.prepare('INSERT INTO insights (title) VALUES (?)').run('test insight');
      tracker.snapshotAfter('test_engine', 1);

      const snapshots = db.prepare('SELECT * FROM engine_snapshots').all();
      expect(snapshots).toHaveLength(2);
    });

    it('records influences when metrics change', () => {
      tracker.snapshotBefore('test_engine', 1);
      db.prepare('INSERT INTO insights (title) VALUES (?)').run('test');
      db.prepare('INSERT INTO insights (title) VALUES (?)').run('test2');
      tracker.snapshotAfter('test_engine', 1);

      const influences = db.prepare('SELECT * FROM engine_influences').all() as Array<Record<string, unknown>>;
      expect(influences.length).toBeGreaterThan(0);
      const insightInfluence = influences.find(i => i.affected_metric === 'insights');
      expect(insightInfluence).toBeDefined();
      expect(insightInfluence!.delta).toBe(2);
      expect(insightInfluence!.direction).toBe(1);
    });

    it('records no influence when metrics unchanged', () => {
      tracker.snapshotBefore('test_engine', 1);
      // No changes
      tracker.snapshotAfter('test_engine', 1);

      const influences = db.prepare('SELECT * FROM engine_influences').all();
      expect(influences).toHaveLength(0);
    });

    it('handles missing before snapshot gracefully', () => {
      tracker.snapshotAfter('test_engine', 99);
      // Should not throw, just no influences recorded
      const influences = db.prepare('SELECT * FROM engine_influences').all();
      expect(influences).toHaveLength(0);
    });
  });

  describe('buildInfluenceGraph', () => {
    it('returns empty graph with no data', () => {
      const graph = tracker.buildInfluenceGraph();
      expect(graph.edges).toHaveLength(0);
      expect(graph.hubs).toHaveLength(0);
      expect(graph.sinks).toHaveLength(0);
    });

    it('builds edges from recorded influences', () => {
      // Simulate multiple cycles with consistent influence
      for (let cycle = 1; cycle <= 5; cycle++) {
        tracker.snapshotBefore('engine_a', cycle);
        db.prepare('INSERT INTO insights (title) VALUES (?)').run(`insight_${cycle}`);
        tracker.snapshotAfter('engine_a', cycle);
      }

      const graph = tracker.buildInfluenceGraph(10);
      expect(graph.edges.length).toBeGreaterThan(0);
      const insightEdge = graph.edges.find(e => e.source === 'engine_a' && e.target === 'insights');
      expect(insightEdge).toBeDefined();
      expect(insightEdge!.observations).toBeGreaterThanOrEqual(2);
    });

    it('identifies hubs (engines affecting many metrics)', () => {
      // Engine affects multiple metrics across cycles
      for (let cycle = 1; cycle <= 5; cycle++) {
        tracker.snapshotBefore('hub_engine', cycle);
        db.prepare('INSERT INTO insights (title) VALUES (?)').run('x');
        db.prepare('INSERT INTO anomalies (title) VALUES (?)').run('x');
        db.prepare('INSERT INTO hypotheses (statement) VALUES (?)').run('x');
        tracker.snapshotAfter('hub_engine', cycle);
      }

      const graph = tracker.buildInfluenceGraph(10);
      expect(graph.hubs).toContain('hub_engine');
    });

    it('identifies sinks (metrics affected by many engines)', () => {
      // Multiple engines affect same metric
      for (let cycle = 1; cycle <= 5; cycle++) {
        for (const engine of ['engine_a', 'engine_b', 'engine_c']) {
          tracker.snapshotBefore(engine, cycle);
          db.prepare('INSERT INTO insights (title) VALUES (?)').run('x');
          tracker.snapshotAfter(engine, cycle);
        }
      }

      const graph = tracker.buildInfluenceGraph(10);
      expect(graph.sinks).toContain('insights');
    });
  });

  describe('getInfluences', () => {
    it('returns influences for specific engine', () => {
      tracker.snapshotBefore('engine_x', 1);
      db.prepare('INSERT INTO insights (title) VALUES (?)').run('x');
      tracker.snapshotAfter('engine_x', 1);

      const influences = tracker.getInfluences('engine_x');
      expect(influences.length).toBeGreaterThan(0);
      expect(influences[0].metric).toBe('insights');
    });

    it('returns empty for unknown engine', () => {
      expect(tracker.getInfluences('nonexistent')).toHaveLength(0);
    });
  });

  describe('feedIntoCausalGraph', () => {
    it('feeds edges into causal graph', () => {
      // Build some influences
      for (let cycle = 1; cycle <= 3; cycle++) {
        tracker.snapshotBefore('engine_a', cycle);
        db.prepare('INSERT INTO insights (title) VALUES (?)').run('x');
        tracker.snapshotAfter('engine_a', cycle);
      }

      const events: Array<{ source: string; type: string; data: unknown }> = [];
      const mockCausal = {
        recordEvent: (source: string, type: string, data?: unknown) => {
          events.push({ source, type, data });
        },
      };

      tracker.feedIntoCausalGraph(mockCausal);
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].source).toContain('engine:');
    });

    it('handles empty influence graph', () => {
      const events: unknown[] = [];
      const mockCausal = { recordEvent: (source: string, type: string, data?: unknown) => events.push({ source, type, data }) };
      tracker.feedIntoCausalGraph(mockCausal);
      expect(events).toHaveLength(0);
    });
  });

  describe('getStatus', () => {
    it('returns correct counts', () => {
      tracker.snapshotBefore('engine_a', 1);
      db.prepare('INSERT INTO insights (title) VALUES (?)').run('x');
      tracker.snapshotAfter('engine_a', 1);

      const status = tracker.getStatus();
      expect(status.totalSnapshots).toBe(2);
      expect(status.totalInfluences).toBeGreaterThan(0);
      expect(status.trackedEngines).toBe(1);
    });

    it('returns zeros for empty tracker', () => {
      const status = tracker.getStatus();
      expect(status.totalSnapshots).toBe(0);
      expect(status.totalInfluences).toBe(0);
      expect(status.trackedEngines).toBe(0);
    });
  });

  describe('runRuntimeInfluenceMigration', () => {
    it('is idempotent', () => {
      const db2 = new Database(':memory:');
      runRuntimeInfluenceMigration(db2);
      runRuntimeInfluenceMigration(db2);
      expect(true).toBe(true);
    });
  });
});
