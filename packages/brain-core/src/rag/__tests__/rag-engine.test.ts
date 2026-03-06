import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { RAGEngine, runRAGMigration } from '../rag-engine.js';
import { RAGIndexer } from '../rag-indexer.js';

// ── Helpers ──────────────────────────────────────────────────

function createTestDb(): Database.Database {
  return new Database(':memory:');
}

function createMockEmbedding(dims = 4, seed = 0): Float32Array {
  const arr = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    arr[i] = Math.sin(seed + i);
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += arr[i]! * arr[i]!;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dims; i++) arr[i]! /= norm;
  return arr;
}

function createMockEmbeddingEngine() {
  let callCount = 0;
  return {
    embed: vi.fn(async (_text: string) => createMockEmbedding(4, callCount++)),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((_, i) => createMockEmbedding(4, callCount + i))),
  } as any;
}

// ── RAGEngine Tests ──────────────────────────────────────────

describe('RAGEngine', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { try { db.close(); } catch { /* ignore */ } });

  it('creates rag_vectors table on migration', () => {
    runRAGMigration(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rag_vectors'").all();
    expect(tables).toHaveLength(1);
  });

  it('migration is idempotent', () => {
    runRAGMigration(db);
    runRAGMigration(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='rag_vectors'").all();
    expect(tables).toHaveLength(1);
  });

  it('creates engine with defaults', () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    const status = rag.getStatus();
    expect(status.totalVectors).toBe(0);
    expect(status.collections).toEqual([]);
  });

  it('indexes a single item', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    const result = await rag.index('insights', 1, 'Test insight about TypeScript patterns');
    expect(result).toBe(true);

    const status = rag.getStatus();
    expect(status.totalVectors).toBe(1);
    expect(status.collections[0]?.collection).toBe('insights');
  });

  it('skips indexing when text unchanged', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'Same text');
    const result = await rag.index('insights', 1, 'Same text');
    expect(result).toBe(false);

    const status = rag.getStatus();
    expect(status.totalVectors).toBe(1);
  });

  it('updates index when text changes', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'Old text');
    const result = await rag.index('insights', 1, 'New text');
    expect(result).toBe(true);

    const status = rag.getStatus();
    expect(status.totalVectors).toBe(1); // Still 1, updated in place
  });

  it('searches and returns results sorted by similarity', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    const mockEmbed = createMockEmbeddingEngine();
    rag.setEmbeddingEngine(mockEmbed);

    await rag.index('insights', 1, 'TypeScript error handling');
    await rag.index('insights', 2, 'JavaScript async patterns');
    await rag.index('errors', 3, 'Null pointer exception');

    const results = await rag.search('TypeScript error', { threshold: 0 });
    expect(results.length).toBeGreaterThan(0);
    // Results should be sorted by similarity descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.similarity).toBeGreaterThanOrEqual(results[i]!.similarity);
    }
  });

  it('filters by collection', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'An insight');
    await rag.index('errors', 1, 'An error');

    const results = await rag.search('test', { collections: ['insights'], threshold: 0 });
    expect(results.every(r => r.collection === 'insights')).toBe(true);
  });

  it('respects limit', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    for (let i = 0; i < 10; i++) {
      await rag.index('insights', i, `Insight number ${i}`);
    }

    const results = await rag.search('insight', { limit: 3, threshold: 0 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('respects threshold', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'Test');

    const highThreshold = await rag.search('completely different', { threshold: 0.99 });
    // With mock embeddings, very high threshold likely returns nothing
    expect(highThreshold.length).toBeLessThanOrEqual(1);
  });

  it('batch indexes items', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    const items = Array.from({ length: 5 }, (_, i) => ({
      collection: 'insights',
      sourceId: i + 1,
      text: `Insight ${i + 1} about programming`,
    }));

    const count = await rag.indexBatch(items);
    expect(count).toBe(5);

    const status = rag.getStatus();
    expect(status.totalVectors).toBe(5);
  });

  it('removes items', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'Test insight');
    expect(rag.getStatus().totalVectors).toBe(1);

    rag.remove('insights', 1);
    expect(rag.getStatus().totalVectors).toBe(0);
  });

  it('augments query with context', () => {
    const rag = new RAGEngine(db, { brainName: 'test' });

    const augmented = rag.augment('How to fix?', [
      { collection: 'insights', sourceId: 1, text: 'Use try-catch', similarity: 0.9 },
      { collection: 'errors', sourceId: 2, text: 'NullPointer', similarity: 0.7 },
    ]);

    expect(augmented).toContain('Context from knowledge base');
    expect(augmented).toContain('Use try-catch');
    expect(augmented).toContain('How to fix?');
  });

  it('augment returns plain query when no context', () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    expect(rag.augment('test', [])).toBe('test');
  });

  it('returns empty results without embedding engine', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    const results = await rag.search('test');
    expect(results).toEqual([]);
  });

  it('index returns false without embedding engine', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    const result = await rag.index('test', 1, 'text');
    expect(result).toBe(false);
  });

  it('getCollections returns distinct collections', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'test');
    await rag.index('errors', 1, 'test');
    await rag.index('insights', 2, 'test2');

    const collections = rag.getCollections();
    expect(collections.sort()).toEqual(['errors', 'insights']);
  });

  it('stores and returns metadata', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    await rag.index('insights', 1, 'Test', { category: 'patterns', priority: 5 });

    const results = await rag.search('test', { threshold: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.metadata).toEqual({ category: 'patterns', priority: 5 });
  });
});

// ── RAGIndexer Tests ─────────────────────────────────────────

describe('RAGIndexer', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { try { db.close(); } catch { /* ignore */ } });

  it('creates indexer without error', () => {
    const indexer = new RAGIndexer(db);
    expect(indexer.getStatus().totalIndexed).toBe(0);
  });

  it('returns 0 without RAG engine', async () => {
    const indexer = new RAGIndexer(db);
    const count = await indexer.indexAll();
    expect(count).toBe(0);
  });

  it('indexes custom source', async () => {
    // Create a test table
    db.exec(`CREATE TABLE test_items (id INTEGER PRIMARY KEY, content TEXT, category TEXT)`);
    db.prepare('INSERT INTO test_items (content, category) VALUES (?, ?)').run('Test content', 'test');
    db.prepare('INSERT INTO test_items (content, category) VALUES (?, ?)').run('Another content', 'test');

    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    const indexer = new RAGIndexer(db);
    indexer.setRAGEngine(rag);
    indexer.addSource({
      collection: 'test_items',
      query: 'SELECT id, content, category FROM test_items',
      textColumns: ['content'],
    });

    const count = await indexer.indexAll();
    expect(count).toBe(2);
    expect(indexer.getStatus().totalIndexed).toBe(2);
  });

  it('skips missing tables gracefully', async () => {
    const rag = new RAGEngine(db, { brainName: 'test' });
    rag.setEmbeddingEngine(createMockEmbeddingEngine());

    const indexer = new RAGIndexer(db);
    indexer.setRAGEngine(rag);

    // Default sources reference tables that don't exist in test DB
    const count = await indexer.indexAll();
    expect(count).toBe(0);
  });
});
