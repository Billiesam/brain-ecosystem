import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PreventionService } from '../../../src/services/prevention.service.js';
import type { RuleRepository, RuleRecord } from '../../../src/db/repositories/rule.repository.js';
import type { AntipatternRepository } from '../../../src/db/repositories/antipattern.repository.js';
import type { SynapseManager } from '../../../src/synapses/synapse-manager.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeRule(overrides: Partial<RuleRecord> = {}): RuleRecord {
  return {
    id: 1,
    pattern: 'TypeError.*undefined',
    action: 'add null check',
    description: 'Null reference prevention',
    confidence: 0.8,
    occurrences: 5,
    active: 1,
    project_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('PreventionService — explainability', () => {
  let service: PreventionService;
  let ruleRepo: Record<string, ReturnType<typeof vi.fn>>;
  let antipatternRepo: Record<string, ReturnType<typeof vi.fn>>;
  let synapseManager: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    ruleRepo = {
      findActive: vi.fn(),
      getById: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      findByPattern: vi.fn(),
    };

    antipatternRepo = {
      findGlobal: vi.fn().mockReturnValue([]),
      findByProject: vi.fn().mockReturnValue([]),
    };

    synapseManager = {
      strengthen: vi.fn(),
    };

    service = new PreventionService(
      ruleRepo as unknown as RuleRepository,
      antipatternRepo as unknown as AntipatternRepository,
      synapseManager as unknown as SynapseManager,
    );
  });

  // --- listRules ---

  describe('listRules', () => {
    it('calls ruleRepo.findActive() and returns results', () => {
      const rules = [makeRule({ id: 1 }), makeRule({ id: 2, pattern: 'SyntaxError.*' })];
      ruleRepo.findActive.mockReturnValue(rules);

      const result = service.listRules();

      expect(ruleRepo.findActive).toHaveBeenCalledOnce();
      expect(result).toEqual(rules);
    });
  });

  // --- getRule ---

  describe('getRule', () => {
    it('returns rule when found', () => {
      const rule = makeRule({ id: 42 });
      ruleRepo.getById.mockReturnValue(rule);

      const result = service.getRule(42);

      expect(ruleRepo.getById).toHaveBeenCalledWith(42);
      expect(result).toEqual(rule);
    });

    it('returns undefined when not found', () => {
      ruleRepo.getById.mockReturnValue(undefined);

      const result = service.getRule(999);

      expect(ruleRepo.getById).toHaveBeenCalledWith(999);
      expect(result).toBeUndefined();
    });
  });

  // --- updateRule ---

  describe('updateRule', () => {
    it('calls ruleRepo.update() with correct params', () => {
      ruleRepo.getById.mockReturnValue(makeRule({ id: 10, confidence: 0.9 }));

      service.updateRule(10, { confidence: 0.9 });

      expect(ruleRepo.update).toHaveBeenCalledWith(10, { confidence: 0.9 });
    });

    it('returns updated rule', () => {
      const updated = makeRule({ id: 10, confidence: 0.95 });
      ruleRepo.getById.mockReturnValue(updated);

      const result = service.updateRule(10, { confidence: 0.95 });

      expect(result).toEqual(updated);
    });

    it('can change confidence', () => {
      const original = makeRule({ id: 5, confidence: 0.5 });
      const updated = makeRule({ id: 5, confidence: 0.9 });

      ruleRepo.getById.mockReturnValue(updated);

      const result = service.updateRule(5, { confidence: 0.9 });

      expect(ruleRepo.update).toHaveBeenCalledWith(5, { confidence: 0.9 });
      expect(result!.confidence).toBe(0.9);
    });

    it('can change active status (deactivate a rule)', () => {
      const deactivated = makeRule({ id: 7, active: 0 });
      ruleRepo.getById.mockReturnValue(deactivated);

      const result = service.updateRule(7, { active: 0 });

      expect(ruleRepo.update).toHaveBeenCalledWith(7, { active: 0 });
      expect(result!.active).toBe(0);
    });
  });

  // --- checkRules (existing functionality) ---

  describe('checkRules', () => {
    it('matches regex patterns', () => {
      const rules = [
        makeRule({ id: 1, pattern: 'TypeError.*undefined', confidence: 0.8, action: 'add null check' }),
        makeRule({ id: 2, pattern: 'SyntaxError.*unexpected', confidence: 0.6, action: 'fix syntax' }),
      ];
      ruleRepo.findActive.mockReturnValue(rules);

      const results = service.checkRules('TypeError', "Cannot read properties of undefined");

      expect(results).toHaveLength(1);
      expect(results[0].ruleId).toBe(1);
      expect(results[0].matched).toBe(true);
      expect(results[0].action).toBe('add null check');
      expect(results[0].confidence).toBe(0.8);
    });
  });

  // --- createRule ---

  describe('createRule', () => {
    it('creates with default confidence 0.5', () => {
      ruleRepo.create.mockReturnValue(100);

      const id = service.createRule({
        pattern: 'ReferenceError.*not defined',
        action: 'check imports',
      });

      expect(id).toBe(100);
      expect(ruleRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          pattern: 'ReferenceError.*not defined',
          action: 'check imports',
          confidence: 0.5,
          description: null,
          occurrences: 0,
          active: 1,
          project_id: null,
        }),
      );
    });
  });
});
