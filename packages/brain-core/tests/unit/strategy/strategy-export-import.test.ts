import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { StrategyForge, runStrategyForgeMigration } from '../../../src/strategy/strategy-forge.js';
import { StrategyExporter } from '../../../src/strategy/strategy-exporter.js';
import { StrategyImporter } from '../../../src/strategy/strategy-importer.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('StrategyExporter + StrategyImporter', () => {
  let db: Database.Database;
  let forge: StrategyForge;
  let exporter: StrategyExporter;
  let importer: StrategyImporter;

  beforeEach(() => {
    db = new Database(':memory:');
    forge = new StrategyForge(db, { brainName: 'test-brain' });
    exporter = new StrategyExporter(forge);
    importer = new StrategyImporter(forge);
  });

  afterEach(() => { db.close(); });

  it('exports a strategy as valid JSON', () => {
    const strategy = forge.importStrategy('trade', 'RSI-Cross-v1', 'RSI crossover strategy', [
      { condition: 'rsi_above_70', action: 'sell', confidence: 0.8, source: 'test' },
    ]);
    const json = exporter.export(strategy.id);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe('1.0.0');
    expect(parsed.source).toBe('test-brain');
    expect(parsed.strategy.name).toBe('RSI-Cross-v1');
    expect(parsed.strategy.type).toBe('trade');
    expect(parsed.strategy.rules).toHaveLength(1);
    expect(parsed.exportedAt).toBeDefined();
  });

  it('roundtrips export → import', () => {
    const original = forge.importStrategy('trade', 'Momentum-v1', 'Momentum strategy', [
      { condition: 'price_breakout', action: 'buy', confidence: 0.7, source: 'test' },
      { condition: 'stop_loss_hit', action: 'sell', confidence: 0.9, source: 'test' },
    ]);
    const json = exporter.export(original.id);

    // Import into same DB under different name
    const modified = JSON.parse(json);
    modified.strategy.name = 'Momentum-v1-imported';
    const result = importer.import(JSON.stringify(modified));

    expect(result.success).toBe(true);
    expect(result.strategyName).toBe('Momentum-v1-imported');

    const imported = forge.getStrategy(result.strategyId!);
    expect(imported).not.toBeNull();
    expect(imported!.rules).toHaveLength(2);
    expect(imported!.status).toBe('draft');
  });

  it('rejects duplicate strategy name', () => {
    forge.importStrategy('trade', 'Unique-Name', 'Test', [
      { condition: 'test', action: 'buy', confidence: 0.5, source: 'test' },
    ]);

    const json = JSON.stringify({
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      source: 'other-brain',
      strategy: { name: 'Unique-Name', type: 'trade', description: 'Duplicate', rules: [{ condition: 'x', action: 'y', confidence: 0.5, source: 'z' }], performance: {}, lineage: {} },
    });

    const result = importer.import(json);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('rejects invalid JSON', () => {
    const result = importer.import('not json');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON');
  });

  it('rejects missing version', () => {
    const result = importer.import(JSON.stringify({ strategy: { name: 'test', type: 'trade', rules: [] } }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('version');
  });

  it('rejects invalid strategy type', () => {
    const result = importer.import(JSON.stringify({
      version: '1.0.0',
      strategy: { name: 'test', type: 'invalid', description: 'x', rules: [] },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid strategy.type');
  });

  it('rejects rules without condition/action', () => {
    const result = importer.import(JSON.stringify({
      version: '1.0.0',
      strategy: { name: 'test-bad-rules', type: 'trade', description: 'x', rules: [{ confidence: 0.5 }] },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('condition and action');
  });

  it('throws for non-existent strategy export', () => {
    expect(() => exporter.export(999)).toThrow('not found');
  });
});
