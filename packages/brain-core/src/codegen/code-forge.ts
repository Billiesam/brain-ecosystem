import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ──────────────────────────────────────────────────

export interface CodeProduct {
  id: number;
  type: 'utility' | 'refactor' | 'scaffold' | 'fix' | 'test';
  name: string;
  description: string;
  files: Array<{ path: string; content: string; action: 'create' | 'modify' }>;
  sourcePattern?: string;
  testsPassed?: boolean;
  status: 'generated' | 'tested' | 'applied' | 'failed' | 'rolled_back';
  createdAt?: string;
}

export interface CodePattern {
  id: number;
  pattern: string;
  occurrences: number;
  files: string[];
  similarity: number;
}

export interface CodeForgeConfig {
  brainName: string;
  autoApplyEnabled?: boolean;
  minSimilarityForPattern?: number;
}

export interface CodeForgeStatus {
  patterns: number;
  products: number;
  applied: number;
  successRate: number;
}

// ── Migration ──────────────────────────────────────────────

export function runCodeForgeMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      files TEXT DEFAULT '[]',
      source_pattern TEXT,
      tests_passed INTEGER,
      status TEXT DEFAULT 'generated',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_codeproduct_status ON code_products(status);
    CREATE INDEX IF NOT EXISTS idx_codeproduct_type ON code_products(type);

    CREATE TABLE IF NOT EXISTS code_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL,
      occurrences INTEGER DEFAULT 1,
      files TEXT DEFAULT '[]',
      similarity REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_codepattern_similarity ON code_patterns(similarity);
  `);
}

// ── Engine ──────────────────────────────────────────────────

export class CodeForge {
  private readonly db: Database.Database;
  private readonly config: Required<CodeForgeConfig>;
  private readonly log = getLogger();

  private actionBridge: import('../action/action-bridge.js').ActionBridgeEngine | null = null;
  private codeHealthMonitor: { scan: (path: string) => unknown } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private selfModificationEngine: any = null;
  private guardrailEngine: { isProtectedPath: (path: string) => boolean } | null = null;

  // Prepared statements
  private readonly stmtInsertProduct;
  private readonly stmtInsertPattern;
  private readonly stmtGetProduct;
  private readonly stmtUpdateProductStatus;
  private readonly stmtGetProducts;
  private readonly stmtGetPatterns;
  private readonly stmtCountByStatus;
  private readonly stmtSuccessRate;

  constructor(db: Database.Database, config: CodeForgeConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      autoApplyEnabled: config.autoApplyEnabled ?? false,
      minSimilarityForPattern: config.minSimilarityForPattern ?? 0.6,
    };
    runCodeForgeMigration(db);

    this.stmtInsertProduct = db.prepare(`
      INSERT INTO code_products (type, name, description, files, source_pattern, status)
      VALUES (?, ?, ?, ?, ?, 'generated')
    `);
    this.stmtInsertPattern = db.prepare(`
      INSERT INTO code_patterns (pattern, occurrences, files, similarity)
      VALUES (?, ?, ?, ?)
    `);
    this.stmtGetProduct = db.prepare(`SELECT * FROM code_products WHERE id = ?`);
    this.stmtUpdateProductStatus = db.prepare(`UPDATE code_products SET status = ?, tests_passed = ? WHERE id = ?`);
    this.stmtGetProducts = db.prepare(`SELECT * FROM code_products WHERE status = ? ORDER BY created_at DESC LIMIT ?`);
    this.stmtGetPatterns = db.prepare(`SELECT * FROM code_patterns ORDER BY similarity DESC, occurrences DESC LIMIT ?`);
    this.stmtCountByStatus = db.prepare(`SELECT status, COUNT(*) as count FROM code_products GROUP BY status`);
    this.stmtSuccessRate = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as successes FROM code_products WHERE status IN ('applied', 'failed', 'rolled_back')`);
  }

  setActionBridge(bridge: import('../action/action-bridge.js').ActionBridgeEngine): void { this.actionBridge = bridge; }
  setCodeHealthMonitor(monitor: { scan: (path: string) => unknown }): void { this.codeHealthMonitor = monitor; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setSelfModificationEngine(engine: any): void { this.selfModificationEngine = engine; }
  setGuardrailEngine(engine: { isProtectedPath: (path: string) => boolean }): void { this.guardrailEngine = engine; }

  /** Extract recurring code patterns from codebase analysis */
  extractPatterns(): CodePattern[] {
    // This is a placeholder — in production this would scan via CodeHealthMonitor
    const rows = this.stmtGetPatterns.all(50) as Array<{
      id: number; pattern: string; occurrences: number; files: string; similarity: number;
    }>;
    return rows.map(r => ({
      id: r.id,
      pattern: r.pattern,
      occurrences: r.occurrences,
      files: JSON.parse(r.files || '[]'),
      similarity: r.similarity,
    }));
  }

  /** Record a discovered pattern */
  addPattern(pattern: string, occurrences: number, files: string[], similarity: number): number {
    const result = this.stmtInsertPattern.run(pattern, occurrences, JSON.stringify(files), similarity);
    return Number(result.lastInsertRowid);
  }

  /** Generate a utility from a recurring pattern */
  generateUtility(pattern: CodePattern): CodeProduct {
    const name = `util-${pattern.pattern.replace(/\s+/g, '-').substring(0, 30)}`;
    const description = `Utility extracted from pattern "${pattern.pattern}" (${pattern.occurrences} occurrences)`;
    const files = [{ path: `src/utils/${name}.ts`, content: `// Auto-generated utility from pattern: ${pattern.pattern}\n`, action: 'create' as const }];
    return this.storeProduct('utility', name, description, files, pattern.pattern);
  }

  /** Auto-apply a self-modification proposal */
  autoApplyProposal(proposalId: number): { success: boolean; productId?: number } {
    if (!this.selfModificationEngine) {
      return { success: false };
    }

    try {
      this.selfModificationEngine.applyModification(proposalId);
      const product = this.storeProduct('refactor', `selfmod-${proposalId}`, `Auto-applied SelfMod proposal #${proposalId}`, [], undefined);
      this.stmtUpdateProductStatus.run('applied', 1, product.id);
      this.log.info(`[code-forge] Auto-applied SelfMod proposal #${proposalId}`);
      return { success: true, productId: product.id };
    } catch (err) {
      this.log.warn(`[code-forge] Auto-apply failed for proposal #${proposalId}: ${(err as Error).message}`);
      return { success: false };
    }
  }

  /** Scaffold a new project from a template */
  scaffoldProject(template: string, config: Record<string, unknown>): CodeProduct {
    const name = (config.name as string) ?? template;
    const description = `Scaffolded from template: ${template}`;
    const files = [
      { path: `${name}/package.json`, content: JSON.stringify({ name, version: '1.0.0' }, null, 2), action: 'create' as const },
      { path: `${name}/src/index.ts`, content: `// ${name} — scaffolded from ${template}\nexport {};\n`, action: 'create' as const },
      { path: `${name}/tsconfig.json`, content: JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext' } }, null, 2), action: 'create' as const },
    ];
    return this.storeProduct('scaffold', name, description, files, template);
  }

  /** Generate tests for a target file */
  generateTest(targetFile: string): CodeProduct {
    const testPath = targetFile.replace(/\.ts$/, '.test.ts').replace('src/', 'src/__tests__/');
    const name = `test-${targetFile.split('/').pop()?.replace('.ts', '')}`;
    const content = `import { describe, it, expect } from 'vitest';\n\ndescribe('${name}', () => {\n  it('should work', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
    const files = [{ path: testPath, content, action: 'create' as const }];
    return this.storeProduct('test', name, `Auto-generated test for ${targetFile}`, files, undefined);
  }

  /** Apply a code product (mark as applied) */
  applyProduct(productId: number): { success: boolean } {
    const row = this.stmtGetProduct.get(productId) as RawProduct | undefined;
    if (!row) throw new Error(`Product #${productId} not found`);
    if (row.status !== 'generated' && row.status !== 'tested') {
      throw new Error(`Product #${productId} cannot be applied (status=${row.status})`);
    }

    // Check guardrails
    const product = deserializeProduct(row);
    for (const f of product.files) {
      if (this.guardrailEngine?.isProtectedPath(f.path)) {
        this.log.warn(`[code-forge] Cannot apply #${productId}: ${f.path} is protected`);
        this.stmtUpdateProductStatus.run('failed', null, productId);
        return { success: false };
      }
    }

    this.stmtUpdateProductStatus.run('applied', null, productId);
    this.log.info(`[code-forge] Applied product #${productId}: ${row.name}`);
    return { success: true };
  }

  /** Rollback a product */
  rollback(productId: number): void {
    const row = this.stmtGetProduct.get(productId) as RawProduct | undefined;
    if (!row) throw new Error(`Product #${productId} not found`);
    this.stmtUpdateProductStatus.run('rolled_back', null, productId);
    this.log.info(`[code-forge] Rolled back product #${productId}`);
  }

  /** Get products by status */
  getProducts(status?: string): CodeProduct[] {
    const rows = (status
      ? this.stmtGetProducts.all(status, 100)
      : this.db.prepare(`SELECT * FROM code_products ORDER BY created_at DESC LIMIT 100`).all()
    ) as RawProduct[];
    return rows.map(deserializeProduct);
  }

  /** Get status overview */
  getStatus(): CodeForgeStatus {
    const counts = this.stmtCountByStatus.all() as Array<{ status: string; count: number }>;
    const countMap: Record<string, number> = {};
    let total = 0;
    for (const c of counts) { countMap[c.status] = c.count; total += c.count; }

    const sr = this.stmtSuccessRate.get() as { total: number; successes: number };

    return {
      patterns: (this.stmtGetPatterns.all(1000) as unknown[]).length,
      products: total,
      applied: countMap['applied'] ?? 0,
      successRate: sr.total > 0 ? sr.successes / sr.total : 0,
    };
  }

  // ── Private ──────────────────────────────────────────────

  private storeProduct(type: CodeProduct['type'], name: string, description: string, files: CodeProduct['files'], sourcePattern?: string): CodeProduct {
    const result = this.stmtInsertProduct.run(type, name, description, JSON.stringify(files), sourcePattern ?? null);
    const id = Number(result.lastInsertRowid);
    this.log.info(`[code-forge] Created product #${id}: ${name} (${type})`);
    return { id, type, name, description, files, sourcePattern, status: 'generated' };
  }
}

// ── Helpers ──────────────────────────────────────────────────

interface RawProduct {
  id: number;
  type: string;
  name: string;
  description: string;
  files: string;
  source_pattern: string | null;
  tests_passed: number | null;
  status: string;
  created_at: string;
}

function deserializeProduct(row: RawProduct): CodeProduct {
  return {
    id: row.id,
    type: row.type as CodeProduct['type'],
    name: row.name,
    description: row.description,
    files: JSON.parse(row.files || '[]'),
    sourcePattern: row.source_pattern ?? undefined,
    testsPassed: row.tests_passed !== null ? row.tests_passed === 1 : undefined,
    status: row.status as CodeProduct['status'],
    createdAt: row.created_at,
  };
}
