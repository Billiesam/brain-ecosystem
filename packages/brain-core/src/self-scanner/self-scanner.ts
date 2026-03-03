import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getLogger } from '../utils/logger.js';

// ── Types ────────────────────────────────────────────────

export interface SelfScannerConfig {
  brainName: string;
  /** Glob patterns relative to root. Default: packages/star/src */
  scanDirs?: string[];
  /** File extension to scan. Default: .ts */
  extension?: string;
}

export interface SourceFile {
  id: number;
  package_name: string;
  file_path: string;
  content: string;
  content_hash: string;
  size_bytes: number;
  last_scanned: string;
}

export interface CodeEntity {
  id: number;
  file_id: number;
  entity_type: EntityType;
  entity_name: string;
  line_start: number;
  line_end: number;
  signature: string;
  parent_entity: string | null;
}

export type EntityType = 'class' | 'function' | 'interface' | 'type' | 'const' | 'method';

export interface EntityFilter {
  entityType?: EntityType;
  entityName?: string;
  packageName?: string;
}

export interface ModuleMapEntry {
  package_name: string;
  file_path: string;
  entity_type: EntityType;
  entity_name: string;
}

export interface SelfScanResult {
  totalFiles: number;
  newFiles: number;
  updatedFiles: number;
  unchangedFiles: number;
  totalEntities: number;
  durationMs: number;
}

export interface SelfScannerStatus {
  brainName: string;
  totalFiles: number;
  totalEntities: number;
  byPackage: Record<string, number>;
  byEntityType: Record<string, number>;
  lastScanTime: string | null;
}

// ── Migration ────────────────────────────────────────────

export function runSelfScannerMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS own_source_files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name  TEXT NOT NULL,
      file_path     TEXT NOT NULL UNIQUE,
      content       TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      size_bytes    INTEGER NOT NULL,
      last_scanned  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_own_source_pkg ON own_source_files(package_name);

    CREATE TABLE IF NOT EXISTS own_code_entities (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id        INTEGER NOT NULL REFERENCES own_source_files(id) ON DELETE CASCADE,
      entity_type    TEXT NOT NULL,
      entity_name    TEXT NOT NULL,
      line_start     INTEGER NOT NULL,
      line_end       INTEGER NOT NULL,
      signature      TEXT NOT NULL DEFAULT '',
      parent_entity  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_own_entities_file ON own_code_entities(file_id);
    CREATE INDEX IF NOT EXISTS idx_own_entities_type ON own_code_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_own_entities_name ON own_code_entities(entity_name);
  `);
}

// ── SelfScanner ──────────────────────────────────────────

export class SelfScanner {
  private readonly db: Database.Database;
  private readonly config: Required<SelfScannerConfig>;
  private readonly log = getLogger();
  private lastScanTime: string | null = null;

  // Prepared statements
  private readonly stmtGetFileByPath: Database.Statement;
  private readonly stmtInsertFile: Database.Statement;
  private readonly stmtUpdateFile: Database.Statement;
  private readonly stmtDeleteEntities: Database.Statement;
  private readonly stmtInsertEntity: Database.Statement;
  private readonly stmtGetFileContent: Database.Statement;
  private readonly stmtGetEntities: Database.Statement;
  private readonly stmtGetModuleMap: Database.Statement;
  private readonly stmtCountFiles: Database.Statement;
  private readonly stmtCountEntities: Database.Statement;
  private readonly stmtCountByPackage: Database.Statement;
  private readonly stmtCountByEntityType: Database.Statement;

  constructor(db: Database.Database, config: SelfScannerConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      scanDirs: config.scanDirs ?? ['packages/*/src'],
      extension: config.extension ?? '.ts',
    };

    runSelfScannerMigration(db);

    this.stmtGetFileByPath = db.prepare('SELECT id, content_hash FROM own_source_files WHERE file_path = ?');
    this.stmtInsertFile = db.prepare('INSERT INTO own_source_files (package_name, file_path, content, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)');
    this.stmtUpdateFile = db.prepare('UPDATE own_source_files SET content = ?, content_hash = ?, size_bytes = ?, last_scanned = datetime(\'now\') WHERE id = ?');
    this.stmtDeleteEntities = db.prepare('DELETE FROM own_code_entities WHERE file_id = ?');
    this.stmtInsertEntity = db.prepare('INSERT INTO own_code_entities (file_id, entity_type, entity_name, line_start, line_end, signature, parent_entity) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.stmtGetFileContent = db.prepare('SELECT content FROM own_source_files WHERE file_path = ?');
    this.stmtGetEntities = db.prepare(`
      SELECT e.*, f.file_path, f.package_name
      FROM own_code_entities e
      JOIN own_source_files f ON e.file_id = f.id
      ORDER BY f.package_name, f.file_path, e.line_start
    `);
    this.stmtGetModuleMap = db.prepare(`
      SELECT f.package_name, f.file_path, e.entity_type, e.entity_name
      FROM own_code_entities e
      JOIN own_source_files f ON e.file_id = f.id
      WHERE e.entity_type IN ('class', 'interface', 'function')
      ORDER BY f.package_name, e.entity_name
    `);
    this.stmtCountFiles = db.prepare('SELECT COUNT(*) as count FROM own_source_files');
    this.stmtCountEntities = db.prepare('SELECT COUNT(*) as count FROM own_code_entities');
    this.stmtCountByPackage = db.prepare('SELECT package_name, COUNT(*) as count FROM own_source_files GROUP BY package_name');
    this.stmtCountByEntityType = db.prepare('SELECT entity_type, COUNT(*) as count FROM own_code_entities GROUP BY entity_type');
  }

  /** Recursively scan TypeScript source files from the project root. */
  scan(rootPath: string): SelfScanResult {
    const start = Date.now();
    const resolvedRoot = path.resolve(rootPath);
    let newFiles = 0;
    let updatedFiles = 0;
    let unchangedFiles = 0;
    let totalEntities = 0;

    // Discover all .ts files matching scanDirs patterns
    const files = this.discoverFiles(resolvedRoot);

    const transaction = this.db.transaction(() => {
      for (const filePath of files) {
        const relativePath = path.relative(resolvedRoot, filePath).replace(/\\/g, '/');
        const packageName = this.extractPackageName(relativePath);

        let content: string;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          continue;
        }

        const hash = crypto.createHash('sha256').update(content).digest('hex');
        const existing = this.stmtGetFileByPath.get(relativePath) as { id: number; content_hash: string } | undefined;

        if (!existing) {
          // New file
          const result = this.stmtInsertFile.run(packageName, relativePath, content, hash, Buffer.byteLength(content));
          const fileId = result.lastInsertRowid as number;
          totalEntities += this.parseEntities(content, fileId);
          newFiles++;
        } else if (existing.content_hash !== hash) {
          // Updated file
          this.stmtUpdateFile.run(content, hash, Buffer.byteLength(content), existing.id);
          this.stmtDeleteEntities.run(existing.id);
          totalEntities += this.parseEntities(content, existing.id);
          updatedFiles++;
        } else {
          unchangedFiles++;
        }
      }
    });

    transaction();
    this.lastScanTime = new Date().toISOString();
    const durationMs = Date.now() - start;

    this.log.info(`[self-scanner] Scanned ${files.length} files: ${newFiles} new, ${updatedFiles} updated, ${unchangedFiles} unchanged (${durationMs}ms)`);

    return {
      totalFiles: files.length,
      newFiles,
      updatedFiles,
      unchangedFiles,
      totalEntities,
      durationMs,
    };
  }

  /** Parse code entities from source content using regex patterns. */
  parseEntities(content: string, fileId: number): number {
    const lines = content.split('\n');
    let count = 0;
    let currentClass: string | null = null;
    let classDepth = 0;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      // Track brace depth for class scope
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }

      if (currentClass && braceDepth < classDepth) {
        currentClass = null;
        classDepth = 0;
      }

      // Class
      const classMatch = line.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        const name = classMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        this.stmtInsertEntity.run(fileId, 'class', name, lineNum, endLine, line.trim(), null);
        currentClass = name;
        classDepth = braceDepth;
        count++;
        continue;
      }

      // Interface
      const ifaceMatch = line.match(/^export\s+interface\s+(\w+)/);
      if (ifaceMatch) {
        const name = ifaceMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        this.stmtInsertEntity.run(fileId, 'interface', name, lineNum, endLine, line.trim(), null);
        count++;
        continue;
      }

      // Type
      const typeMatch = line.match(/^export\s+type\s+(\w+)/);
      if (typeMatch) {
        const name = typeMatch[1]!;
        const endLine = this.findTypeEnd(lines, i);
        this.stmtInsertEntity.run(fileId, 'type', name, lineNum, endLine, line.trim(), null);
        count++;
        continue;
      }

      // Function
      const funcMatch = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) {
        const name = funcMatch[1]!;
        const endLine = this.findBlockEnd(lines, i);
        this.stmtInsertEntity.run(fileId, 'function', name, lineNum, endLine, line.trim(), null);
        count++;
        continue;
      }

      // Const
      const constMatch = line.match(/^export\s+const\s+(\w+)/);
      if (constMatch) {
        const name = constMatch[1]!;
        const endLine = this.findConstEnd(lines, i);
        this.stmtInsertEntity.run(fileId, 'const', name, lineNum, endLine, line.trim(), null);
        count++;
        continue;
      }

      // Methods (inside classes)
      if (currentClass) {
        const methodMatch = line.match(/^\s+(?:private\s+|public\s+|protected\s+|readonly\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\(/);
        if (methodMatch) {
          const name = methodMatch[1]!;
          // Skip constructor and common non-method patterns
          if (name === 'if' || name === 'for' || name === 'while' || name === 'switch' || name === 'catch' || name === 'return') continue;
          const endLine = this.findBlockEnd(lines, i);
          this.stmtInsertEntity.run(fileId, 'method', name, lineNum, endLine, line.trim(), currentClass);
          count++;
        }
      }
    }

    return count;
  }

  /** Get stored source content for a file. */
  getFileContent(filePath: string): string | null {
    const row = this.stmtGetFileContent.get(filePath) as { content: string } | undefined;
    return row?.content ?? null;
  }

  /** Get code entities with optional filtering. */
  getEntities(filter?: EntityFilter): (CodeEntity & { file_path: string; package_name: string })[] {
    let rows = this.stmtGetEntities.all() as (CodeEntity & { file_path: string; package_name: string })[];

    if (filter?.entityType) {
      rows = rows.filter(r => r.entity_type === filter.entityType);
    }
    if (filter?.entityName) {
      const name = filter.entityName.toLowerCase();
      rows = rows.filter(r => r.entity_name.toLowerCase().includes(name));
    }
    if (filter?.packageName) {
      rows = rows.filter(r => r.package_name === filter.packageName);
    }

    return rows;
  }

  /** Get a map of which classes/interfaces/functions live where. */
  getModuleMap(): ModuleMapEntry[] {
    return this.stmtGetModuleMap.all() as ModuleMapEntry[];
  }

  /** Generate a compact architecture summary suitable for Claude API context. */
  getArchitectureSummary(): string {
    const moduleMap = this.getModuleMap();
    if (moduleMap.length === 0) return 'No source files scanned yet.';

    const sections: string[] = [];
    const byPackage = new Map<string, ModuleMapEntry[]>();
    for (const entry of moduleMap) {
      const existing = byPackage.get(entry.package_name) ?? [];
      existing.push(entry);
      byPackage.set(entry.package_name, existing);
    }

    for (const [pkg, entries] of byPackage) {
      const classes = entries.filter(e => e.entity_type === 'class').map(e => e.entity_name);
      const interfaces = entries.filter(e => e.entity_type === 'interface').map(e => e.entity_name);
      const functions = entries.filter(e => e.entity_type === 'function').map(e => e.entity_name);

      sections.push(`### ${pkg}`);
      if (classes.length > 0) sections.push(`Classes: ${classes.join(', ')}`);
      if (interfaces.length > 0) sections.push(`Interfaces: ${interfaces.join(', ')}`);
      if (functions.length > 0) sections.push(`Functions: ${functions.join(', ')}`);
      sections.push('');
    }

    return sections.join('\n');
  }

  /** Get scanner status with statistics. */
  getStatus(): SelfScannerStatus {
    const fileCount = (this.stmtCountFiles.get() as { count: number }).count;
    const entityCount = (this.stmtCountEntities.get() as { count: number }).count;
    const byPackage: Record<string, number> = {};
    for (const row of this.stmtCountByPackage.all() as { package_name: string; count: number }[]) {
      byPackage[row.package_name] = row.count;
    }
    const byEntityType: Record<string, number> = {};
    for (const row of this.stmtCountByEntityType.all() as { entity_type: string; count: number }[]) {
      byEntityType[row.entity_type] = row.count;
    }

    return {
      brainName: this.config.brainName,
      totalFiles: fileCount,
      totalEntities: entityCount,
      byPackage,
      byEntityType,
      lastScanTime: this.lastScanTime,
    };
  }

  // ── Private Helpers ────────────────────────────────────

  private discoverFiles(rootPath: string): string[] {
    const files: string[] = [];
    const ext = this.config.extension;

    for (const pattern of this.config.scanDirs) {
      // Expand simple glob: 'packages/*/src' → find all matching dirs
      const parts = pattern.split('/');
      const resolved = this.expandGlob(rootPath, parts, 0);
      for (const dir of resolved) {
        this.walkDir(dir, ext, files);
      }
    }

    return files;
  }

  private expandGlob(base: string, parts: string[], index: number): string[] {
    if (index >= parts.length) return [base];
    const part = parts[index]!;

    if (part === '*') {
      const results: string[] = [];
      try {
        const entries = fs.readdirSync(base, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            results.push(...this.expandGlob(path.join(base, entry.name), parts, index + 1));
          }
        }
      } catch { /* directory might not exist */ }
      return results;
    }

    const next = path.join(base, part);
    if (fs.existsSync(next)) {
      return this.expandGlob(next, parts, index + 1);
    }
    return [];
  }

  private walkDir(dir: string, ext: string, result: string[]): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '__tests__' && !entry.name.startsWith('.')) {
            this.walkDir(fullPath, ext, result);
          }
        } else if (entry.name.endsWith(ext) && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
          result.push(fullPath);
        }
      }
    } catch { /* permission or access error */ }
  }

  private extractPackageName(relativePath: string): string {
    // packages/brain-core/src/foo.ts → brain-core
    const match = relativePath.match(/^packages\/([^/]+)\//);
    return match?.[1] ?? 'unknown';
  }

  private findBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let foundOpen = false;
    for (let i = startIndex; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === '{') { depth++; foundOpen = true; }
        if (ch === '}') depth--;
        if (foundOpen && depth === 0) return i + 1;
      }
    }
    return startIndex + 1;
  }

  private findTypeEnd(lines: string[], startIndex: number): number {
    // Types end at semicolon or next export
    for (let i = startIndex + 1; i < Math.min(startIndex + 50, lines.length); i++) {
      const line = lines[i]!;
      if (line.trimEnd().endsWith(';') || line.match(/^export\s/)) return i + 1;
    }
    return startIndex + 1;
  }

  private findConstEnd(lines: string[], startIndex: number): number {
    // Simple consts end at semicolon, complex ones end at closing bracket + semicolon
    let depth = 0;
    for (let i = startIndex; i < Math.min(startIndex + 100, lines.length); i++) {
      for (const ch of lines[i]!) {
        if (ch === '{' || ch === '[' || ch === '(') depth++;
        if (ch === '}' || ch === ']' || ch === ')') depth--;
      }
      if (depth <= 0 && lines[i]!.trimEnd().endsWith(';')) return i + 1;
    }
    return startIndex + 1;
  }
}
