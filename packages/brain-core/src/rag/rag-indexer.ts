import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { RAGEngine } from './rag-engine.js';

// ── Types ────────────────────────────────────────────────────

export interface RAGIndexerConfig {
  /** Collections to auto-index. Default: all known collections */
  collections?: string[];
  /** Batch size for indexing. Default: 50 */
  batchSize?: number;
}

export interface IndexSource {
  collection: string;
  query: string;
  textColumns: string[];
  idColumn?: string;
  timestampColumn?: string;
}

export interface IndexerStatus {
  lastRun: string | null;
  totalIndexed: number;
  sources: Array<{ collection: string; count: number }>;
}

// ── Default Sources ──────────────────────────────────────────

const DEFAULT_SOURCES: IndexSource[] = [
  {
    collection: 'insights',
    query: `SELECT id, title, description, created_at FROM insights WHERE description IS NOT NULL`,
    textColumns: ['title', 'description'],
    timestampColumn: 'created_at',
  },
  {
    collection: 'memories',
    query: `SELECT id, key, content, category FROM memories WHERE content IS NOT NULL`,
    textColumns: ['key', 'content'],
    timestampColumn: undefined,
  },
  {
    collection: 'principles',
    query: `SELECT id, domain, statement, source FROM knowledge_principles WHERE statement IS NOT NULL`,
    textColumns: ['domain', 'statement'],
    timestampColumn: undefined,
  },
  {
    collection: 'errors',
    query: `SELECT id, type, message, context FROM errors WHERE message IS NOT NULL`,
    textColumns: ['type', 'message'],
    timestampColumn: undefined,
  },
  {
    collection: 'solutions',
    query: `SELECT id, description, steps, context FROM solutions WHERE description IS NOT NULL`,
    textColumns: ['description', 'steps'],
    timestampColumn: undefined,
  },
  {
    collection: 'rules',
    query: `SELECT id, pattern, action, description FROM rules WHERE pattern IS NOT NULL`,
    textColumns: ['pattern', 'action'],
    timestampColumn: undefined,
  },
];

// ── Indexer ──────────────────────────────────────────────────

export class RAGIndexer {
  private readonly db: Database.Database;
  private readonly config: Required<RAGIndexerConfig>;
  private readonly log = getLogger();
  private rag: RAGEngine | null = null;
  private lastRun: string | null = null;
  private totalIndexed = 0;
  private sourceCounts: Map<string, number> = new Map();
  private customSources: IndexSource[] = [];

  constructor(db: Database.Database, config?: RAGIndexerConfig) {
    this.db = db;
    this.config = {
      collections: config?.collections ?? [],
      batchSize: config?.batchSize ?? 50,
    };
  }

  setRAGEngine(rag: RAGEngine): void { this.rag = rag; }

  /**
   * Register a custom index source (for brain-specific tables).
   */
  addSource(source: IndexSource): void {
    this.customSources.push(source);
  }

  /**
   * Run full indexing over all available sources.
   * Only indexes tables that actually exist in the database.
   */
  async indexAll(): Promise<number> {
    if (!this.rag) {
      this.log.warn('[RAGIndexer] No RAG engine set, skipping');
      return 0;
    }

    const allSources = [...DEFAULT_SOURCES, ...this.customSources];
    const filteredSources = this.config.collections.length > 0
      ? allSources.filter(s => this.config.collections.includes(s.collection))
      : allSources;

    let totalNew = 0;

    for (const source of filteredSources) {
      try {
        const count = await this.indexSource(source);
        totalNew += count;
        this.sourceCounts.set(source.collection, (this.sourceCounts.get(source.collection) ?? 0) + count);
      } catch (err) {
        // Table might not exist in this brain — skip gracefully
        const msg = (err as Error).message;
        if (msg.includes('no such table') || msg.includes('no such column')) {
          this.log.debug(`[RAGIndexer] Skipping ${source.collection}: table not found`);
        } else {
          this.log.error(`[RAGIndexer] Error indexing ${source.collection}: ${msg}`);
        }
      }
    }

    this.lastRun = new Date().toISOString();
    this.totalIndexed += totalNew;

    if (totalNew > 0) {
      this.log.info(`[RAGIndexer] Indexed ${totalNew} new items across ${filteredSources.length} sources`);
    }

    return totalNew;
  }

  /**
   * Index a single source.
   */
  private async indexSource(source: IndexSource): Promise<number> {
    if (!this.rag) return 0;

    const rows = this.db.prepare(source.query).all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return 0;

    const items = rows.map(row => {
      const id = row[source.idColumn ?? 'id'] as number;
      const text = source.textColumns
        .map(col => row[col] as string ?? '')
        .filter(Boolean)
        .join(' | ');

      // Build metadata from all non-text, non-id columns
      const metadata: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (key !== (source.idColumn ?? 'id') && !source.textColumns.includes(key) && value != null) {
          metadata[key] = value;
        }
      }

      return { collection: source.collection, sourceId: id, text, metadata };
    });

    return this.rag.indexBatch(items);
  }

  /**
   * Get indexer status.
   */
  getStatus(): IndexerStatus {
    const sources: Array<{ collection: string; count: number }> = [];
    for (const [collection, count] of this.sourceCounts) {
      sources.push({ collection, count });
    }

    return {
      lastRun: this.lastRun,
      totalIndexed: this.totalIndexed,
      sources,
    };
  }
}
