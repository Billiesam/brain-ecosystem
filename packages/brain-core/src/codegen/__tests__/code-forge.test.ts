import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { CodeForge, runCodeForgeMigration } from '../code-forge.js';

describe('CodeForge', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('adds a pattern and retrieves it', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const id = forge.addPattern('retry logic', 4, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], 0.85);
    expect(id).toBeGreaterThan(0);

    const patterns = forge.extractPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe('retry logic');
    expect(patterns[0].occurrences).toBe(4);
  });

  it('generates a utility from a pattern', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const pattern = { id: 1, pattern: 'error handler', occurrences: 3, files: ['a.ts', 'b.ts'], similarity: 0.7 };
    const product = forge.generateUtility(pattern);
    expect(product.id).toBeGreaterThan(0);
    expect(product.type).toBe('utility');
    expect(product.status).toBe('generated');
    expect(product.files).toHaveLength(1);
  });

  it('scaffolds a project', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const product = forge.scaffoldProject('brain-plugin', { name: 'my-plugin' });
    expect(product.type).toBe('scaffold');
    expect(product.files.length).toBeGreaterThanOrEqual(3);
    expect(product.files.some(f => f.path.includes('package.json'))).toBe(true);
  });

  it('generates a test file', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const product = forge.generateTest('src/utils/retry.ts');
    expect(product.type).toBe('test');
    expect(product.files).toHaveLength(1);
    expect(product.files[0].path).toContain('__tests__');
  });

  it('applies a product', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const product = forge.scaffoldProject('template', { name: 'test-proj' });
    const result = forge.applyProduct(product.id);
    expect(result.success).toBe(true);

    const products = forge.getProducts('applied');
    expect(products).toHaveLength(1);
  });

  it('blocks apply on protected paths', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    forge.setGuardrailEngine({ isProtectedPath: (path: string) => path.includes('package.json') });

    const product = forge.scaffoldProject('template', { name: 'protected-proj' });
    const result = forge.applyProduct(product.id);
    expect(result.success).toBe(false);
  });

  it('rolls back a product', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const product = forge.scaffoldProject('template', { name: 'rollback-test' });
    forge.applyProduct(product.id);
    forge.rollback(product.id);

    const products = forge.getProducts('rolled_back');
    expect(products).toHaveLength(1);
  });

  it('auto-applies a selfmod proposal', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const mockSelfMod = { proposeModification: vi.fn(), applyModification: vi.fn() };
    forge.setSelfModificationEngine(mockSelfMod);

    const result = forge.autoApplyProposal(42);
    expect(result.success).toBe(true);
    expect(result.productId).toBeGreaterThan(0);
    expect(mockSelfMod.applyModification).toHaveBeenCalledWith(42);
  });

  it('handles auto-apply failure', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    forge.setSelfModificationEngine({
      proposeModification: vi.fn(),
      applyModification: vi.fn().mockImplementation(() => { throw new Error('Tests failed'); }),
    });

    const result = forge.autoApplyProposal(42);
    expect(result.success).toBe(false);
  });

  it('returns empty when no selfmod engine', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    const result = forge.autoApplyProposal(42);
    expect(result.success).toBe(false);
  });

  it('getStatus returns overview', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    forge.scaffoldProject('t1', { name: 'p1' });
    forge.generateTest('src/foo.ts');

    const status = forge.getStatus();
    expect(status.products).toBe(2);
    expect(status.applied).toBe(0);
  });

  it('migration is idempotent', () => {
    const forge = new CodeForge(db, { brainName: 'test' });
    forge.scaffoldProject('t1', { name: 'persist-test' });
    runCodeForgeMigration(db);
    const products = forge.getProducts();
    expect(products.length).toBeGreaterThanOrEqual(1);
  });
});
