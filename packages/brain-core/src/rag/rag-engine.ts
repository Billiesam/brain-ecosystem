import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';
import type { BaseEmbeddingEngine } from '../embeddings/engine.js';
import type { LLMService } from '../llm/llm-service.js';

// ── Types ────────────────────────────────────────────────────

export interface RAGEngineConfig {
  brainName: string;
  /** Default similarity threshold for search (0-1). Default: 0.3 */
  defaultThreshold?: number;
  /** Default max results. Default: 10 */
  defaultLimit?: number;
  /** Max batch size for indexing. Default: 50 */
  batchSize?: number;
}

export interface RAGSearchOptions {
  /** Filter by collections */
  collections?: string[];
  /** Max results */
  limit?: number;
  /** Minimum similarity threshold */
  threshold?: number;
  /** Enable LLM-based reranking */
  rerank?: boolean;
}

export interface RAGResult {
  collection: string;
  sourceId: number;
  text: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface RAGIndexStats {
  collection: string;
  count: number;
}

export interface RAGStatus {
  totalVectors: number;
  collections: RAGIndexStats[];
  lastIndexedAt: string | null;
}

// ── Migration ────────────────────────────────────────────────

export function runRAGMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      text_hash TEXT NOT NULL,
      text_preview TEXT,
      embedding BLOB NOT NULL,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(collection, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rag_collection ON rag_vectors(collection);
    CREATE INDEX IF NOT EXISTS idx_rag_text_hash ON rag_vectors(text_hash);
  `);
}

// ── Engine ───────────────────────────────────────────────────

export class RAGEngine {
  private readonly db: Database.Database;
  private readonly config: Required<RAGEngineConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;
  private embedding: BaseEmbeddingEngine | null = null;
  private llm: LLMService | null = null;

  // Prepared statements
  private readonly stmtUpsert: Database.Statement;
  private readonly stmtSearch: Database.Statement;
  private readonly stmtSearchAll: Database.Statement;
  private readonly stmtGetByHash: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtStats: Database.Statement;
  private readonly stmtTotal: Database.Statement;
  private readonly stmtLastIndexed: Database.Statement;
  private readonly stmtGetCollections: Database.Statement;

  constructor(db: Database.Database, config: RAGEngineConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      defaultThreshold: config.defaultThreshold ?? 0.3,
      defaultLimit: config.defaultLimit ?? 10,
      batchSize: config.batchSize ?? 50,
    };

    runRAGMigration(db);

    this.stmtUpsert = db.prepare(`
      INSERT INTO rag_vectors (collection, source_id, text_hash, text_preview, embedding, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, source_id) DO UPDATE SET
        text_hash = excluded.text_hash,
        text_preview = excluded.text_preview,
        embedding = excluded.embedding,
        metadata = excluded.metadata,
        created_at = datetime('now')
    `);

    this.stmtSearch = db.prepare(`
      SELECT id, collection, source_id, text_preview, embedding, metadata, created_at
      FROM rag_vectors WHERE collection = ?
    `);

    this.stmtSearchAll = db.prepare(`
      SELECT id, collection, source_id, text_preview, embedding, metadata, created_at
      FROM rag_vectors
    `);

    this.stmtGetByHash = db.prepare(`
      SELECT id FROM rag_vectors WHERE collection = ? AND source_id = ? AND text_hash = ?
    `);

    this.stmtDelete = db.prepare(`DELETE FROM rag_vectors WHERE collection = ? AND source_id = ?`);

    this.stmtStats = db.prepare(`
      SELECT collection, COUNT(*) as count FROM rag_vectors GROUP BY collection
    `);

    this.stmtTotal = db.prepare(`SELECT COUNT(*) as total FROM rag_vectors`);

    this.stmtLastIndexed = db.prepare(`
      SELECT MAX(created_at) as last_indexed FROM rag_vectors
    `);

    this.stmtGetCollections = db.prepare(`SELECT DISTINCT collection FROM rag_vectors`);
  }

  setThoughtStream(stream: ThoughtStream): void { this.ts = stream; }
  setEmbeddingEngine(engine: BaseEmbeddingEngine): void { this.embedding = engine; }
  setLLMService(llm: LLMService): void { this.llm = llm; }

  /**
   * Index a single item into the RAG store.
   */
  async index(collection: string, sourceId: number, text: string, metadata?: Record<string, unknown>): Promise<boolean> {
    if (!this.embedding) {
      this.log.warn('[RAG] No embedding engine available, skipping index');
      return false;
    }

    const textHash = simpleHash(text);

    // Skip if text hasn't changed
    const existing = this.stmtGetByHash.get(collection, sourceId, textHash) as { id: number } | undefined;
    if (existing) return false;

    try {
      const vector = await this.embedding.embed(text);
      const blob = serializeEmbedding(vector);
      const preview = text.slice(0, 200);
      const meta = metadata ? JSON.stringify(metadata) : null;

      this.stmtUpsert.run(collection, sourceId, textHash, preview, blob, meta);
      return true;
    } catch (err) {
      this.log.error(`[RAG] Failed to index ${collection}:${sourceId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Batch index multiple items. Returns count of newly indexed items.
   */
  async indexBatch(items: Array<{ collection: string; sourceId: number; text: string; metadata?: Record<string, unknown> }>): Promise<number> {
    if (!this.embedding) return 0;

    this.ts?.emit('rag', 'analyzing', `Batch indexing ${items.length} items`, 'routine');

    let indexed = 0;
    const batchSize = this.config.batchSize;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);

      // Filter out unchanged items
      const toIndex = batch.filter(item => {
        const hash = simpleHash(item.text);
        const existing = this.stmtGetByHash.get(item.collection, item.sourceId, hash) as { id: number } | undefined;
        return !existing;
      });

      if (toIndex.length === 0) continue;

      // Compute embeddings in batch
      const texts = toIndex.map(item => item.text);
      const embeddings = await this.embedding.embedBatch(texts);

      const insertMany = this.db.transaction(() => {
        for (let j = 0; j < toIndex.length; j++) {
          const item = toIndex[j]!;
          const vector = embeddings[j];
          if (!vector) continue;

          const blob = serializeEmbedding(vector);
          const preview = item.text.slice(0, 200);
          const meta = item.metadata ? JSON.stringify(item.metadata) : null;
          const hash = simpleHash(item.text);

          this.stmtUpsert.run(item.collection, item.sourceId, hash, preview, blob, meta);
          indexed++;
        }
      });
      insertMany();
    }

    if (indexed > 0) {
      this.ts?.emit('rag', 'discovering', `Indexed ${indexed} new vectors`, 'notable');
    }

    return indexed;
  }

  /**
   * Search the RAG store for similar content.
   */
  async search(query: string, options?: RAGSearchOptions): Promise<RAGResult[]> {
    if (!this.embedding) return [];

    const limit = options?.limit ?? this.config.defaultLimit;
    const threshold = options?.threshold ?? this.config.defaultThreshold;
    const collections = options?.collections;

    this.ts?.emit('rag', 'analyzing', `Searching RAG: "${query.slice(0, 50)}..."`, 'routine');

    let queryVector: Float32Array;
    try {
      queryVector = await this.embedding.embed(query);
    } catch {
      return [];
    }

    // Get candidates from DB
    let rows: Array<{ id: number; collection: string; source_id: number; text_preview: string; embedding: Buffer; metadata: string | null }>;

    if (collections && collections.length > 0) {
      // Search specific collections
      const allRows: typeof rows = [];
      for (const col of collections) {
        const colRows = this.stmtSearch.all(col) as typeof rows;
        allRows.push(...colRows);
      }
      rows = allRows;
    } else {
      rows = this.stmtSearchAll.all() as typeof rows;
    }

    // Compute similarities
    const results: RAGResult[] = [];
    for (const row of rows) {
      const storedVector = deserializeEmbedding(row.embedding);
      const sim = cosineSimilarity(queryVector, storedVector);

      if (sim >= threshold) {
        results.push({
          collection: row.collection,
          sourceId: row.source_id,
          text: row.text_preview ?? '',
          similarity: Math.round(sim * 1000) / 1000,
          metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        });
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);

    // Take top-K
    const topK = results.slice(0, limit);

    // Optional reranking via LLM
    if (options?.rerank && this.llm && topK.length > 1) {
      return this.rerank(query, topK);
    }

    return topK;
  }

  /**
   * LLM-based reranking of search results.
   */
  async rerank(query: string, results: RAGResult[]): Promise<RAGResult[]> {
    if (!this.llm || results.length <= 1) return results;

    try {
      const numbered = results.map((r, i) => `[${i + 1}] ${r.text}`).join('\n');
      const prompt = `Given the query: "${query}"\n\nRank these results by relevance (most relevant first). Return ONLY the numbers in order, comma-separated:\n\n${numbered}`;

      const response = await this.llm.call('custom', prompt, { maxTokens: 100, engine: 'rag_engine' });
      if (!response) return results;

      // Parse the ranking
      const rankOrder = response.text
        .replace(/[^0-9,]/g, '')
        .split(',')
        .map((n: string) => parseInt(n.trim(), 10) - 1)
        .filter((n: number) => n >= 0 && n < results.length);

      if (rankOrder.length === 0) return results;

      // Reorder results
      const reranked: RAGResult[] = [];
      const used = new Set<number>();
      for (const idx of rankOrder) {
        if (!used.has(idx)) {
          reranked.push(results[idx]!);
          used.add(idx);
        }
      }
      // Append any missed results
      for (let i = 0; i < results.length; i++) {
        if (!used.has(i)) reranked.push(results[i]!);
      }

      return reranked;
    } catch {
      return results; // Graceful fallback
    }
  }

  /**
   * Format search results as context for an LLM prompt.
   */
  augment(query: string, context: RAGResult[]): string {
    if (context.length === 0) return query;

    const contextBlock = context
      .map((r, i) => `[${i + 1}] (${r.collection}, sim=${r.similarity}) ${r.text}`)
      .join('\n');

    return `Context from knowledge base:\n${contextBlock}\n\nQuery: ${query}`;
  }

  /**
   * Remove an item from the RAG store.
   */
  remove(collection: string, sourceId: number): void {
    this.stmtDelete.run(collection, sourceId);
  }

  /**
   * Get RAG engine status.
   */
  getStatus(): RAGStatus {
    const total = (this.stmtTotal.get() as { total: number }).total;
    const collections = this.stmtStats.all() as RAGIndexStats[];
    const lastRow = this.stmtLastIndexed.get() as { last_indexed: string | null };

    return {
      totalVectors: total,
      collections,
      lastIndexedAt: lastRow.last_indexed,
    };
  }

  /**
   * Get list of all collections.
   */
  getCollections(): string[] {
    const rows = this.stmtGetCollections.all() as Array<{ collection: string }>;
    return rows.map(r => r.collection);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(36);
}

function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function deserializeEmbedding(buffer: Buffer): Float32Array {
  const copy = Buffer.from(buffer);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return Math.max(0, Math.min(1, dot));
}
