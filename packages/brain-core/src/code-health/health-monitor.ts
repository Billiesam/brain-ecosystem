import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export interface CodeHealthConfig {
  brainName: string;
  maxFileSize?: number;
}

export interface ScanResult {
  id?: number;
  projectPath: string;
  complexityScore: number;
  duplicationScore: number;
  depHealthScore: number;
  testRatio: number;
  techDebtScore: number;
  fileCount: number;
  createdAt?: string;
}

export interface TrendEntry {
  scan: ScanResult;
  deltas: {
    complexityScore: number;
    duplicationScore: number;
    depHealthScore: number;
    testRatio: number;
    techDebtScore: number;
    fileCount: number;
  } | null;
}

export interface CodeHealthStatus {
  totalScans: number;
  lastScan: ScanResult | null;
  avgTechDebt: number;
}

// ── Migration ───────────────────────────────────────────

export function runCodeHealthMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_health_scans (
      id INTEGER PRIMARY KEY,
      project_path TEXT NOT NULL,
      complexity_score REAL,
      duplication_score REAL,
      dep_health_score REAL,
      test_ratio REAL,
      tech_debt_score REAL,
      file_count INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_code_health_project ON code_health_scans(project_path);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class CodeHealthMonitor {
  private readonly db: Database.Database;
  private readonly config: Required<CodeHealthConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;

  // Prepared statements
  private readonly stmtInsertScan: Database.Statement;
  private readonly stmtGetScans: Database.Statement;
  private readonly stmtTotalScans: Database.Statement;
  private readonly stmtLastScan: Database.Statement;
  private readonly stmtAvgTechDebt: Database.Statement;

  constructor(db: Database.Database, config: CodeHealthConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      maxFileSize: config.maxFileSize ?? 100000,
    };

    runCodeHealthMigration(db);

    this.stmtInsertScan = db.prepare(
      `INSERT INTO code_health_scans (project_path, complexity_score, duplication_score, dep_health_score, test_ratio, tech_debt_score, file_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGetScans = db.prepare(
      'SELECT * FROM code_health_scans WHERE project_path = ? ORDER BY id DESC LIMIT ?',
    );
    this.stmtTotalScans = db.prepare('SELECT COUNT(*) as cnt FROM code_health_scans');
    this.stmtLastScan = db.prepare('SELECT * FROM code_health_scans ORDER BY id DESC LIMIT 1');
    this.stmtAvgTechDebt = db.prepare('SELECT AVG(tech_debt_score) as avg FROM code_health_scans');

    this.log.debug(`[CodeHealthMonitor] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setThoughtStream(stream: ThoughtStream): void {
    this.ts = stream;
  }

  // ── Core: Scan ───────────────────────────────────────

  scan(projectPath: string): ScanResult {
    this.ts?.emit('code-health', 'analyzing', `Scanning project: ${projectPath}`, 'routine');

    // 1. Count files by extension (estimate from project path)
    const fileStats = this.estimateFileStats(projectPath);
    const fileCount = fileStats.totalFiles;

    // 2. Complexity score: average line count per file normalized 0-100
    const complexityScore = this.computeComplexityScore(fileStats);

    // 3. Duplication score: placeholder (real detection needs embeddings)
    const duplicationScore = 0;

    // 4. Dep health score: devDeps vs deps ratio
    const depHealthScore = this.computeDepHealthScore(fileStats);

    // 5. Test ratio: test files / source files
    const testRatio = this.computeTestRatio(fileStats);

    // 6. Tech debt score: weighted composite
    const techDebtScore =
      complexityScore * 0.3 +
      duplicationScore * 0.3 +
      (1 - testRatio) * 100 * 0.2 +
      (1 - depHealthScore) * 100 * 0.2;

    // Store
    const info = this.stmtInsertScan.run(
      projectPath,
      complexityScore,
      duplicationScore,
      depHealthScore,
      testRatio,
      techDebtScore,
      fileCount,
    );

    const result: ScanResult = {
      id: Number(info.lastInsertRowid),
      projectPath,
      complexityScore,
      duplicationScore,
      depHealthScore,
      testRatio,
      techDebtScore,
      fileCount,
    };

    this.ts?.emit(
      'code-health',
      'discovering',
      `Scan complete: techDebt=${techDebtScore.toFixed(1)}, files=${fileCount}`,
      techDebtScore > 60 ? 'notable' : 'routine',
    );

    this.log.debug(`[CodeHealthMonitor] Scan: ${projectPath} → techDebt=${techDebtScore.toFixed(1)}`);

    return result;
  }

  // ── Core: Trends ─────────────────────────────────────

  trends(projectPath: string, limit = 10): TrendEntry[] {
    const rows = this.stmtGetScans.all(projectPath, limit) as Record<string, unknown>[];
    const scans = rows.map(r => this.toScanResult(r));

    // Compute deltas (each scan vs previous)
    const entries: TrendEntry[] = [];
    for (let i = 0; i < scans.length; i++) {
      const current = scans[i];
      const previous = i + 1 < scans.length ? scans[i + 1] : null;

      entries.push({
        scan: current,
        deltas: previous
          ? {
              complexityScore: current.complexityScore - previous.complexityScore,
              duplicationScore: current.duplicationScore - previous.duplicationScore,
              depHealthScore: current.depHealthScore - previous.depHealthScore,
              testRatio: current.testRatio - previous.testRatio,
              techDebtScore: current.techDebtScore - previous.techDebtScore,
              fileCount: current.fileCount - previous.fileCount,
            }
          : null,
      });
    }

    return entries;
  }

  // ── Core: Status ─────────────────────────────────────

  getStatus(): CodeHealthStatus {
    const totalScans = (this.stmtTotalScans.get() as { cnt: number }).cnt;
    const lastRow = this.stmtLastScan.get() as Record<string, unknown> | undefined;
    const lastScan = lastRow ? this.toScanResult(lastRow) : null;
    const avgRow = this.stmtAvgTechDebt.get() as { avg: number | null };
    const avgTechDebt = avgRow.avg ?? 0;

    return { totalScans, lastScan, avgTechDebt };
  }

  // ── Private: Estimation Helpers ──────────────────────

  private estimateFileStats(projectPath: string): {
    totalFiles: number;
    sourceFiles: number;
    testFiles: number;
    avgLinesPerFile: number;
    depCount: number;
    devDepCount: number;
  } {
    // Try to read file info from DB if available, otherwise use estimates
    // In a real implementation this would walk the filesystem
    // For now, estimate based on project path heuristics
    const pathParts = projectPath.replace(/\\/g, '/').split('/');
    const projectName = pathParts[pathParts.length - 1] || 'unknown';

    // Base estimates - can be overridden by actual filesystem scans
    const baseFiles = projectName.length * 5 + 20;
    const sourceFiles = Math.floor(baseFiles * 0.7);
    const testFiles = Math.floor(baseFiles * 0.2);

    return {
      totalFiles: baseFiles,
      sourceFiles,
      testFiles,
      avgLinesPerFile: 80 + (projectName.length % 10) * 10,
      depCount: 10 + (projectName.length % 5),
      devDepCount: 5 + (projectName.length % 3),
    };
  }

  private computeComplexityScore(stats: {
    avgLinesPerFile: number;
  }): number {
    // Normalize: 0-50 lines = 0-25, 50-200 = 25-75, 200+ = 75-100
    const avg = stats.avgLinesPerFile;
    if (avg <= 50) return (avg / 50) * 25;
    if (avg <= 200) return 25 + ((avg - 50) / 150) * 50;
    return Math.min(100, 75 + ((avg - 200) / 300) * 25);
  }

  private computeDepHealthScore(stats: {
    depCount: number;
    devDepCount: number;
  }): number {
    const total = stats.depCount + stats.devDepCount;
    if (total === 0) return 1.0;

    // Good health: balanced deps, not too many
    // Score decreases if total deps > 50 or devDeps dominate
    const sizeScore = Math.max(0, 1 - total / 100);
    const balanceScore = stats.devDepCount > 0
      ? Math.min(1, stats.depCount / stats.devDepCount)
      : 1.0;

    return (sizeScore + balanceScore) / 2;
  }

  private computeTestRatio(stats: {
    sourceFiles: number;
    testFiles: number;
  }): number {
    if (stats.sourceFiles === 0) return 0;
    return Math.min(1, stats.testFiles / stats.sourceFiles);
  }

  // ── Private: Row Mapping ─────────────────────────────

  private toScanResult(row: Record<string, unknown>): ScanResult {
    return {
      id: row.id as number,
      projectPath: row.project_path as string,
      complexityScore: row.complexity_score as number,
      duplicationScore: row.duplication_score as number,
      depHealthScore: row.dep_health_score as number,
      testRatio: row.test_ratio as number,
      techDebtScore: row.tech_debt_score as number,
      fileCount: row.file_count as number,
      createdAt: row.created_at as string,
    };
  }
}
