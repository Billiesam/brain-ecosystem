import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { SemanticCompressor, runSemanticCompressorMigration } from '../semantic-compressor.js';

// ── Helpers ──────────────────────────────────────────────────

function createTestDb(): Database.Database {
  return new Database(':memory:');
}

function createEmbedding(values: number[]): Buffer {
  const arr = new Float32Array(values);
  return Buffer.from(arr.buffer);
}

function createNormalizedEmbedding(seed: number, dims = 4): Buffer {
  const arr = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    arr[i] = Math.sin(seed + i);
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += arr[i]! * arr[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) arr[i]! /= norm;
  return Buffer.from(arr.buffer);
}

function insertTestVector(db: Database.Database, collection: string, sourceId: number, preview: string, embedding: Buffer): void {
  db.prepare(
    'INSERT INTO rag_vectors (collection, source_id, text_hash, text_preview, embedding) VALUES (?, ?, ?, ?, ?)'
  ).run(collection, sourceId, `hash-${sourceId}`, preview, embedding);
}

// ── Tests ───────────────────────────────────────────────────

describe('SemanticCompressor', () => {
  let db: Database.Database;
  let compressor: SemanticCompressor;

  beforeEach(() => {
    db = createTestDb();
    compressor = new SemanticCompressor(db, { brainName: 'test', minClusterSize: 2, similarityThreshold: 0.9 });
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it('creates compressed_clusters table on migration', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compressed_clusters'").all();
    expect(tables).toHaveLength(1);
  });

  it('migration is idempotent', () => {
    runSemanticCompressorMigration(db);
    runSemanticCompressorMigration(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='compressed_clusters'").all();
    expect(tables).toHaveLength(1);
  });

  it('returns empty result for empty collection', async () => {
    const result = await compressor.compress('empty-collection');
    expect(result.clustersFound).toBe(0);
    expect(result.itemsCompressed).toBe(0);
    expect(result.metaInsightsCreated).toBe(0);
  });

  it('does not cluster items below similarity threshold', async () => {
    // Insert items with very different embeddings
    insertTestVector(db, 'test-col', 1, 'item 1', createEmbedding([1, 0, 0, 0]));
    insertTestVector(db, 'test-col', 2, 'item 2', createEmbedding([0, 1, 0, 0]));
    insertTestVector(db, 'test-col', 3, 'item 3', createEmbedding([0, 0, 1, 0]));

    const result = await compressor.compress('test-col');
    expect(result.clustersFound).toBe(0);
  });

  it('clusters similar items together', async () => {
    // Insert items with nearly identical embeddings
    const base = [0.5, 0.5, 0.5, 0.5];
    insertTestVector(db, 'test-col', 1, 'similar item 1', createEmbedding(base));
    insertTestVector(db, 'test-col', 2, 'similar item 2', createEmbedding(base));
    insertTestVector(db, 'test-col', 3, 'similar item 3', createEmbedding(base));

    const result = await compressor.compress('test-col');
    expect(result.clustersFound).toBe(1);
    expect(result.itemsCompressed).toBe(3);
    expect(result.metaInsightsCreated).toBe(1);
  });

  it('generates meta-text from previews', async () => {
    const base = [0.5, 0.5, 0.5, 0.5];
    insertTestVector(db, 'test-col', 1, 'alpha', createEmbedding(base));
    insertTestVector(db, 'test-col', 2, 'beta', createEmbedding(base));
    insertTestVector(db, 'test-col', 3, 'gamma', createEmbedding(base));

    await compressor.compress('test-col');

    const clusters = db.prepare('SELECT * FROM compressed_clusters WHERE collection = ?').all('test-col') as Array<{ summary: string }>;
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.summary).toContain('alpha');
    expect(clusters[0]!.summary).toContain('beta');
  });

  it('tracks stats correctly', async () => {
    const base = [0.5, 0.5, 0.5, 0.5];
    insertTestVector(db, 'col-a', 1, 'a1', createEmbedding(base));
    insertTestVector(db, 'col-a', 2, 'a2', createEmbedding(base));
    insertTestVector(db, 'col-a', 3, 'a3', createEmbedding(base));

    await compressor.compress('col-a');

    const stats = compressor.getStats();
    expect(stats.totalClusters).toBe(1);
    expect(stats.byCollection).toHaveLength(1);
    expect(stats.byCollection[0]!.collection).toBe('col-a');
    expect(stats.byCollection[0]!.clusterCount).toBe(1);
    expect(stats.byCollection[0]!.memberCount).toBe(3);
  });

  it('returns empty stats when no clusters exist', () => {
    const stats = compressor.getStats();
    expect(stats.totalClusters).toBe(0);
    expect(stats.byCollection).toHaveLength(0);
  });

  it('respects maxClusterSize limit', async () => {
    const compressorSmall = new SemanticCompressor(db, {
      brainName: 'test',
      minClusterSize: 2,
      maxClusterSize: 3,
      similarityThreshold: 0.9,
    });

    const base = [0.5, 0.5, 0.5, 0.5];
    for (let i = 1; i <= 6; i++) {
      insertTestVector(db, 'big-col', i, `item ${i}`, createEmbedding(base));
    }

    const result = await compressorSmall.compress('big-col');
    // With maxClusterSize=3, the 6 items should be split into 2 clusters
    expect(result.clustersFound).toBeGreaterThanOrEqual(2);
    // Each cluster should have at most 3 items
    const clusters = db.prepare('SELECT member_ids FROM compressed_clusters WHERE collection = ?').all('big-col') as Array<{ member_ids: string }>;
    for (const cluster of clusters) {
      const members: number[] = JSON.parse(cluster.member_ids);
      expect(members.length).toBeLessThanOrEqual(3);
    }
  });

  it('skips compression without rag vectors', async () => {
    // Compress a collection that has no vectors
    const result = await compressor.compress('nonexistent');
    expect(result.clustersFound).toBe(0);
  });

  it('uses LLM for summary when available', async () => {
    const mockLLM = {
      call: vi.fn().mockResolvedValue({ text: 'LLM generated summary' }),
    } as any;
    compressor.setLLMService(mockLLM);

    const base = [0.5, 0.5, 0.5, 0.5];
    insertTestVector(db, 'llm-col', 1, 'item 1', createEmbedding(base));
    insertTestVector(db, 'llm-col', 2, 'item 2', createEmbedding(base));
    insertTestVector(db, 'llm-col', 3, 'item 3', createEmbedding(base));

    await compressor.compress('llm-col');

    expect(mockLLM.call).toHaveBeenCalled();
    const clusters = db.prepare('SELECT summary FROM compressed_clusters WHERE collection = ?').all('llm-col') as Array<{ summary: string }>;
    expect(clusters[0]!.summary).toBe('LLM generated summary');
  });
});
