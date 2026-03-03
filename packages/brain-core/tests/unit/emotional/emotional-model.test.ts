import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EmotionalModel } from '../../../src/emotional/emotional-model.js';

describe('EmotionalModel', () => {
  let db: Database.Database;
  let model: EmotionalModel;

  beforeEach(() => {
    db = new Database(':memory:');
    model = new EmotionalModel(db, { brainName: 'test-brain' });
  });

  // ── Table creation ────────────────────────────────────

  it('should create tables on construction', () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('emotional_state', 'mood_influences')",
    ).all() as { name: string }[];
    const names = tables.map(t => t.name).sort();
    expect(names).toContain('emotional_state');
    expect(names).toContain('mood_influences');
  });

  // ── getStatus ─────────────────────────────────────────

  it('should return default status initially', () => {
    const status = model.getStatus();
    expect(status.brainName).toBe('test-brain');
    expect(status.historyCount).toBe(0);
    expect(status.influenceCount).toBe(0);
    expect(status.cycleCount).toBe(0);
    expect(status.lastSenseTime).toBeNull();
    expect(status.uptime).toBeGreaterThanOrEqual(0);
  });

  // ── getDimensions ─────────────────────────────────────

  it('should return default dimensions', () => {
    const dims = model.getDimensions();
    expect(dims.frustration).toBe(0);
    expect(dims.curiosity).toBe(0.3);
    expect(dims.surprise).toBe(0.2);
    expect(dims.confidence).toBe(0.5);
    expect(dims.satisfaction).toBe(0.5);
    expect(dims.stress).toBe(0);
    expect(dims.momentum).toBe(0.5);
    expect(dims.creativity).toBe(0.5);
  });

  // ── getMood ───────────────────────────────────────────

  it('should return a valid mood with default dimensions', () => {
    const mood = model.getMood();
    expect(mood.mood).toBeTruthy();
    expect(mood.score).toBeGreaterThanOrEqual(0);
    expect(mood.score).toBeLessThanOrEqual(1);
    expect(mood.dimensions).toBeDefined();
    expect(typeof mood.valence).toBe('number');
    expect(typeof mood.arousal).toBe('number');
  });

  it('should detect reflective mood at default state', () => {
    // Default: mid confidence, mid satisfaction, low stress, low frustration
    const mood = model.getMood();
    expect(['reflective', 'flow']).toContain(mood.mood);
  });

  // ── sense ─────────────────────────────────────────────

  it('should update dimensions after sense()', () => {
    model.setDataSources({
      getAutoResponderStatus: () => ({
        totalResponses: 10, successRate: 0.3,
        recentSeverity: ['critical', 'high', 'high'],
      }),
    });

    model.sense();
    const dims = model.getDimensions();
    // Frustration should be elevated (low success rate + high severity)
    expect(dims.frustration).toBeGreaterThan(0);
  });

  it('should persist state to DB after sense()', () => {
    model.sense();
    const count = (db.prepare('SELECT COUNT(*) as c FROM emotional_state').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('should increment cycle count with each sense()', () => {
    model.sense();
    model.sense();
    model.sense();
    const status = model.getStatus();
    expect(status.cycleCount).toBe(3);
  });

  it('should apply smoothing decay on consecutive sense() calls', () => {
    model.setDataSources({
      getCuriosityStatus: () => ({ activeGaps: 20, avgGapScore: 0.9, explorationRate: 0.8 }),
    });

    model.sense();
    const first = model.getDimensions().curiosity;

    // Remove source → raw curiosity goes to baseline 0.3
    model.setDataSources({});
    model.sense();
    const second = model.getDimensions().curiosity;

    // Should decay toward baseline but not jump instantly
    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(0);
  });

  it('should set lastSenseTime after sense()', () => {
    model.sense();
    expect(model.getStatus().lastSenseTime).not.toBeNull();
  });

  // ── sense: frustration ────────────────────────────────

  it('should sense high frustration from low success rate + critical severity', () => {
    model.setDataSources({
      getAutoResponderStatus: () => ({
        totalResponses: 20, successRate: 0.1,
        recentSeverity: ['critical', 'critical', 'high'],
      }),
    });

    model.sense();
    expect(model.getDimensions().frustration).toBeGreaterThan(0.1);
  });

  // ── sense: curiosity ──────────────────────────────────

  it('should sense high curiosity from many knowledge gaps', () => {
    model.setDataSources({
      getCuriosityStatus: () => ({ activeGaps: 15, avgGapScore: 0.8, explorationRate: 0.7 }),
    });

    model.sense();
    expect(model.getDimensions().curiosity).toBeGreaterThan(0.1);
  });

  // ── sense: confidence ─────────────────────────────────

  it('should sense confidence from hypothesis + prediction accuracy', () => {
    model.setDataSources({
      getHypothesisConfidence: () => ({ avgConfidence: 0.85, confirmedRate: 0.7 }),
      getPredictionAccuracy: () => 0.8,
    });

    model.sense();
    expect(model.getDimensions().confidence).toBeGreaterThan(0.5);
  });

  // ── sense: stress ─────────────────────────────────────

  it('should sense stress from attention urgency and bursts', () => {
    model.setDataSources({
      getAttentionStatus: () => ({ avgUrgency: 0.9, burstCount: 8, contextSwitches: 15 }),
    });

    model.sense();
    expect(model.getDimensions().stress).toBeGreaterThan(0.1);
  });

  // ── sense: satisfaction ───────────────────────────────

  it('should sense satisfaction from report cards', () => {
    model.setDataSources({
      getReportCards: () => [
        { combined_score: 0.9 },
        { combined_score: 0.85 },
        { combined_score: 0.95 },
      ],
    });

    model.sense();
    expect(model.getDimensions().satisfaction).toBeGreaterThan(0.5);
  });

  // ── sense: creativity ─────────────────────────────────

  it('should sense creativity from reasoning chains + hypotheses + debates', () => {
    model.setDataSources({
      getReasoningChainCount: () => 30,
      getCreativeHypothesisCount: () => 10,
      getDebateCount: () => 5,
    });

    model.sense();
    expect(model.getDimensions().creativity).toBeGreaterThan(0.1);
  });

  // ── mood_influences ───────────────────────────────────

  it('should log influences for significant changes', () => {
    // Big jump from 0 frustration to high frustration
    model.setDataSources({
      getAutoResponderStatus: () => ({
        totalResponses: 20, successRate: 0.0,
        recentSeverity: ['critical', 'critical', 'critical'],
      }),
    });

    model.sense();
    const influences = model.getInfluences();
    // Should have at least frustration influence since it jumps from 0
    expect(influences.length).toBeGreaterThanOrEqual(1);
    const frustInf = influences.find(i => i.dimension === 'frustration');
    if (frustInf) {
      expect(frustInf.delta).toBeGreaterThan(0);
      expect(frustInf.source_engine).toBe('AutoResponder');
    }
  });

  // ── getHistory ────────────────────────────────────────

  it('should return emotional history entries', () => {
    model.sense();
    model.sense();
    const history = model.getHistory(10);
    expect(history.length).toBe(2);
    expect(history[0]!.cycle_number).toBe(2); // DESC order
    expect(history[1]!.cycle_number).toBe(1);
    expect(history[0]!.dominant_mood).toBeTruthy();
  });

  // ── getRecommendations ────────────────────────────────

  it('should return recommendations for current mood', () => {
    const recs = model.getRecommendations();
    expect(Array.isArray(recs)).toBe(true);
    expect(recs.length).toBeGreaterThan(0);
    expect(typeof recs[0]).toBe('string');
  });

  it('should return anxious recommendations when stressed', () => {
    model.setDataSources({
      getAttentionStatus: () => ({ avgUrgency: 0.95, burstCount: 10, contextSwitches: 20 }),
      getAutoResponderStatus: () => ({
        totalResponses: 10, successRate: 0.1,
        recentSeverity: ['critical', 'critical'],
      }),
    });
    // Sense multiple times to build up stress+frustration
    for (let i = 0; i < 5; i++) model.sense();
    const mood = model.getMood();
    // Should be anxious or determined given high stress+frustration
    expect(['anxious', 'determined']).toContain(mood.mood);
  });

  // ── Multiple data sources combined ────────────────────

  it('should handle all data sources simultaneously', () => {
    model.setDataSources({
      getAutoResponderStatus: () => ({ totalResponses: 5, successRate: 0.8, recentSeverity: ['low'] }),
      getCuriosityStatus: () => ({ activeGaps: 5, avgGapScore: 0.5, explorationRate: 0.4 }),
      getEmergenceStatus: () => ({ recentEvents: 3, avgSurprise: 0.6 }),
      getHypothesisConfidence: () => ({ avgConfidence: 0.7, confirmedRate: 0.6 }),
      getPredictionAccuracy: () => 0.75,
      getReportCards: () => [{ combined_score: 0.8 }],
      getAttentionStatus: () => ({ avgUrgency: 0.3, burstCount: 1, contextSwitches: 3 }),
      getMetaTrend: () => ({ learningRate: 0.5, discoveryRate: 0.4, direction: 'improving' }),
      getReasoningChainCount: () => 20,
      getCreativeHypothesisCount: () => 8,
      getDebateCount: () => 4,
    });

    model.sense();
    const dims = model.getDimensions();

    // All dimensions should have values
    expect(dims.frustration).toBeGreaterThanOrEqual(0);
    expect(dims.curiosity).toBeGreaterThan(0);
    expect(dims.surprise).toBeGreaterThan(0);
    expect(dims.confidence).toBeGreaterThan(0);
    expect(dims.satisfaction).toBeGreaterThan(0);
    expect(dims.stress).toBeGreaterThanOrEqual(0);
    expect(dims.momentum).toBeGreaterThan(0);
    expect(dims.creativity).toBeGreaterThan(0);

    const status = model.getStatus();
    expect(status.historyCount).toBe(1);
    expect(status.currentMood.mood).toBeTruthy();
  });

  // ── Edge cases ────────────────────────────────────────

  it('should handle empty data sources gracefully', () => {
    model.setDataSources({});
    model.sense();
    const dims = model.getDimensions();
    // Defaults should be maintained
    expect(dims.frustration).toBe(0);
    expect(dims.stress).toBe(0);
  });

  it('should clamp dimensions between 0 and 1', () => {
    model.setDataSources({
      getAutoResponderStatus: () => ({
        totalResponses: 100, successRate: 0.0,
        recentSeverity: ['critical', 'critical', 'critical', 'critical', 'critical'],
      }),
      getAttentionStatus: () => ({ avgUrgency: 1.0, burstCount: 100, contextSwitches: 100 }),
    });

    for (let i = 0; i < 10; i++) model.sense();
    const dims = model.getDimensions();

    for (const value of Object.values(dims)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
