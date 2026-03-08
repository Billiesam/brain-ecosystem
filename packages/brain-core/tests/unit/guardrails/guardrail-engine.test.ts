import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { GuardrailEngine, runGuardrailMigration } from '../../../src/guardrails/guardrail-engine.js';
import { ParameterRegistry, runParameterRegistryMigration } from '../../../src/metacognition/parameter-registry.js';

describe('GuardrailEngine', () => {
  let db: Database.Database;
  let engine: GuardrailEngine;
  let registry: ParameterRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    runParameterRegistryMigration(db);
    registry = new ParameterRegistry(db);
    registry.register({ engine: 'dream', name: 'interval', value: 300000, min: 60000, max: 600000, description: 'Dream interval' });
    registry.register({ engine: 'prediction', name: 'alpha', value: 0.3, min: 0.1, max: 0.9, description: 'EWMA alpha' });

    engine = new GuardrailEngine(db, { brainName: 'test' });
    engine.setParameterRegistry(registry);
  });

  describe('validateParameterChange', () => {
    it('allows reasonable changes', () => {
      const result = engine.validateParameterChange('dream:interval', 300000, 350000);
      expect(result.allowed).toBe(true);
    });

    it('rejects out-of-bounds values', () => {
      const result = engine.validateParameterChange('dream:interval', 300000, 700000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('out of bounds');
    });

    it('rejects extreme jumps (>50% of range)', () => {
      // Range is 600000-60000 = 540000. Jump of 300000 = 55% of range
      const result = engine.validateParameterChange('dream:interval', 100000, 400000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('too large');
    });

    it('blocks changes when circuit breaker tripped', () => {
      engine.tripCircuitBreaker('test reason');
      const result = engine.validateParameterChange('dream:interval', 300000, 310000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Circuit breaker');
    });
  });

  describe('checkFitnessDelta', () => {
    it('accepts improvement above threshold', () => {
      expect(engine.checkFitnessDelta(0.5, 0.52)).toBe(true);
    });

    it('rejects improvement below threshold', () => {
      expect(engine.checkFitnessDelta(0.5, 0.505)).toBe(false);
    });

    it('rejects decline', () => {
      expect(engine.checkFitnessDelta(0.5, 0.4)).toBe(false);
    });
  });

  describe('isProtectedPath', () => {
    it('protects IPC paths', () => {
      expect(engine.isProtectedPath('packages/brain-core/src/ipc/server.ts')).toBe(true);
    });

    it('protects guardrails paths', () => {
      expect(engine.isProtectedPath('src/guardrails/guardrail-engine.ts')).toBe(true);
    });

    it('allows normal source paths', () => {
      expect(engine.isProtectedPath('packages/brain-core/src/dream/dream-engine.ts')).toBe(false);
    });
  });

  describe('parameter changelog & rollback', () => {
    it('records and rolls back parameter changes', () => {
      engine.recordParameterChange('prediction:alpha', 0.3, 0.4, 0.5, 0.6, 1);
      const result = engine.rollbackParameters(1);
      expect(result.rolledBack).toBe(1);
      expect(result.parameters[0].from).toBe(0.4);
      expect(result.parameters[0].to).toBe(0.3);
    });
  });

  describe('circuit breaker', () => {
    it('can be tripped and reset', () => {
      expect(engine.isCircuitBreakerTripped()).toBe(false);
      engine.tripCircuitBreaker('test');
      expect(engine.isCircuitBreakerTripped()).toBe(true);
      engine.resetCircuitBreaker();
      expect(engine.isCircuitBreakerTripped()).toBe(false);
    });
  });

  describe('checkHealth', () => {
    it('returns healthy report with no issues', () => {
      const report = engine.checkHealth();
      expect(report.score).toBeGreaterThan(0);
      expect(report.circuitBreakerTripped).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('returns status summary', () => {
      const status = engine.getStatus();
      expect(status.circuitBreakerTripped).toBe(false);
      expect(status.protectedPaths.length).toBeGreaterThan(0);
      expect(typeof status.healthScore).toBe('number');
    });
  });

  describe('checkAutoRollback', () => {
    it('returns null when not enough data', () => {
      expect(engine.checkAutoRollback()).toBeNull();
    });

    it('detects declining fitness and triggers rollback', () => {
      // Insert declining fitness history (most recent first in DESC order)
      // We need declineThreshold+1 = 4 entries with declining fitness
      engine.recordParameterChange('prediction:alpha', 0.3, 0.35, 0.6, 0.55, 1);
      engine.recordParameterChange('prediction:alpha', 0.35, 0.4, 0.55, 0.5, 2);
      engine.recordParameterChange('prediction:alpha', 0.4, 0.45, 0.5, 0.45, 3);
      engine.recordParameterChange('prediction:alpha', 0.45, 0.5, 0.45, 0.4, 4);

      const result = engine.checkAutoRollback();
      expect(result).not.toBeNull();
      expect(result!.rolledBack).toBeGreaterThan(0);
    });
  });
});
