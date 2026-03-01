import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { DreamConsolidator } from '../../../src/dream/consolidator.js';
import { BaseEmbeddingEngine } from '../../../src/embeddings/engine.js';
import type { DreamEngineConfig } from '../../../src/dream/types.js';

// ── Setup ───────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create minimal schema for testing
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      importance REAL NOT NULL DEFAULT 5,
      active INTEGER NOT NULL DEFAULT 1,
      embedding BLOB,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS synapses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      synapse_type TEXT NOT NULL DEFAULT 'co_occurs',
      weight REAL NOT NULL DEFAULT 0.5,
      last_activated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function defaultConfig(): Required<DreamEngineConfig> {
  return {
    brainName: 'test',
    intervalMs: 1_800_000,
    idleThresholdMs: 300_000,
    replayBatchSize: 20,
    clusterSimilarityThreshold: 0.75,
    minClusterSize: 3,
    importanceDecayRate: 0.5,
    importanceDecayAfterDays: 30,
    archiveImportanceThreshold: 1,
    dreamPruneThreshold: 0.15,
    dreamLearningRate: 0.15,
    maxConsolidationsPerCycle: 5,
  };
}

// ── Tests ───────────────────────────────────────────────

describe('DreamConsolidator', () => {
  let db: Database.Database;
  let consolidator: DreamConsolidator;
  let config: Required<DreamEngineConfig>;

  beforeEach(() => {
    db = createTestDb();
    consolidator = new DreamConsolidator();
    config = defaultConfig();
  });

  // ── replayMemories ─────────────────────────────────────

  describe('replayMemories', () => {
    it('should return empty result when no memories exist', () => {
      const result = consolidator.replayMemories(db, config);
      expect(result.memoriesReplayed).toBe(0);
      expect(result.synapsesStrengthened).toBe(0);
      expect(result.synapsesDecayed).toBe(0);
      expect(result.topActivations).toEqual([]);
    });

    it('should replay memories sorted by importance', () => {
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('low importance', 2);
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('high importance', 10);
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('medium importance', 5);

      const result = consolidator.replayMemories(db, config);
      expect(result.memoriesReplayed).toBe(3);
      // Top activation should be the highest importance
      expect(result.topActivations[0]!.importance).toBe(10);
    });

    it('should respect replayBatchSize limit', () => {
      for (let i = 0; i < 10; i++) {
        db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run(`memory ${i}`, i + 1);
      }
      config.replayBatchSize = 3;
      const result = consolidator.replayMemories(db, config);
      expect(result.memoriesReplayed).toBe(3);
    });

    it('should strengthen strong synapses and decay weak ones', () => {
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('test memory', 10);
      const memId = 1;

      // Strong synapse
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('memory', String(memId), 'error', '1', 0.8);
      // Weak synapse
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('memory', String(memId), 'error', '2', 0.05);

      const result = consolidator.replayMemories(db, config);
      expect(result.synapsesStrengthened).toBe(1);
      expect(result.synapsesDecayed).toBe(1);

      // Check the strong synapse was boosted
      const strong = db.prepare(`SELECT weight FROM synapses WHERE id = 1`).get() as { weight: number };
      expect(strong.weight).toBeGreaterThan(0.8);

      // Check the weak synapse was further decayed
      const weak = db.prepare(`SELECT weight FROM synapses WHERE id = 2`).get() as { weight: number };
      expect(weak.weight).toBeLessThan(0.05);
    });

    it('should skip inactive memories', () => {
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, ?)`).run('active', 10, 1);
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, ?)`).run('inactive', 10, 0);

      const result = consolidator.replayMemories(db, config);
      expect(result.memoriesReplayed).toBe(1);
    });
  });

  // ── pruneSynapses ──────────────────────────────────────

  describe('pruneSynapses', () => {
    it('should return zero when no synapses exist', () => {
      const result = consolidator.pruneSynapses(db, config);
      expect(result.synapsesPruned).toBe(0);
      expect(result.threshold).toBe(0.15);
    });

    it('should prune weak synapses below threshold', () => {
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('a', '1', 'b', '1', 0.05);
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('a', '2', 'b', '2', 0.10);
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('a', '3', 'b', '3', 0.50);

      const result = consolidator.pruneSynapses(db, config);
      expect(result.synapsesPruned).toBe(2);

      // Only the strong synapse should remain
      const remaining = db.prepare(`SELECT COUNT(*) as c FROM synapses`).get() as { c: number };
      expect(remaining.c).toBe(1);
    });

    it('should not prune synapses above threshold', () => {
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('a', '1', 'b', '1', 0.5);
      db.prepare(`INSERT INTO synapses (source_type, source_id, target_type, target_id, weight) VALUES (?, ?, ?, ?, ?)`).run('a', '2', 'b', '2', 0.9);

      const result = consolidator.pruneSynapses(db, config);
      expect(result.synapsesPruned).toBe(0);

      const remaining = db.prepare(`SELECT COUNT(*) as c FROM synapses`).get() as { c: number };
      expect(remaining.c).toBe(2);
    });
  });

  // ── compressMemories ───────────────────────────────────

  describe('compressMemories', () => {
    it('should return empty result when no embedding engine', () => {
      const result = consolidator.compressMemories(db, null, config);
      expect(result.clustersFound).toBe(0);
      expect(result.memoriesConsolidated).toBe(0);
    });

    it('should return empty result when no memories have embeddings', () => {
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('test', 5);

      const engine = new BaseEmbeddingEngine({ enabled: false });
      const result = consolidator.compressMemories(db, engine, config);
      expect(result.clustersFound).toBe(0);
    });

    it('should cluster similar memories and supersede originals', () => {
      // Create a small vector for testing (4 dimensions)
      const vec1 = new Float32Array([1, 0, 0, 0]);
      const vec2 = new Float32Array([0.99, 0.01, 0, 0]); // very similar to vec1
      const vec3 = new Float32Array([0.98, 0.02, 0, 0]); // very similar to vec1
      const vecDiff = new Float32Array([0, 0, 1, 0]); // different

      const serialize = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

      db.prepare(`INSERT INTO memories (content, importance, active, embedding) VALUES (?, ?, 1, ?)`).run('similar A', 10, serialize(vec1));
      db.prepare(`INSERT INTO memories (content, importance, active, embedding) VALUES (?, ?, 1, ?)`).run('similar B', 5, serialize(vec2));
      db.prepare(`INSERT INTO memories (content, importance, active, embedding) VALUES (?, ?, 1, ?)`).run('similar C', 3, serialize(vec3));
      db.prepare(`INSERT INTO memories (content, importance, active, embedding) VALUES (?, ?, 1, ?)`).run('different', 8, serialize(vecDiff));

      config.clusterSimilarityThreshold = 0.9;
      config.minClusterSize = 3;

      const engine = new BaseEmbeddingEngine({ enabled: false });
      const result = consolidator.compressMemories(db, engine, config);

      expect(result.clustersFound).toBe(1);
      expect(result.memoriesConsolidated).toBe(1);
      expect(result.memoriesSuperseded).toBe(2);

      // Check centroid (highest importance) is still active
      const centroid = db.prepare(`SELECT active, importance FROM memories WHERE id = 1`).get() as { active: number; importance: number };
      expect(centroid.active).toBe(1);
      expect(centroid.importance).toBeGreaterThan(10);

      // Check superseded memories are inactive
      const superseded1 = db.prepare(`SELECT active FROM memories WHERE id = 2`).get() as { active: number };
      expect(superseded1.active).toBe(0);

      // Check different memory is still active
      const different = db.prepare(`SELECT active FROM memories WHERE id = 4`).get() as { active: number };
      expect(different.active).toBe(1);
    });

    it('should respect maxConsolidationsPerCycle', () => {
      const vec = new Float32Array([1, 0, 0, 0]);
      const serialize = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

      // Create 6 similar memories (enough for 2 clusters of 3)
      for (let i = 0; i < 6; i++) {
        const v = new Float32Array([1, i * 0.001, 0, 0]);
        db.prepare(`INSERT INTO memories (content, importance, active, embedding) VALUES (?, ?, 1, ?)`).run(`mem ${i}`, 10 - i, serialize(v));
      }

      config.clusterSimilarityThreshold = 0.9;
      config.minClusterSize = 3;
      config.maxConsolidationsPerCycle = 1;

      const engine = new BaseEmbeddingEngine({ enabled: false });
      const result = consolidator.compressMemories(db, engine, config);

      expect(result.memoriesConsolidated).toBeLessThanOrEqual(1);
    });
  });

  // ── decayImportance ────────────────────────────────────

  describe('decayImportance', () => {
    it('should return empty result when no old memories exist', () => {
      const result = consolidator.decayImportance(db, config);
      expect(result.memoriesDecayed).toBe(0);
      expect(result.memoriesArchived).toBe(0);
    });

    it('should decay old memories and archive when below threshold', () => {
      // Insert an old memory by setting updated_at to 60 days ago
      db.prepare(`INSERT INTO memories (content, importance, active, updated_at) VALUES (?, ?, 1, datetime('now', '-60 days'))`).run('old memory', 2);
      // Insert a fresh memory
      db.prepare(`INSERT INTO memories (content, importance, active) VALUES (?, ?, 1)`).run('fresh memory', 10);

      config.importanceDecayAfterDays = 30;
      config.importanceDecayRate = 0.5;
      config.archiveImportanceThreshold = 1;

      const result = consolidator.decayImportance(db, config);
      expect(result.memoriesDecayed).toBe(1);
      // importance 2 * 0.5 = 1.0 → should be archived
      expect(result.memoriesArchived).toBe(1);

      // Check the old memory is now inactive
      const old = db.prepare(`SELECT active FROM memories WHERE id = 1`).get() as { active: number };
      expect(old.active).toBe(0);

      // Fresh memory should be untouched
      const fresh = db.prepare(`SELECT active, importance FROM memories WHERE id = 2`).get() as { active: number; importance: number };
      expect(fresh.active).toBe(1);
      expect(fresh.importance).toBe(10);
    });

    it('should decay but not archive if above threshold', () => {
      db.prepare(`INSERT INTO memories (content, importance, active, updated_at) VALUES (?, ?, 1, datetime('now', '-60 days'))`).run('old but important', 20);

      config.importanceDecayAfterDays = 30;
      config.importanceDecayRate = 0.5;
      config.archiveImportanceThreshold = 1;

      const result = consolidator.decayImportance(db, config);
      expect(result.memoriesDecayed).toBe(1);
      expect(result.memoriesArchived).toBe(0);

      // importance 20 * 0.5 = 10 → still above threshold, stays active
      const mem = db.prepare(`SELECT active, importance FROM memories WHERE id = 1`).get() as { active: number; importance: number };
      expect(mem.active).toBe(1);
      expect(mem.importance).toBe(10);
    });
  });
});
