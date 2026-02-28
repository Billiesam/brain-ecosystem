import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { CalibrationRepository } from '../../../src/db/repositories/calibration.repository.js';
import type { CalibrationConfig } from '../../../src/types/config.types.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeCalibration(overrides: Partial<CalibrationConfig> = {}): CalibrationConfig {
  return {
    learningRate: 0.1,
    weakenPenalty: 0.8,
    decayHalfLifeDays: 30,
    patternExtractionInterval: 60000,
    patternMinSamples: 5,
    patternWilsonThreshold: 0.55,
    wilsonZ: 1.96,
    spreadingActivationDecay: 0.6,
    spreadingActivationThreshold: 0.05,
    minActivationsForWeight: 3,
    minOutcomesForWeights: 10,
    ...overrides,
  };
}

describe('CalibrationRepository — history', () => {
  let db: Database.Database;
  let repo: CalibrationRepository;

  beforeEach(() => {
    db = new Database(':memory:');

    // Create calibration table (from 003_learning migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS calibration (
        id TEXT PRIMARY KEY DEFAULT 'main',
        learning_rate REAL NOT NULL,
        weaken_penalty REAL NOT NULL,
        decay_half_life_days INTEGER NOT NULL,
        pattern_extraction_interval INTEGER NOT NULL,
        pattern_min_samples INTEGER NOT NULL,
        pattern_wilson_threshold REAL NOT NULL,
        wilson_z REAL NOT NULL,
        spreading_activation_decay REAL NOT NULL,
        spreading_activation_threshold REAL NOT NULL,
        min_activations_for_weight INTEGER NOT NULL,
        min_outcomes_for_weights INTEGER NOT NULL,
        last_calibration TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Create calibration_history table (from 007_calibration_history migration)
    db.exec(`
      CREATE TABLE IF NOT EXISTS calibration_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_count INTEGER NOT NULL,
        synapse_count INTEGER NOT NULL,
        learning_rate REAL NOT NULL,
        weaken_penalty REAL NOT NULL,
        decay_half_life_days INTEGER NOT NULL,
        pattern_extraction_interval INTEGER NOT NULL,
        pattern_min_samples INTEGER NOT NULL,
        pattern_wilson_threshold REAL NOT NULL,
        wilson_z REAL NOT NULL,
        spreading_activation_decay REAL NOT NULL,
        spreading_activation_threshold REAL NOT NULL,
        min_activations_for_weight INTEGER NOT NULL,
        min_outcomes_for_weights INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    repo = new CalibrationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // --- saveSnapshot ---

  describe('saveSnapshot', () => {
    it('stores a calibration snapshot', () => {
      const cal = makeCalibration();

      repo.saveSnapshot(cal, 100, 50);

      const rows = db.prepare('SELECT * FROM calibration_history').all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].trade_count).toBe(100);
      expect(rows[0].synapse_count).toBe(50);
    });

    it('preserves all calibration fields', () => {
      const cal = makeCalibration({
        learningRate: 0.15,
        weakenPenalty: 0.7,
        decayHalfLifeDays: 45,
        patternExtractionInterval: 120000,
        patternMinSamples: 10,
        patternWilsonThreshold: 0.6,
        wilsonZ: 2.58,
        spreadingActivationDecay: 0.5,
        spreadingActivationThreshold: 0.1,
        minActivationsForWeight: 5,
        minOutcomesForWeights: 20,
      });

      repo.saveSnapshot(cal, 200, 80);

      const rows = db.prepare('SELECT * FROM calibration_history').all() as any[];
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.learning_rate).toBeCloseTo(0.15);
      expect(row.weaken_penalty).toBeCloseTo(0.7);
      expect(row.decay_half_life_days).toBe(45);
      expect(row.pattern_extraction_interval).toBe(120000);
      expect(row.pattern_min_samples).toBe(10);
      expect(row.pattern_wilson_threshold).toBeCloseTo(0.6);
      expect(row.wilson_z).toBeCloseTo(2.58);
      expect(row.spreading_activation_decay).toBeCloseTo(0.5);
      expect(row.spreading_activation_threshold).toBeCloseTo(0.1);
      expect(row.min_activations_for_weight).toBe(5);
      expect(row.min_outcomes_for_weights).toBe(20);
      expect(row.trade_count).toBe(200);
      expect(row.synapse_count).toBe(80);
    });
  });

  // --- getHistory ---

  describe('getHistory', () => {
    it('returns snapshots in reverse chronological order', () => {
      const cal = makeCalibration();

      // Insert with explicit timestamps to guarantee ordering
      db.prepare(`
        INSERT INTO calibration_history (trade_count, synapse_count,
          learning_rate, weaken_penalty, decay_half_life_days,
          pattern_extraction_interval, pattern_min_samples, pattern_wilson_threshold,
          wilson_z, spreading_activation_decay, spreading_activation_threshold,
          min_activations_for_weight, min_outcomes_for_weights, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(10, 5, cal.learningRate, cal.weakenPenalty, cal.decayHalfLifeDays,
        cal.patternExtractionInterval, cal.patternMinSamples, cal.patternWilsonThreshold,
        cal.wilsonZ, cal.spreadingActivationDecay, cal.spreadingActivationThreshold,
        cal.minActivationsForWeight, cal.minOutcomesForWeights, '2026-01-01 00:00:00');

      db.prepare(`
        INSERT INTO calibration_history (trade_count, synapse_count,
          learning_rate, weaken_penalty, decay_half_life_days,
          pattern_extraction_interval, pattern_min_samples, pattern_wilson_threshold,
          wilson_z, spreading_activation_decay, spreading_activation_threshold,
          min_activations_for_weight, min_outcomes_for_weights, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(50, 20, cal.learningRate, cal.weakenPenalty, cal.decayHalfLifeDays,
        cal.patternExtractionInterval, cal.patternMinSamples, cal.patternWilsonThreshold,
        cal.wilsonZ, cal.spreadingActivationDecay, cal.spreadingActivationThreshold,
        cal.minActivationsForWeight, cal.minOutcomesForWeights, '2026-02-01 00:00:00');

      const history = repo.getHistory(10);

      expect(history).toHaveLength(2);
      // Most recent first
      expect(history[0].trade_count).toBe(50);
      expect(history[1].trade_count).toBe(10);
    });

    it('respects limit parameter', () => {
      const cal = makeCalibration();

      repo.saveSnapshot(cal, 10, 5);
      repo.saveSnapshot(cal, 20, 10);
      repo.saveSnapshot(cal, 30, 15);

      const history = repo.getHistory(2);

      expect(history).toHaveLength(2);
    });

    it('multiple snapshots with different trade_counts are stored correctly', () => {
      const cal = makeCalibration();

      repo.saveSnapshot(cal, 100, 50);
      repo.saveSnapshot(cal, 200, 75);
      repo.saveSnapshot(cal, 300, 100);

      const history = repo.getHistory(10);

      expect(history).toHaveLength(3);
      const tradeCounts = history.map((h) => h.trade_count);
      expect(tradeCounts).toContain(100);
      expect(tradeCounts).toContain(200);
      expect(tradeCounts).toContain(300);
    });
  });

  // --- save + get round-trip ---

  describe('save + get round-trip', () => {
    it('CalibrationRepository.save() + get() round-trip works', () => {
      const cal = makeCalibration({
        learningRate: 0.2,
        weakenPenalty: 0.75,
        decayHalfLifeDays: 60,
      });

      repo.save(cal);
      const loaded = repo.get();

      expect(loaded).not.toBeNull();
      expect(loaded!.learningRate).toBeCloseTo(0.2);
      expect(loaded!.weakenPenalty).toBeCloseTo(0.75);
      expect(loaded!.decayHalfLifeDays).toBe(60);
      expect(loaded!.patternExtractionInterval).toBe(cal.patternExtractionInterval);
      expect(loaded!.patternMinSamples).toBe(cal.patternMinSamples);
      expect(loaded!.patternWilsonThreshold).toBeCloseTo(cal.patternWilsonThreshold);
      expect(loaded!.wilsonZ).toBeCloseTo(cal.wilsonZ);
      expect(loaded!.spreadingActivationDecay).toBeCloseTo(cal.spreadingActivationDecay);
      expect(loaded!.spreadingActivationThreshold).toBeCloseTo(cal.spreadingActivationThreshold);
      expect(loaded!.minActivationsForWeight).toBe(cal.minActivationsForWeight);
      expect(loaded!.minOutcomesForWeights).toBe(cal.minOutcomesForWeights);
    });
  });
});
