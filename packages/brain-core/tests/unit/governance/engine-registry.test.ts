import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { EngineRegistry, runEngineRegistryMigration, getDefaultEngineProfiles } from '../../../src/governance/engine-registry.js';
import type { EngineProfile } from '../../../src/governance/engine-registry.js';

describe('EngineRegistry', () => {
  let db: Database.Database;
  let registry: EngineRegistry;

  beforeEach(() => {
    db = new Database(':memory:');
    registry = new EngineRegistry(db);
  });

  const makeProfile = (overrides: Partial<EngineProfile> = {}): EngineProfile => ({
    id: 'test_engine',
    reads: ['insights'],
    writes: ['test_output'],
    emits: ['test:emitting'],
    subscribes: [],
    frequency: 'every_cycle',
    frequencyN: 1,
    riskClass: 'low',
    expectedEffects: ['test effect'],
    invariants: ['count >= 0'],
    enabled: true,
    ...overrides,
  });

  describe('register', () => {
    it('registers a new engine profile', () => {
      registry.register(makeProfile());
      expect(registry.get('test_engine')).toBeDefined();
      expect(registry.get('test_engine')!.reads).toEqual(['insights']);
    });

    it('updates existing profile on re-register', () => {
      registry.register(makeProfile());
      registry.register(makeProfile({ riskClass: 'high' }));
      expect(registry.get('test_engine')!.riskClass).toBe('high');
    });

    it('persists to database', () => {
      registry.register(makeProfile());
      // Create new instance to verify DB persistence
      const registry2 = new EngineRegistry(db);
      expect(registry2.get('test_engine')).toBeDefined();
      expect(registry2.get('test_engine')!.riskClass).toBe('low');
    });
  });

  describe('list', () => {
    it('returns all registered profiles', () => {
      registry.register(makeProfile({ id: 'engine_a' }));
      registry.register(makeProfile({ id: 'engine_b' }));
      expect(registry.list()).toHaveLength(2);
    });

    it('returns empty array when no profiles', () => {
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe('listEnabled', () => {
    it('only returns enabled profiles', () => {
      registry.register(makeProfile({ id: 'enabled_one', enabled: true }));
      registry.register(makeProfile({ id: 'disabled_one', enabled: false }));
      const enabled = registry.listEnabled();
      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe('enabled_one');
    });
  });

  describe('enable / disable', () => {
    it('disables an engine', () => {
      registry.register(makeProfile());
      registry.disable('test_engine');
      expect(registry.get('test_engine')!.enabled).toBe(false);
    });

    it('re-enables a disabled engine', () => {
      registry.register(makeProfile({ enabled: false }));
      registry.enable('test_engine');
      expect(registry.get('test_engine')!.enabled).toBe(true);
    });

    it('persists enable/disable state', () => {
      registry.register(makeProfile());
      registry.disable('test_engine');
      const registry2 = new EngineRegistry(db);
      expect(registry2.get('test_engine')!.enabled).toBe(false);
    });

    it('ignores unknown engine id', () => {
      registry.disable('nonexistent'); // should not throw
      registry.enable('nonexistent');
    });
  });

  describe('getDependencyGraph', () => {
    it('builds dependency edges from reads/writes overlap', () => {
      registry.register(makeProfile({ id: 'producer', reads: [], writes: ['data_x'] }));
      registry.register(makeProfile({ id: 'consumer', reads: ['data_x'], writes: [] }));

      const graph = registry.getDependencyGraph();
      expect(graph.get('consumer')).toContain('producer');
      expect(graph.get('producer')).toEqual([]);
    });

    it('handles no dependencies', () => {
      registry.register(makeProfile({ id: 'standalone', reads: ['a'], writes: ['b'] }));
      const graph = registry.getDependencyGraph();
      expect(graph.get('standalone')).toEqual([]);
    });

    it('detects bidirectional dependencies', () => {
      registry.register(makeProfile({ id: 'a', reads: ['x'], writes: ['y'] }));
      registry.register(makeProfile({ id: 'b', reads: ['y'], writes: ['x'] }));
      const graph = registry.getDependencyGraph();
      expect(graph.get('a')).toContain('b');
      expect(graph.get('b')).toContain('a');
    });
  });

  describe('getReverseDependencyGraph', () => {
    it('shows who depends on each engine', () => {
      registry.register(makeProfile({ id: 'producer', reads: [], writes: ['data_x'] }));
      registry.register(makeProfile({ id: 'consumer1', reads: ['data_x'], writes: [] }));
      registry.register(makeProfile({ id: 'consumer2', reads: ['data_x'], writes: [] }));

      const reverse = registry.getReverseDependencyGraph();
      expect(reverse.get('producer')).toContain('consumer1');
      expect(reverse.get('producer')).toContain('consumer2');
    });
  });

  describe('getStatus', () => {
    it('returns correct status summary', () => {
      registry.register(makeProfile({ id: 'low1', riskClass: 'low', enabled: true }));
      registry.register(makeProfile({ id: 'high1', riskClass: 'high', enabled: true }));
      registry.register(makeProfile({ id: 'med1', riskClass: 'medium', enabled: false }));

      const status = registry.getStatus();
      expect(status.totalEngines).toBe(3);
      expect(status.enabledEngines).toBe(2);
      expect(status.disabledEngines).toBe(1);
      expect(status.riskDistribution.low).toBe(1);
      expect(status.riskDistribution.high).toBe(1);
      expect(status.riskDistribution.medium).toBe(1);
    });

    it('counts dependency edges', () => {
      registry.register(makeProfile({ id: 'a', reads: [], writes: ['x'] }));
      registry.register(makeProfile({ id: 'b', reads: ['x'], writes: ['y'] }));
      registry.register(makeProfile({ id: 'c', reads: ['y'], writes: [] }));
      // b depends on a, c depends on b = 2 edges
      expect(registry.getStatus().dependencyEdges).toBe(2);
    });
  });

  describe('getByRisk', () => {
    it('filters by risk class', () => {
      registry.register(makeProfile({ id: 'low1', riskClass: 'low' }));
      registry.register(makeProfile({ id: 'high1', riskClass: 'high' }));
      registry.register(makeProfile({ id: 'high2', riskClass: 'high' }));
      expect(registry.getByRisk('high')).toHaveLength(2);
      expect(registry.getByRisk('low')).toHaveLength(1);
    });
  });

  describe('findWriters / findReaders', () => {
    it('finds engines writing to a resource', () => {
      registry.register(makeProfile({ id: 'w1', writes: ['insights'] }));
      registry.register(makeProfile({ id: 'w2', writes: ['anomalies'] }));
      expect(registry.findWriters('insights').map(p => p.id)).toEqual(['w1']);
    });

    it('finds engines reading from a resource', () => {
      registry.register(makeProfile({ id: 'r1', reads: ['insights', 'anomalies'] }));
      registry.register(makeProfile({ id: 'r2', reads: ['anomalies'] }));
      expect(registry.findReaders('anomalies').map(p => p.id)).toEqual(['r1', 'r2']);
    });
  });

  describe('getDefaultEngineProfiles', () => {
    it('returns 25 profiles', () => {
      const profiles = getDefaultEngineProfiles();
      expect(profiles.length).toBe(25);
    });

    it('all profiles have required fields', () => {
      const profiles = getDefaultEngineProfiles();
      for (const p of profiles) {
        expect(p.id).toBeTruthy();
        expect(Array.isArray(p.reads)).toBe(true);
        expect(Array.isArray(p.writes)).toBe(true);
        expect(['low', 'medium', 'high']).toContain(p.riskClass);
        expect(['every_cycle', 'every_N', 'on_demand']).toContain(p.frequency);
      }
    });

    it('registers all defaults without error', () => {
      const profiles = getDefaultEngineProfiles();
      for (const p of profiles) {
        registry.register(p);
      }
      expect(registry.list()).toHaveLength(25);
    });
  });

  describe('runEngineRegistryMigration', () => {
    it('is idempotent', () => {
      const db2 = new Database(':memory:');
      runEngineRegistryMigration(db2);
      runEngineRegistryMigration(db2);
      // No error = pass
      expect(true).toBe(true);
    });
  });
});
