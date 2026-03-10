import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';
import type { RAGEngine } from '../rag/rag-engine.js';
import type { LLMService } from '../llm/llm-service.js';

// ── Types ───────────────────────────────────────────────

export interface SemanticCompressorConfig {
  brainName: string;
  /** Minimum items to form a cluster. Default: 3 */
  minClusterSize?: number;
  /** Cosine similarity threshold. Default: 0.85 */
  similarityThreshold?: number;
  /** Maximum items per cluster. Default: 20 */
  maxClusterSize?: number;
}

export interface CompressResult {
  clustersFound: number;
  itemsCompressed: number;
  metaInsightsCreated: number;
}

export interface CompressedCluster {
  id?: number;
  collection: string;
  member_ids: number[];
  summary: string;
  created_at: string;
}

export interface CompressorStats {
  totalClusters: number;
  byCollection: Array<{ collection: string; clusterCount: number; memberCount: number }>;
}

interface RAGVectorRow {
  id: number;
  collection: string;
  source_id: number;
  text_preview: string | null;
  embedding: Buffer;
}

// ── Migration ───────────────────────────────────────────

export function runSemanticCompressorMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compressed_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      member_ids TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_compressed_clusters_collection ON compressed_clusters(collection);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class SemanticCompressor {
  private readonly db: Database.Database;
  private readonly config: Required<SemanticCompressorConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;
  private rag: RAGEngine | null = null;
  private llm: LLMService | null = null;

  // ── Prepared statements ──────────────────────────────
  private readonly stmtInsertCluster: Database.Statement;
  private readonly stmtGetClusters: Database.Statement;
  private readonly stmtTotalClusters: Database.Statement;
  private readonly stmtClustersByCollection: Database.Statement;
  private readonly stmtGetVectorsByCollection: Database.Statement;

  constructor(db: Database.Database, config: SemanticCompressorConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      minClusterSize: config.minClusterSize ?? 3,
      similarityThreshold: config.similarityThreshold ?? 0.85,
      maxClusterSize: config.maxClusterSize ?? 20,
    };

    runSemanticCompressorMigration(db);

    // Also ensure rag_vectors table exists for querying
    // (RAGEngine should have already created it, but be defensive)
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
    `);

    this.stmtInsertCluster = db.prepare(`
      INSERT INTO compressed_clusters (collection, member_ids, summary)
      VALUES (?, ?, ?)
    `);

    this.stmtGetClusters = db.prepare(
      'SELECT * FROM compressed_clusters WHERE collection = ? ORDER BY created_at DESC'
    );

    this.stmtTotalClusters = db.prepare('SELECT COUNT(*) as cnt FROM compressed_clusters');

    this.stmtClustersByCollection = db.prepare(`
      SELECT collection, COUNT(*) as cluster_count, member_ids
      FROM compressed_clusters
      GROUP BY collection
    `);

    this.stmtGetVectorsByCollection = db.prepare(
      'SELECT id, collection, source_id, text_preview, embedding FROM rag_vectors WHERE collection = ?'
    );

    this.log.info(`[SemanticCompressor] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setRAGEngine(rag: RAGEngine): void { this.rag = rag; }
  setLLMService(llm: LLMService): void { this.llm = llm; }
  setThoughtStream(ts: ThoughtStream): void { this.ts = ts; }

  // ── Core Operations ──────────────────────────────────

  async compress(collection: string, threshold?: number): Promise<CompressResult> {
    const simThreshold = threshold ?? this.config.similarityThreshold;

    // Load all vectors for the collection
    const rows = this.stmtGetVectorsByCollection.all(collection) as RAGVectorRow[];

    if (rows.length === 0) {
      this.log.debug(`[SemanticCompressor] No items in collection "${collection}"`);
      return { clustersFound: 0, itemsCompressed: 0, metaInsightsCreated: 0 };
    }

    // Parse embeddings
    const items = rows.map(row => ({
      id: row.id,
      sourceId: row.source_id,
      preview: row.text_preview ?? '',
      embedding: this.parseEmbedding(row.embedding),
    }));

    // Compute pairwise cosine similarity and build adjacency
    const neighborMap = new Map<number, Set<number>>();
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const sim = this.cosineSimilarity(items[i]!.embedding, items[j]!.embedding);
        if (sim >= simThreshold) {
          if (!neighborMap.has(i)) neighborMap.set(i, new Set());
          if (!neighborMap.has(j)) neighborMap.set(j, new Set());
          neighborMap.get(i)!.add(j);
          neighborMap.get(j)!.add(i);
        }
      }
    }

    // Greedy clustering
    const assigned = new Set<number>();
    const clusters: number[][] = [];

    // Sort by neighbor count descending (most connected first)
    const indices = Array.from({ length: items.length }, (_, i) => i);
    indices.sort((a, b) => (neighborMap.get(b)?.size ?? 0) - (neighborMap.get(a)?.size ?? 0));

    for (const idx of indices) {
      if (assigned.has(idx)) continue;
      const neighbors = neighborMap.get(idx);
      if (!neighbors || neighbors.size === 0) continue;

      const cluster = [idx];
      assigned.add(idx);

      for (const neighbor of neighbors) {
        if (assigned.has(neighbor)) continue;
        if (cluster.length >= this.config.maxClusterSize) break;
        cluster.push(neighbor);
        assigned.add(neighbor);
      }

      if (cluster.length >= this.config.minClusterSize) {
        clusters.push(cluster);
      }
    }

    // Create meta-insights for each cluster
    let metaInsightsCreated = 0;
    let totalCompressed = 0;

    for (const cluster of clusters) {
      const memberIds = cluster.map(i => items[i]!.id);
      const previews = cluster.map(i => items[i]!.preview).filter(p => p.length > 0);
      const metaText = previews.join(' | ').slice(0, 500);

      let summary: string;
      if (this.llm) {
        try {
          const response = await this.llm.call(
            'summarize',
            `Summarize these related items in 1-2 sentences:\n${metaText}`,
            { maxTokens: 150, engine: 'semantic_compressor' },
          );
          summary = response?.text ?? metaText;
        } catch {
          summary = metaText;
        }
      } else {
        summary = metaText;
      }

      this.stmtInsertCluster.run(collection, JSON.stringify(memberIds), summary);
      metaInsightsCreated++;
      totalCompressed += cluster.length;
    }

    this.log.info(`[SemanticCompressor] Compressed ${totalCompressed} items into ${clusters.length} cluster(s) in "${collection}"`);
    this.ts?.emit('semantic-compressor', 'analyzing', `Compressed ${totalCompressed} items into ${clusters.length} cluster(s)`, clusters.length > 0 ? 'notable' : 'routine');

    return {
      clustersFound: clusters.length,
      itemsCompressed: totalCompressed,
      metaInsightsCreated,
    };
  }

  getStats(): CompressorStats {
    const totalRow = this.stmtTotalClusters.get() as { cnt: number };

    // Get per-collection stats
    const rows = this.stmtClustersByCollection.all() as Array<{
      collection: string;
      cluster_count: number;
      member_ids: string;
    }>;

    // We need to re-query to get accurate member counts per collection
    const byCollectionMap = new Map<string, { clusterCount: number; memberCount: number }>();

    for (const row of rows) {
      const existing = byCollectionMap.get(row.collection);
      const memberIds: number[] = JSON.parse(row.member_ids);
      if (existing) {
        existing.clusterCount++;
        existing.memberCount += memberIds.length;
      } else {
        byCollectionMap.set(row.collection, {
          clusterCount: 1,
          memberCount: memberIds.length,
        });
      }
    }

    // Actually, the GROUP BY already gives us cluster_count per collection,
    // but member_ids is only one row's value. Let's fix this by iterating all clusters.
    const allClusters = this.db.prepare('SELECT collection, member_ids FROM compressed_clusters').all() as Array<{
      collection: string;
      member_ids: string;
    }>;

    const statsMap = new Map<string, { clusterCount: number; memberCount: number }>();
    for (const cluster of allClusters) {
      const memberIds: number[] = JSON.parse(cluster.member_ids);
      const existing = statsMap.get(cluster.collection);
      if (existing) {
        existing.clusterCount++;
        existing.memberCount += memberIds.length;
      } else {
        statsMap.set(cluster.collection, {
          clusterCount: 1,
          memberCount: memberIds.length,
        });
      }
    }

    const byCollection = Array.from(statsMap.entries()).map(([collection, stats]) => ({
      collection,
      clusterCount: stats.clusterCount,
      memberCount: stats.memberCount,
    }));

    return {
      totalClusters: totalRow.cnt,
      byCollection,
    };
  }

  // ── Private Helpers ──────────────────────────────────

  private parseEmbedding(blob: Buffer): Float32Array {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length || a.length === 0) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
