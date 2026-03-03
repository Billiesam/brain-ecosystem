import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ResearchOrchestrator } from '../../../src/research/research-orchestrator.js';

describe('Self-Improvement Suggestions', () => {
  let db: Database.Database;
  let orch: ResearchOrchestrator;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    orch = new ResearchOrchestrator(db, { brainName: 'test' });
  });

  describe('getInstalledCapabilities', () => {
    it('reports all engines as missing when none are set', () => {
      const caps = orch.getInstalledCapabilities();
      expect(caps.missing).toContain('dreamEngine');
      expect(caps.missing).toContain('goalEngine');
      expect(caps.missing).toContain('memoryPalace');
      expect(caps.missing).toContain('selfTestEngine');
      expect(caps.installed).toHaveLength(0);
      expect(caps.missing.length).toBe(18);
    });
  });

  describe('generateDynamicMetaSuggestions (Phase 3)', () => {
    // Access private method for unit testing
    function callDynamic(o: ResearchOrchestrator, summary: Record<string, unknown>) {
      return (o as unknown as { generateDynamicMetaSuggestions(s: Record<string, unknown>): Array<{ key: string; suggestion: string; alternatives: string[]; priority: number }> }).generateDynamicMetaSuggestions(summary);
    }

    it('does NOT generate build_* suggestions', () => {
      const summary = orch.getSummary();
      const suggestions = callDynamic(orch, summary);
      const buildKeys = suggestions.filter(s => s.key.startsWith('build_'));
      expect(buildKeys).toHaveLength(0);
    });

    it('generates performance suggestion when MetaCognition shows D/F grades', () => {
      // Mock metaCognitionLayer with poor report cards
      const mockMCL = {
        getStatus: () => ({
          totalEngines: 5,
          reportCards: [
            { engine: 'anomalyDetective', grade: 'F', combined_score: 0.15, health_score: 0.1, value_score: 0.2, signal_to_noise: 0.1, evaluated_at: Date.now() },
            { engine: 'selfObserver', grade: 'A', combined_score: 0.95, health_score: 0.9, value_score: 1.0, signal_to_noise: 0.9, evaluated_at: Date.now() },
          ],
          recentAdjustments: [],
          cycleMetrics: 10,
          latestTrend: null,
          trendDirection: 'stagnating',
        }),
      };
      (orch as unknown as { metaCognitionLayer: unknown }).metaCognitionLayer = mockMCL;

      const summary = orch.getSummary();
      const suggestions = callDynamic(orch, summary);
      const perfSuggestion = suggestions.find(s => s.key.startsWith('meta_poor_'));
      expect(perfSuggestion).toBeDefined();
      expect(perfSuggestion!.suggestion).toContain('anomalyDetective');
      expect(perfSuggestion!.suggestion).toContain('grade F');
    });

    it('generates goal suggestion when goals stagnate', () => {
      const mockGoalEngine = {
        getStatus: () => ({
          totalGoals: 2,
          activeGoals: 2,
          achievedGoals: 0,
          failedGoals: 0,
          pausedGoals: 0,
          recentAchievements: [],
          topActive: [
            { title: 'Reach 80% accuracy', metricName: 'prediction_accuracy', currentValue: 0.02, targetValue: 0.8, status: 'active', priority: 1, description: '', type: 'metric_target', baselineValue: 0, deadlineCycles: 100, startedCycle: 1, createdAt: '', achievedAt: null },
          ],
          uptime: 100000,
        }),
      };
      (orch as unknown as { goalEngine: unknown }).goalEngine = mockGoalEngine;

      const summary = orch.getSummary();
      const suggestions = callDynamic(orch, summary);
      const goalSuggestion = suggestions.find(s => s.key.startsWith('goal_stagnating_'));
      expect(goalSuggestion).toBeDefined();
      expect(goalSuggestion!.suggestion).toContain('making progress');
    });

    it('generates selftest suggestion when many tests fail', () => {
      const mockSelfTest = {
        getStatus: () => ({
          totalTests: 10,
          confirmed: 2,
          contradicted: 7,
          inconclusive: 1,
          avgDepth: 0.3,
        }),
      };
      (orch as unknown as { selfTestEngine: unknown }).selfTestEngine = mockSelfTest;

      const summary = orch.getSummary();
      const suggestions = callDynamic(orch, summary);
      const stSuggestion = suggestions.find(s => s.key === 'selftest_failures');
      expect(stSuggestion).toBeDefined();
      expect(stSuggestion!.suggestion).toContain('7 of 10');
    });

    it('generates existential fallback when all engines are healthy', () => {
      // No engines set → no data-driven suggestions → fallback
      const summary = orch.getSummary();
      const suggestions = callDynamic(orch, summary);
      const existential = suggestions.find(s => s.key.startsWith('existential_'));
      expect(existential).toBeDefined();
      expect(existential!.priority).toBe(3);
    });
  });

  describe('Dream check (Phase 1)', () => {
    function callSuggestions(o: ResearchOrchestrator): string[] {
      return (o as unknown as { generateSelfImprovementSuggestions(): string[] }).generateSelfImprovementSuggestions();
    }

    it('does NOT trigger no_dreams when dream has actual consolidated memories', () => {
      // Simulate cycleCount > 30
      (orch as unknown as { cycleCount: number }).cycleCount = 35;

      const mockDream = {
        getStatus: () => ({
          running: false,
          totalCycles: 5,
          lastDreamAt: Date.now(),
          totals: { memoriesConsolidated: 12, synapsesPruned: 3, memoriesArchived: 1 },
        }),
      };
      (orch as unknown as { dreamEngine: unknown }).dreamEngine = mockDream;

      const suggestions = callSuggestions(orch);
      const dreamBroken = suggestions.find(s => s.includes('consolidated 0 memories') || s.includes('produce nothing'));
      expect(dreamBroken).toBeUndefined();
    });

    it('triggers no_dreams when dream ran but consolidated nothing', () => {
      (orch as unknown as { cycleCount: number }).cycleCount = 35;

      const mockDream = {
        getStatus: () => ({
          running: false,
          totalCycles: 5,
          lastDreamAt: Date.now(),
          totals: { memoriesConsolidated: 0, synapsesPruned: 0, memoriesArchived: 0 },
        }),
      };
      (orch as unknown as { dreamEngine: unknown }).dreamEngine = mockDream;

      const suggestions = callSuggestions(orch);
      const dreamBroken = suggestions.find(s => s.includes('consolidated 0 memories'));
      expect(dreamBroken).toBeDefined();
    });
  });
});
