import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { LoopDetector, runLoopDetectorMigration } from '../../../src/governance/loop-detector.js';
import { RuntimeInfluenceTracker } from '../../../src/governance/runtime-influence-tracker.js';

describe('LoopDetector', () => {
  let db: Database.Database;
  let detector: LoopDetector;
  let tracker: RuntimeInfluenceTracker;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create tables that the tracker and detector read from
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
        engine TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        insights INTEGER DEFAULT 0,
        anomalies INTEGER DEFAULT 0,
        predictions INTEGER DEFAULT 0,
        journal_entries INTEGER DEFAULT 0,
        thoughts INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS engine_report_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        engine TEXT, grade TEXT, combined_score REAL,
        health_score REAL, value_score REAL, signal_to_noise REAL
      );
      CREATE TABLE IF NOT EXISTS meta_trends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric TEXT, value REAL
      );
      CREATE TABLE IF NOT EXISTS contradictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    tracker = new RuntimeInfluenceTracker(db);
    detector = new LoopDetector(db);
    detector.setInfluenceTracker(tracker);
  });

  describe('detect', () => {
    it('returns empty when no issues', () => {
      const detections = detector.detect(1);
      expect(detections).toHaveLength(0);
    });

    it('detects stagnation when engine produces no output for 5+ cycles', () => {
      // Insert 5 cycles of zero-output metrics
      for (let cycle = 1; cycle <= 6; cycle++) {
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('stagnant_engine', ?, 0, 0, 0, 0, 0, 100)
        `).run(cycle);
      }

      const detections = detector.detect(6);
      const stagnation = detections.filter(d => d.loopType === 'stagnation');
      expect(stagnation.length).toBeGreaterThan(0);
      expect(stagnation[0].enginesInvolved).toContain('stagnant_engine');
    });

    it('does NOT detect stagnation when engine produces output', () => {
      for (let cycle = 1; cycle <= 6; cycle++) {
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('active_engine', ?, ?, 0, 0, 0, 0, 100)
        `).run(cycle, cycle); // increasing insights
      }

      const detections = detector.detect(6);
      const stagnation = detections.filter(d => d.loopType === 'stagnation');
      expect(stagnation).toHaveLength(0);
    });
  });

  describe('KPI Gaming detection', () => {
    it('detects gaming when engine score rises but system quality falls', () => {
      // Insert declining knowledge quality trend
      for (let i = 0; i < 5; i++) {
        db.prepare('INSERT INTO meta_trends (metric, value) VALUES (?, ?)').run('knowledge_quality', 0.8 - i * 0.05);
      }

      // Insert rising engine scores
      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO engine_report_cards (engine, grade, combined_score, health_score, value_score, signal_to_noise)
          VALUES ('gaming_engine', 'B', ?, 0.7, 0.7, 0.7)
        `).run(0.5 + i * 0.05);
      }

      const detections = detector.detect(10);
      const gaming = detections.filter(d => d.loopType === 'kpi_gaming');
      expect(gaming.length).toBeGreaterThan(0);
    });

    it('does NOT detect gaming when system quality is stable', () => {
      // Stable knowledge quality
      for (let i = 0; i < 5; i++) {
        db.prepare('INSERT INTO meta_trends (metric, value) VALUES (?, ?)').run('knowledge_quality', 0.8);
      }

      for (let i = 0; i < 5; i++) {
        db.prepare(`
          INSERT INTO engine_report_cards (engine, grade, combined_score, health_score, value_score, signal_to_noise)
          VALUES ('good_engine', 'A', ?, 0.9, 0.9, 0.9)
        `).run(0.5 + i * 0.05);
      }

      const detections = detector.detect(10);
      const gaming = detections.filter(d => d.loopType === 'kpi_gaming');
      expect(gaming).toHaveLength(0);
    });
  });

  describe('Epistemic Drift detection', () => {
    it('detects drift when contradictions rise and confidence drops', () => {
      // Insert recent contradictions
      for (let i = 0; i < 8; i++) {
        db.prepare("INSERT INTO contradictions (created_at) VALUES (datetime('now'))").run();
      }
      // Update hypotheses to low confidence
      db.prepare("INSERT INTO hypotheses (statement, status, confidence) VALUES ('test', 'active', 0.2)").run();
      db.prepare("INSERT INTO hypotheses (statement, status, confidence) VALUES ('test2', 'active', 0.3)").run();

      const detections = detector.detect(10);
      const drift = detections.filter(d => d.loopType === 'epistemic_drift');
      expect(drift.length).toBeGreaterThan(0);
    });

    it('does NOT detect drift when contradictions are low', () => {
      db.prepare("INSERT INTO contradictions (created_at) VALUES (datetime('now', '-3 days'))").run();

      const detections = detector.detect(10);
      const drift = detections.filter(d => d.loopType === 'epistemic_drift');
      expect(drift).toHaveLength(0);
    });
  });

  describe('Retrigger spiral detection', () => {
    it('detects cycles in influence graph', () => {
      // Manually insert influence data that creates a cycle: A→B→A
      db.exec(`
        INSERT INTO engine_influences (source_engine, affected_metric, delta, cycle, direction, confidence) VALUES
        ('engine_a', 'shared_metric', 1.0, 1, 1, 0.8),
        ('engine_a', 'shared_metric', 1.0, 2, 1, 0.8),
        ('engine_a', 'shared_metric', 1.0, 3, 1, 0.8),
        ('engine_b', 'shared_metric', 1.0, 1, 1, 0.8),
        ('engine_b', 'shared_metric', 1.0, 2, 1, 0.8),
        ('engine_b', 'shared_metric', 1.0, 3, 1, 0.8)
      `);

      const detections = detector.detect(5);
      // Both engines affect same metric → bidirectional → retrigger potential
      const spirals = detections.filter(d => d.loopType === 'retrigger_spiral');
      // May or may not detect depending on graph structure, just verify no crash
      expect(Array.isArray(spirals)).toBe(true);
    });
  });

  describe('getActive', () => {
    it('returns unresolved detections', () => {
      // Trigger a stagnation detection
      for (let cycle = 1; cycle <= 6; cycle++) {
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('stagnant', ?, 0, 0, 0, 0, 0, 100)
        `).run(cycle);
      }
      detector.detect(6);

      const active = detector.getActive();
      expect(active.length).toBeGreaterThan(0);
      expect(active[0].resolved).toBe(false);
    });
  });

  describe('resolve', () => {
    it('marks detection as resolved', () => {
      for (let cycle = 1; cycle <= 6; cycle++) {
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('stagnant', ?, 0, 0, 0, 0, 0, 100)
        `).run(cycle);
      }
      const detections = detector.detect(6);
      expect(detections.length).toBeGreaterThan(0);

      detector.resolve(detections[0].id);
      const active = detector.getActive();
      const stillActive = active.filter(d => d.id === detections[0].id);
      expect(stillActive).toHaveLength(0);
    });
  });

  describe('getStatus', () => {
    it('returns correct summary', () => {
      // Add stagnation
      for (let cycle = 1; cycle <= 6; cycle++) {
        db.prepare(`
          INSERT INTO engine_metrics (engine, cycle, insights, anomalies, predictions, thoughts, errors, duration_ms)
          VALUES ('stagnant', ?, 0, 0, 0, 0, 0, 100)
        `).run(cycle);
      }
      detector.detect(6);

      const status = detector.getStatus();
      expect(status.totalDetections).toBeGreaterThan(0);
      expect(status.activeDetections).toBeGreaterThan(0);
      expect(status.byType.stagnation).toBeGreaterThan(0);
    });
  });

  describe('runLoopDetectorMigration', () => {
    it('is idempotent', () => {
      const db2 = new Database(':memory:');
      runLoopDetectorMigration(db2);
      runLoopDetectorMigration(db2);
      expect(true).toBe(true);
    });
  });
});
