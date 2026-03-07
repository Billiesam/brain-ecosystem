/**
 * Code Sandbox — Isolated Code Execution (AutoGen-inspired)
 *
 * Führt generierten Code in isolierten Prozessen aus.
 * Unterstützt TypeScript, Python und Shell.
 * Timeout und Ressourcenlimits. Ergebnis-Capture (stdout/stderr/exitCode).
 *
 * Docker-basiert wenn verfügbar, Fallback auf lokale Subprozesse mit Timeout.
 *
 * Usage:
 * ```typescript
 * const sandbox = new CodeSandbox(db);
 * const result = await sandbox.execute({
 *   code: 'console.log("Hello");',
 *   language: 'typescript',
 *   timeoutMs: 5000,
 * });
 * console.log(result.stdout); // "Hello\n"
 * ```
 */

import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export type SandboxLanguage = 'typescript' | 'javascript' | 'python' | 'shell';

export interface ExecutionRequest {
  /** Code to execute */
  code: string;
  /** Language */
  language: SandboxLanguage;
  /** Max execution time in ms. Default: 10000 */
  timeoutMs?: number;
  /** Max memory in MB. Default: 128 */
  memoryMb?: number;
  /** Working directory (used for local execution) */
  workDir?: string;
  /** Name/label for this execution */
  name?: string;
  /** Additional context metadata */
  metadata?: Record<string, unknown>;
}

export interface ExecutionResult {
  id: string;
  language: SandboxLanguage;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  error?: string;
  name?: string;
  createdAt: number;
}

export interface CodeSandboxConfig {
  /** Prefer Docker containers. Default: true */
  preferDocker?: boolean;
  /** Default timeout. Default: 10000 */
  defaultTimeoutMs?: number;
  /** Default max memory. Default: 128 */
  defaultMemoryMb?: number;
  /** Max output size in chars. Default: 100000 */
  maxOutputSize?: number;
}

export interface CodeSandboxStatus {
  totalExecutions: number;
  successCount: number;
  failCount: number;
  timeoutCount: number;
  avgDurationMs: number;
  dockerAvailable: boolean;
  languages: string[];
}

// ── Migration ───────────────────────────────────────────

export function runSandboxMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandbox_executions (
      id TEXT PRIMARY KEY,
      language TEXT NOT NULL,
      exit_code INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      timed_out INTEGER NOT NULL DEFAULT 0,
      name TEXT,
      stdout_preview TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sandbox_created ON sandbox_executions(created_at);
    CREATE INDEX IF NOT EXISTS idx_sandbox_language ON sandbox_executions(language);
  `);
}

// ── Sandbox ─────────────────────────────────────────────

export class CodeSandbox {
  private readonly log = getLogger();
  private readonly config: Required<CodeSandboxConfig>;
  private dockerAvailable: boolean | null = null;
  private stmtInsert: Database.Statement;

  constructor(
    private db: Database.Database,
    config: CodeSandboxConfig = {},
  ) {
    runSandboxMigration(db);

    this.config = {
      preferDocker: config.preferDocker ?? true,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 10000,
      defaultMemoryMb: config.defaultMemoryMb ?? 128,
      maxOutputSize: config.maxOutputSize ?? 100000,
    };

    this.stmtInsert = db.prepare(
      'INSERT INTO sandbox_executions (id, language, exit_code, duration_ms, timed_out, name, stdout_preview, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  // ── Execution ─────────────────────────────────────────

  /** Execute code in a sandboxed environment. */
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const timeoutMs = request.timeoutMs ?? this.config.defaultTimeoutMs;
    const id = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();

    let result: ExecutionResult;

    try {
      // Check Docker availability (cached)
      const useDocker = this.config.preferDocker && await this.isDockerAvailable();

      if (useDocker) {
        result = await this.executeInDocker(id, request, timeoutMs);
      } else {
        result = await this.executeLocal(id, request, timeoutMs);
      }
    } catch (e) {
      result = {
        id,
        language: request.language,
        stdout: '',
        stderr: '',
        exitCode: 1,
        durationMs: Date.now() - startTime,
        timedOut: false,
        error: (e as Error).message,
        name: request.name,
        createdAt: Date.now(),
      };
    }

    // Truncate output
    result.stdout = this.truncate(result.stdout);
    result.stderr = this.truncate(result.stderr);

    // Persist
    this.persistResult(result);

    return result;
  }

  /** Execute multiple code blocks sequentially. */
  async executeMany(requests: ExecutionRequest[]): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (const req of requests) {
      results.push(await this.execute(req));
    }
    return results;
  }

  /**
   * Validate code without executing (basic syntax check).
   * Returns null if valid, error message if invalid.
   */
  validate(code: string, language: SandboxLanguage): string | null {
    try {
      switch (language) {
        case 'javascript':
        case 'typescript':
          // Basic check: try parsing with Function constructor
          // eslint-disable-next-line no-new-func
          new Function(code);
          return null;
        case 'python':
          // Basic check: look for obvious syntax errors
          if (code.includes('def ') && !code.includes(':')) return 'Missing colon after def';
          return null;
        case 'shell':
          return null; // Shell is hard to validate statically
        default:
          return `Unsupported language: ${language}`;
      }
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ── Docker Execution ──────────────────────────────────

  private async executeInDocker(
    id: string,
    request: ExecutionRequest,
    timeoutMs: number,
  ): Promise<ExecutionResult> {
    const { code, language, memoryMb } = request;
    const memory = memoryMb ?? this.config.defaultMemoryMb;
    const startTime = Date.now();

    // Determine Docker image and command
    const { image, cmd, ext } = this.getDockerConfig(language);

    // Write code to temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sandbox-'));
    const codeFile = path.join(tmpDir, `code${ext}`);
    fs.writeFileSync(codeFile, code, 'utf-8');

    try {
      const dockerArgs = [
        'run', '--rm',
        '--memory', `${memory}m`,
        '--cpus', '1',
        '--network', 'none',
        '--read-only',
        '-v', `${tmpDir}:/sandbox:ro`,
        '-w', '/sandbox',
        image,
        ...cmd,
      ];

      const { stdout, stderr, exitCode, timedOut } = await this.runProcess(
        'docker', dockerArgs, timeoutMs,
      );

      return {
        id,
        language,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startTime,
        timedOut,
        name: request.name,
        createdAt: Date.now(),
      };
    } finally {
      // Cleanup temp files
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── Local Execution ───────────────────────────────────

  private async executeLocal(
    id: string,
    request: ExecutionRequest,
    timeoutMs: number,
  ): Promise<ExecutionResult> {
    const { code, language } = request;
    const startTime = Date.now();

    // Write code to temp file
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-sandbox-'));
    const { ext, localCmd } = this.getLocalConfig(language);
    const codeFile = path.join(tmpDir, `code${ext}`);
    fs.writeFileSync(codeFile, code, 'utf-8');

    try {
      const cmd = localCmd(codeFile);
      const { stdout, stderr, exitCode, timedOut } = await this.runProcess(
        cmd[0], cmd.slice(1), timeoutMs,
      );

      return {
        id,
        language,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startTime,
        timedOut,
        name: request.name,
        createdAt: Date.now(),
      };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ── Process Runner ────────────────────────────────────

  private runProcess(
    cmd: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      let timedOut = false;
      let child: ChildProcess;

      try {
        child = execFile(cmd, args, {
          timeout: timeoutMs,
          maxBuffer: this.config.maxOutputSize,
          windowsHide: true,
        }, (error, stdout, stderr) => {
          if (error && 'killed' in error && error.killed) {
            timedOut = true;
          }
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: error ? (typeof (error as Record<string, unknown>).code === 'number' ? (error as Record<string, unknown>).code as number : 1) : 0,
            timedOut,
          });
        });
      } catch (e) {
        resolve({
          stdout: '',
          stderr: (e as Error).message,
          exitCode: 127, // command not found
          timedOut: false,
        });
      }
    });
  }

  // ── Language Config ───────────────────────────────────

  private getDockerConfig(language: SandboxLanguage): { image: string; cmd: string[]; ext: string } {
    switch (language) {
      case 'typescript':
        return { image: 'node:20-alpine', cmd: ['npx', '--yes', 'tsx', '/sandbox/code.ts'], ext: '.ts' };
      case 'javascript':
        return { image: 'node:20-alpine', cmd: ['node', '/sandbox/code.js'], ext: '.js' };
      case 'python':
        return { image: 'python:3.12-alpine', cmd: ['python', '/sandbox/code.py'], ext: '.py' };
      case 'shell':
        return { image: 'alpine:3.19', cmd: ['sh', '/sandbox/code.sh'], ext: '.sh' };
      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }

  private getLocalConfig(language: SandboxLanguage): { ext: string; localCmd: (file: string) => string[] } {
    switch (language) {
      case 'typescript':
        return { ext: '.ts', localCmd: (f) => ['npx', '--yes', 'tsx', f] };
      case 'javascript':
        return { ext: '.js', localCmd: (f) => ['node', f] };
      case 'python':
        return { ext: '.py', localCmd: (f) => ['python', f] };
      case 'shell':
        return { ext: '.sh', localCmd: (f) => ['sh', f] };
      default:
        throw new Error(`Unsupported language: ${language}`);
    }
  }

  // ── Docker Detection ──────────────────────────────────

  /** Check if Docker is available on this system. */
  async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) return this.dockerAvailable;

    try {
      const { exitCode } = await this.runProcess('docker', ['info'], 5000);
      this.dockerAvailable = exitCode === 0;
    } catch {
      this.dockerAvailable = false;
    }

    return this.dockerAvailable;
  }

  /** Reset Docker availability cache. */
  resetDockerCache(): void {
    this.dockerAvailable = null;
  }

  // ── History ──────────────────────────────────────────

  /** Get recent execution history. */
  getHistory(limit = 50): Array<{
    id: string; language: string; exitCode: number; durationMs: number;
    timedOut: boolean; name: string | null; error: string | null; createdAt: string;
  }> {
    return this.db.prepare(
      'SELECT id, language, exit_code as exitCode, duration_ms as durationMs, timed_out as timedOut, name, error, created_at as createdAt FROM sandbox_executions ORDER BY created_at DESC LIMIT ?',
    ).all(limit).map(r => ({
      ...(r as Record<string, unknown>),
      timedOut: !!(r as Record<string, unknown>).timedOut,
    })) as Array<{
      id: string; language: string; exitCode: number; durationMs: number;
      timedOut: boolean; name: string | null; error: string | null; createdAt: string;
    }>;
  }

  /** Get execution stats by language. */
  getLanguageStats(): Array<{ language: string; total: number; avgDuration: number; successRate: number }> {
    try {
      return this.db.prepare(`
        SELECT language,
               COUNT(*) as total,
               ROUND(AVG(duration_ms)) as avgDuration,
               ROUND(CAST(SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 3) as successRate
        FROM sandbox_executions
        GROUP BY language
        ORDER BY total DESC
      `).all() as Array<{ language: string; total: number; avgDuration: number; successRate: number }>;
    } catch {
      return [];
    }
  }

  // ── Status ──────────────────────────────────────────

  getStatus(): CodeSandboxStatus {
    try {
      const total = (this.db.prepare('SELECT COUNT(*) as c FROM sandbox_executions').get() as { c: number }).c;
      const success = (this.db.prepare('SELECT COUNT(*) as c FROM sandbox_executions WHERE exit_code = 0').get() as { c: number }).c;
      const timeouts = (this.db.prepare('SELECT COUNT(*) as c FROM sandbox_executions WHERE timed_out = 1').get() as { c: number }).c;
      const avgDuration = (this.db.prepare('SELECT COALESCE(AVG(duration_ms), 0) as v FROM sandbox_executions').get() as { v: number }).v;
      const languages = (this.db.prepare('SELECT DISTINCT language FROM sandbox_executions').all() as Array<{ language: string }>).map(r => r.language);

      return {
        totalExecutions: total,
        successCount: success,
        failCount: total - success - timeouts,
        timeoutCount: timeouts,
        avgDurationMs: Math.round(avgDuration),
        dockerAvailable: this.dockerAvailable ?? false,
        languages,
      };
    } catch {
      return { totalExecutions: 0, successCount: 0, failCount: 0, timeoutCount: 0, avgDurationMs: 0, dockerAvailable: false, languages: [] };
    }
  }

  // ── Private Helpers ───────────────────────────────────

  private truncate(str: string): string {
    return str.length > this.config.maxOutputSize
      ? str.slice(0, this.config.maxOutputSize) + '\n... [truncated]'
      : str;
  }

  private persistResult(result: ExecutionResult): void {
    try {
      this.stmtInsert.run(
        result.id, result.language, result.exitCode, result.durationMs,
        result.timedOut ? 1 : 0, result.name ?? null,
        result.stdout.slice(0, 500), // preview only
        result.error ?? null,
      );
    } catch (e) {
      this.log.warn(`[CodeSandbox] Failed to persist: ${(e as Error).message}`);
    }
  }
}
