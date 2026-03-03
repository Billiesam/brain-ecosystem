import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SelfScanner } from '../../../src/self-scanner/self-scanner.js';

describe('SelfScanner', () => {
  let db: Database.Database;
  let scanner: SelfScanner;

  beforeEach(() => {
    db = new Database(':memory:');
    scanner = new SelfScanner(db, { brainName: 'test-brain' });
  });

  it('should create tables on construction', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'own_%'").all() as { name: string }[];
    const names = tables.map(t => t.name).sort();
    expect(names).toContain('own_source_files');
    expect(names).toContain('own_code_entities');
  });

  it('should return empty status initially', () => {
    const status = scanner.getStatus();
    expect(status.brainName).toBe('test-brain');
    expect(status.totalFiles).toBe(0);
    expect(status.totalEntities).toBe(0);
    expect(status.lastScanTime).toBeNull();
  });

  it('should scan a directory with TypeScript files', () => {
    // Create temp dir with .ts files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'test-pkg', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'example.ts'), `
export class MyClass {
  constructor() {}
  doWork(): void {}
}

export interface MyInterface {
  name: string;
}

export type MyType = string | number;

export function myFunction(): void {
  console.log('hello');
}

export const MY_CONST = 42;
`, 'utf-8');

    const result = scanner.scan(tmpDir);
    expect(result.totalFiles).toBe(1);
    expect(result.newFiles).toBe(1);
    expect(result.updatedFiles).toBe(0);
    expect(result.unchangedFiles).toBe(0);
    expect(result.totalEntities).toBeGreaterThanOrEqual(5); // class, interface, type, function, const

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should skip unchanged files on second scan', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'test-pkg', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'stable.ts'), 'export const X = 1;\n', 'utf-8');

    scanner.scan(tmpDir);
    const result2 = scanner.scan(tmpDir);
    expect(result2.newFiles).toBe(0);
    expect(result2.unchangedFiles).toBe(1);
    expect(result2.updatedFiles).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect updated files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'test-pkg', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });
    const filePath = path.join(pkgDir, 'mutable.ts');
    fs.writeFileSync(filePath, 'export const X = 1;\n', 'utf-8');

    scanner.scan(tmpDir);

    // Modify the file
    fs.writeFileSync(filePath, 'export const X = 2;\nexport const Y = 3;\n', 'utf-8');

    const result2 = scanner.scan(tmpDir);
    expect(result2.updatedFiles).toBe(1);
    expect(result2.unchangedFiles).toBe(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should parse entities correctly', () => {
    // Directly test parseEntities with a file_id
    db.prepare('INSERT INTO own_source_files (package_name, file_path, content, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)').run('test', 'test.ts', '', 'abc', 0);

    const content = `
export class Foo {
  constructor() {}
  bar(): void {}
  private baz(): number { return 1; }
}

export interface IBar {
  x: number;
}

export type Result = 'ok' | 'error';

export async function doStuff(): Promise<void> {
  return;
}

export const MAX_SIZE = 100;
`;

    const count = scanner.parseEntities(content, 1);
    expect(count).toBeGreaterThanOrEqual(7); // class, 2 methods (bar, baz), interface, type, function, const

    const entities = scanner.getEntities();
    const types = entities.map(e => e.entity_type);
    expect(types).toContain('class');
    expect(types).toContain('interface');
    expect(types).toContain('type');
    expect(types).toContain('function');
    expect(types).toContain('const');
    expect(types).toContain('method');
  });

  it('should filter entities by type', () => {
    db.prepare('INSERT INTO own_source_files (package_name, file_path, content, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)').run('test', 'filter.ts', '', 'def', 0);
    scanner.parseEntities('export class A {}\nexport function b() {}\n', 1);

    const classes = scanner.getEntities({ entityType: 'class' });
    expect(classes.every(e => e.entity_type === 'class')).toBe(true);
    expect(classes.length).toBeGreaterThanOrEqual(1);
  });

  it('should filter entities by name', () => {
    db.prepare('INSERT INTO own_source_files (package_name, file_path, content, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)').run('test', 'name.ts', '', 'ghi', 0);
    scanner.parseEntities('export class FooBar {}\nexport class Baz {}\n', 1);

    const results = scanner.getEntities({ entityName: 'foo' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.entity_name).toBe('FooBar');
  });

  it('should return file content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'test-pkg', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });
    const content = 'export const VALUE = 42;\n';
    fs.writeFileSync(path.join(pkgDir, 'val.ts'), content, 'utf-8');

    scanner.scan(tmpDir);

    const stored = scanner.getFileContent('packages/test-pkg/src/val.ts');
    expect(stored).toBe(content);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return null for unknown file', () => {
    const content = scanner.getFileContent('nonexistent.ts');
    expect(content).toBeNull();
  });

  it('should generate module map', () => {
    db.prepare('INSERT INTO own_source_files (package_name, file_path, content, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)').run('brain-core', 'test.ts', '', 'xyz', 0);
    scanner.parseEntities('export class Engine {}\nexport interface Config {}\nexport function init() {}\n', 1);

    const map = scanner.getModuleMap();
    expect(map.length).toBeGreaterThanOrEqual(3);
    expect(map.some(m => m.entity_name === 'Engine' && m.entity_type === 'class')).toBe(true);
  });

  it('should generate architecture summary', () => {
    db.prepare('INSERT INTO own_source_files (package_name, file_path, content, content_hash, size_bytes) VALUES (?, ?, ?, ?, ?)').run('brain-core', 'arch.ts', '', '123', 0);
    scanner.parseEntities('export class MyEngine {}\nexport interface MyConfig {}\n', 1);

    const summary = scanner.getArchitectureSummary();
    expect(summary).toContain('brain-core');
    expect(summary).toContain('MyEngine');
  });

  it('should return placeholder for empty scan', () => {
    const summary = scanner.getArchitectureSummary();
    expect(summary).toBe('No source files scanned yet.');
  });

  it('should skip test files and node_modules', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'test-pkg', 'src');
    const testDir = path.join(pkgDir, '__tests__');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'good.ts'), 'export const A = 1;\n', 'utf-8');
    fs.writeFileSync(path.join(pkgDir, 'bad.test.ts'), 'it("test", () => {});\n', 'utf-8');
    fs.writeFileSync(path.join(testDir, 'another.ts'), 'it("test", () => {});\n', 'utf-8');

    const result = scanner.scan(tmpDir);
    expect(result.totalFiles).toBe(1); // only good.ts

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should extract package name from relative path', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'brain-core', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'test.ts'), 'export const X = 1;\n', 'utf-8');

    scanner.scan(tmpDir);

    const status = scanner.getStatus();
    expect(status.byPackage['brain-core']).toBe(1);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should update status after scan', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    const pkgDir = path.join(tmpDir, 'packages', 'test', 'src');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'a.ts'), 'export class A {}\n', 'utf-8');

    scanner.scan(tmpDir);
    const status = scanner.getStatus();
    expect(status.totalFiles).toBe(1);
    expect(status.totalEntities).toBeGreaterThan(0);
    expect(status.lastScanTime).not.toBeNull();

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
