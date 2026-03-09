/**
 * Daemon Lifecycle Benchmarks
 *
 * Measures critical daemon startup/maintenance operations:
 * - SQLite DB open + WAL mode (cold vs warm)
 * - Migration run (empty DB vs existing)
 * - Retention cleanup duration
 * - VACUUM duration (simulated sizes)
 * - IPC encode/decode for typical payloads
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { bench, benchAsync, printTable, type BenchmarkResult } from './utils.js';
import { encodeMessage, MessageDecoder } from '@timmeck/brain-core';

const tmpDir = path.join(os.tmpdir(), `bench-lifecycle-${Date.now()}`);

function setup(): void {
  fs.mkdirSync(tmpDir, { recursive: true });
}

function cleanup(): void {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── SQLite open + WAL ─────────────────────────────────────

function benchSqliteOpen(): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];

  // Cold open (new DB each time)
  results.push(bench('SQLite open (cold)', () => {
    const dbPath = path.join(tmpDir, `cold-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.close();
    fs.unlinkSync(dbPath);
  }, 50, 3));

  // Warm open (reuse existing DB)
  const warmPath = path.join(tmpDir, 'warm.db');
  const warmDb = new Database(warmPath);
  warmDb.pragma('journal_mode = WAL');
  warmDb.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)');
  for (let i = 0; i < 100; i++) {
    warmDb.prepare('INSERT INTO t (data) VALUES (?)').run(`row-${i}`);
  }
  warmDb.close();

  results.push(bench('SQLite open (warm, 100 rows)', () => {
    const db = new Database(warmPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.close();
  }, 100, 5));

  return results;
}

// ── Migration run ─────────────────────────────────────────

function benchMigration(): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];

  // Typical migration: CREATE TABLE IF NOT EXISTS (idempotent)
  const migrationSql = `
    CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY, fingerprint TEXT, message TEXT, count INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS solutions (id INTEGER PRIMARY KEY, error_id INTEGER REFERENCES errors(id), content TEXT, confidence REAL DEFAULT 0.5, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS synapses (id INTEGER PRIMARY KEY, source TEXT, target TEXT, weight REAL DEFAULT 0.5, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON errors(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_synapses_source ON synapses(source);
    CREATE INDEX IF NOT EXISTS idx_synapses_target ON synapses(target);
  `;

  // Empty DB
  results.push(bench('Migration (empty DB)', () => {
    const dbPath = path.join(tmpDir, `mig-empty-${Math.random().toString(36).slice(2)}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(migrationSql);
    db.close();
    fs.unlinkSync(dbPath);
  }, 30, 3));

  // Existing DB (migration is idempotent)
  const existPath = path.join(tmpDir, 'mig-existing.db');
  const existDb = new Database(existPath);
  existDb.pragma('journal_mode = WAL');
  existDb.exec(migrationSql);
  existDb.close();

  results.push(bench('Migration (existing DB, noop)', () => {
    const db = new Database(existPath);
    db.pragma('journal_mode = WAL');
    db.exec(migrationSql);
    db.close();
  }, 100, 5));

  return results;
}

// ── Retention cleanup ─────────────────────────────────────

function benchRetention(): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];

  // Build a DB with 10K rows, delete old ones
  const retPath = path.join(tmpDir, 'retention.db');
  const retDb = new Database(retPath);
  retDb.pragma('journal_mode = WAL');
  retDb.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, data TEXT, created_at TEXT)`);

  const insert = retDb.prepare('INSERT INTO events (data, created_at) VALUES (?, ?)');
  const now = Date.now();
  const tx = retDb.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      const age = i < 2000 ? 0 : 90 * 24 * 3600 * 1000; // 2000 recent, 8000 old (90 days)
      const ts = new Date(now - age - Math.random() * 86400000).toISOString();
      insert.run(`event-data-${i}-${'x'.repeat(100)}`, ts);
    }
  });
  tx();
  retDb.close();

  results.push(bench('Retention cleanup (10K rows, 80% old)', () => {
    const db = new Database(retPath);
    db.pragma('journal_mode = WAL');
    const cutoff = new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
    // Re-insert for next iteration
    const ins = db.prepare('INSERT INTO events (data, created_at) VALUES (?, ?)');
    const txn = db.transaction(() => {
      for (let i = 0; i < 8000; i++) {
        const ts = new Date(now - 90 * 24 * 3600 * 1000 - Math.random() * 86400000).toISOString();
        ins.run(`event-data-refill-${i}`, ts);
      }
    });
    txn();
    db.close();
  }, 10, 1));

  return results;
}

// ── VACUUM ────────────────────────────────────────────────

function benchVacuum(): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];
  const sizes = [10, 50] as const; // MB (keep fast — 100/500 MB would be too slow for CI)

  for (const sizeMB of sizes) {
    const vacPath = path.join(tmpDir, `vacuum-${sizeMB}mb.db`);
    const db = new Database(vacPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE bloat (id INTEGER PRIMARY KEY, data BLOB)');

    // Fill to target size
    const chunkSize = 100_000; // 100KB per row
    const rows = Math.ceil((sizeMB * 1024 * 1024) / chunkSize);
    const insert = db.prepare('INSERT INTO bloat (data) VALUES (?)');
    const chunk = Buffer.alloc(chunkSize, 0x42);
    const tx = db.transaction(() => {
      for (let i = 0; i < rows; i++) insert.run(chunk);
    });
    tx();

    // Delete half to create fragmentation
    db.exec(`DELETE FROM bloat WHERE id % 2 = 0`);
    db.close();

    results.push(bench(`VACUUM (${sizeMB}MB, 50% fragmented)`, () => {
      const d = new Database(vacPath);
      d.pragma('journal_mode = WAL');
      d.exec('VACUUM');
      d.close();
    }, 3, 1));
  }

  return results;
}

// ── IPC encode/decode ─────────────────────────────────────

function benchIpc(): BenchmarkResult[] {
  const results: BenchmarkResult[] = [];

  // Small payload (status response)
  const smallPayload = { id: 'abc123', method: 'status', params: null };
  results.push(bench('IPC encode (small payload)', () => {
    encodeMessage(smallPayload);
  }, 10_000, 100));

  // Medium payload (error report)
  const mediumPayload = {
    id: 'def456',
    method: 'error.report',
    params: {
      message: 'TypeError: Cannot read properties of undefined',
      stack: new Array(20).fill('    at Object.<anonymous> (/project/src/file.ts:42:5)').join('\n'),
      file: 'src/components/Widget.tsx',
      line: 42,
      context: { project: 'my-app', branch: 'main', commit: 'abc1234' },
    },
  };
  results.push(bench('IPC encode (medium payload)', () => {
    encodeMessage(mediumPayload);
  }, 5_000, 50));

  // Large payload (bulk data)
  const largePayload = {
    id: 'ghi789',
    method: 'export',
    params: {
      errors: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        fingerprint: `fp-${i}`,
        message: `Error ${i}: ${'x'.repeat(200)}`,
        count: Math.floor(Math.random() * 100),
      })),
    },
  };
  results.push(bench('IPC encode (large payload, 100 errors)', () => {
    encodeMessage(largePayload);
  }, 1_000, 10));

  // Decode roundtrip
  const encoded = encodeMessage(mediumPayload);
  results.push(bench('IPC decode (medium payload)', () => {
    const decoder = new MessageDecoder();
    decoder.feed(encoded);
  }, 5_000, 50));

  return results;
}

// ── Main ──────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n🔬 Daemon Lifecycle Benchmarks\n');
  setup();

  try {
    const sqliteResults = benchSqliteOpen();
    printTable('SQLite Open', sqliteResults);

    const migrationResults = benchMigration();
    printTable('Migrations', migrationResults);

    const retentionResults = benchRetention();
    printTable('Retention Cleanup', retentionResults);

    const vacuumResults = benchVacuum();
    printTable('VACUUM', vacuumResults);

    const ipcResults = benchIpc();
    printTable('IPC Encode/Decode', ipcResults);
  } finally {
    cleanup();
  }
}

main().catch(console.error);
