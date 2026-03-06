import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';
import type { LLMService } from '../llm/llm-service.js';

// ── Types ───────────────────────────────────────────────

export interface KnowledgeGraphConfig {
  brainName: string;
  /** Maximum transitive inference depth. Default: 3 */
  maxInferenceDepth?: number;
  /** Minimum confidence to consider a fact "high confidence". Default: 0.5 */
  highConfidenceThreshold?: number;
}

export interface KnowledgeFact {
  id?: number;
  subject: string;
  predicate: string;
  object: string;
  context: string | null;
  confidence: number;
  evidence_count: number;
  source_type: string | null;
  source_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FactQuery {
  subject?: string;
  predicate?: string;
  object?: string;
}

export interface InferenceChain {
  path: KnowledgeFact[];
  startSubject: string;
  endObject: string;
  predicate: string;
  confidence: number;
}

export interface Contradiction {
  subject: string;
  predicate: string;
  facts: KnowledgeFact[];
}

export interface KnowledgeGraphStatus {
  totalFacts: number;
  predicateDistribution: Record<string, number>;
  avgConfidence: number;
}

// ── Migration ───────────────────────────────────────────

export function runKnowledgeGraphMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 0.5,
      evidence_count INTEGER DEFAULT 1,
      source_type TEXT,
      source_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_facts_subject ON knowledge_facts(subject);
    CREATE INDEX IF NOT EXISTS idx_knowledge_facts_predicate ON knowledge_facts(predicate);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class KnowledgeGraphEngine {
  private readonly db: Database.Database;
  private readonly config: Required<KnowledgeGraphConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;
  private llm: LLMService | null = null;

  // ── Prepared statements ──────────────────────────────
  private readonly stmtInsertFact: Database.Statement;
  private readonly stmtFindExact: Database.Statement;
  private readonly stmtUpdateFact: Database.Statement;
  private readonly stmtQueryAll: Database.Statement;
  private readonly stmtQueryBySubject: Database.Statement;
  private readonly stmtQueryByPredicate: Database.Statement;
  private readonly stmtQueryByObject: Database.Statement;
  private readonly stmtQueryBySubjectPredicate: Database.Statement;
  private readonly stmtQueryBySubjectObject: Database.Statement;
  private readonly stmtQueryByPredicateObject: Database.Statement;
  private readonly stmtQueryExact: Database.Statement;
  private readonly stmtGetBySubjectPredicate: Database.Statement;
  private readonly stmtGetNeighbors: Database.Statement;
  private readonly stmtTotalFacts: Database.Statement;
  private readonly stmtPredicateDistribution: Database.Statement;
  private readonly stmtAvgConfidence: Database.Statement;

  constructor(db: Database.Database, config: KnowledgeGraphConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      maxInferenceDepth: config.maxInferenceDepth ?? 3,
      highConfidenceThreshold: config.highConfidenceThreshold ?? 0.5,
    };

    runKnowledgeGraphMigration(db);

    // Prepare statements
    this.stmtInsertFact = db.prepare(`
      INSERT INTO knowledge_facts (subject, predicate, object, context, confidence, evidence_count, source_type, source_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtFindExact = db.prepare(`
      SELECT * FROM knowledge_facts WHERE subject = ? AND predicate = ? AND object = ?
    `);

    this.stmtUpdateFact = db.prepare(`
      UPDATE knowledge_facts SET evidence_count = ?, confidence = ?, context = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    this.stmtQueryAll = db.prepare('SELECT * FROM knowledge_facts ORDER BY confidence DESC');

    this.stmtQueryBySubject = db.prepare(
      'SELECT * FROM knowledge_facts WHERE subject = ? ORDER BY confidence DESC'
    );

    this.stmtQueryByPredicate = db.prepare(
      'SELECT * FROM knowledge_facts WHERE predicate = ? ORDER BY confidence DESC'
    );

    this.stmtQueryByObject = db.prepare(
      'SELECT * FROM knowledge_facts WHERE object = ? ORDER BY confidence DESC'
    );

    this.stmtQueryBySubjectPredicate = db.prepare(
      'SELECT * FROM knowledge_facts WHERE subject = ? AND predicate = ? ORDER BY confidence DESC'
    );

    this.stmtQueryBySubjectObject = db.prepare(
      'SELECT * FROM knowledge_facts WHERE subject = ? AND object = ? ORDER BY confidence DESC'
    );

    this.stmtQueryByPredicateObject = db.prepare(
      'SELECT * FROM knowledge_facts WHERE predicate = ? AND object = ? ORDER BY confidence DESC'
    );

    this.stmtQueryExact = db.prepare(
      'SELECT * FROM knowledge_facts WHERE subject = ? AND predicate = ? AND object = ? ORDER BY confidence DESC'
    );

    this.stmtGetBySubjectPredicate = db.prepare(
      'SELECT * FROM knowledge_facts WHERE subject = ? AND predicate = ? AND confidence > ? ORDER BY confidence DESC'
    );

    this.stmtGetNeighbors = db.prepare(
      'SELECT * FROM knowledge_facts WHERE subject = ? OR object = ?'
    );

    this.stmtTotalFacts = db.prepare('SELECT COUNT(*) as cnt FROM knowledge_facts');
    this.stmtPredicateDistribution = db.prepare(
      'SELECT predicate, COUNT(*) as cnt FROM knowledge_facts GROUP BY predicate ORDER BY cnt DESC'
    );
    this.stmtAvgConfidence = db.prepare('SELECT AVG(confidence) as avg FROM knowledge_facts');

    this.log.info(`[KnowledgeGraph] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setThoughtStream(ts: ThoughtStream): void { this.ts = ts; }
  setLLMService(llm: LLMService): void { this.llm = llm; }

  // ── Core Operations ──────────────────────────────────

  addFact(
    subject: string,
    predicate: string,
    object: string,
    context?: string,
    confidence?: number,
    sourceType?: string,
    sourceId?: string,
  ): KnowledgeFact {
    const existing = this.stmtFindExact.get(subject, predicate, object) as KnowledgeFact | undefined;

    if (existing) {
      const newEvidenceCount = existing.evidence_count + 1;
      const newConfidence = confidence !== undefined
        ? Math.min(1, (existing.confidence + confidence) / 2 + 0.05)
        : Math.min(1, existing.confidence + 0.05);
      const newContext = context ?? existing.context;

      this.stmtUpdateFact.run(newEvidenceCount, newConfidence, newContext, existing.id);

      this.log.debug(`[KnowledgeGraph] Updated fact: (${subject}, ${predicate}, ${object}) evidence=${newEvidenceCount}`);
      this.ts?.emit('knowledge-graph', 'analyzing', `Updated fact: ${subject} ${predicate} ${object}`, 'routine');

      return {
        ...existing,
        evidence_count: newEvidenceCount,
        confidence: newConfidence,
        context: newContext,
      };
    }

    const result = this.stmtInsertFact.run(
      subject, predicate, object,
      context ?? null,
      confidence ?? 0.5,
      1,
      sourceType ?? null,
      sourceId ?? null,
    );

    this.log.debug(`[KnowledgeGraph] Added fact: (${subject}, ${predicate}, ${object})`);
    this.ts?.emit('knowledge-graph', 'discovering', `New fact: ${subject} ${predicate} ${object}`, 'notable');

    return {
      id: Number(result.lastInsertRowid),
      subject,
      predicate,
      object,
      context: context ?? null,
      confidence: confidence ?? 0.5,
      evidence_count: 1,
      source_type: sourceType ?? null,
      source_id: sourceId ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  query(filter: FactQuery): KnowledgeFact[] {
    const hasSubject = filter.subject !== undefined;
    const hasPredicate = filter.predicate !== undefined;
    const hasObject = filter.object !== undefined;

    if (hasSubject && hasPredicate && hasObject) {
      return this.stmtQueryExact.all(filter.subject, filter.predicate, filter.object) as KnowledgeFact[];
    }
    if (hasSubject && hasPredicate) {
      return this.stmtQueryBySubjectPredicate.all(filter.subject, filter.predicate) as KnowledgeFact[];
    }
    if (hasSubject && hasObject) {
      return this.stmtQueryBySubjectObject.all(filter.subject, filter.object) as KnowledgeFact[];
    }
    if (hasPredicate && hasObject) {
      return this.stmtQueryByPredicateObject.all(filter.predicate, filter.object) as KnowledgeFact[];
    }
    if (hasSubject) {
      return this.stmtQueryBySubject.all(filter.subject) as KnowledgeFact[];
    }
    if (hasPredicate) {
      return this.stmtQueryByPredicate.all(filter.predicate) as KnowledgeFact[];
    }
    if (hasObject) {
      return this.stmtQueryByObject.all(filter.object) as KnowledgeFact[];
    }

    return this.stmtQueryAll.all() as KnowledgeFact[];
  }

  infer(subject: string, predicate: string): InferenceChain[] {
    const chains: InferenceChain[] = [];
    const maxDepth = this.config.maxInferenceDepth;

    // BFS-style transitive inference
    // If A-rel-B and B-rel-C, then A-rel-C (transitively)
    const visited = new Set<string>();
    const queue: Array<{ node: string; path: KnowledgeFact[]; depth: number }> = [];

    // Get direct facts for subject+predicate
    const directFacts = this.stmtQueryBySubjectPredicate.all(subject, predicate) as KnowledgeFact[];

    for (const fact of directFacts) {
      visited.add(fact.object);
      queue.push({ node: fact.object, path: [fact], depth: 1 });
    }

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.depth >= maxDepth) {
        // At max depth, record the chain if it has more than 1 hop
        if (current.path.length > 1) {
          const chainConfidence = current.path.reduce((acc, f) => acc * f.confidence, 1);
          chains.push({
            path: current.path,
            startSubject: subject,
            endObject: current.node,
            predicate,
            confidence: chainConfidence,
          });
        }
        continue;
      }

      // Follow the chain: current.node -predicate-> ?
      const nextFacts = this.stmtQueryBySubjectPredicate.all(current.node, predicate) as KnowledgeFact[];

      if (nextFacts.length === 0 && current.path.length > 1) {
        // Dead end with multi-hop path - record chain
        const chainConfidence = current.path.reduce((acc, f) => acc * f.confidence, 1);
        chains.push({
          path: current.path,
          startSubject: subject,
          endObject: current.node,
          predicate,
          confidence: chainConfidence,
        });
      }

      for (const fact of nextFacts) {
        if (!visited.has(fact.object)) {
          visited.add(fact.object);
          queue.push({
            node: fact.object,
            path: [...current.path, fact],
            depth: current.depth + 1,
          });
        }
      }
    }

    this.log.debug(`[KnowledgeGraph] Inferred ${chains.length} chain(s) for (${subject}, ${predicate}, ?)`);
    return chains;
  }

  contradictions(): Contradiction[] {
    const threshold = this.config.highConfidenceThreshold;
    const result: Contradiction[] = [];

    // Get all subject+predicate combos that have multiple high-confidence objects
    const allFacts = this.stmtQueryAll.all() as KnowledgeFact[];

    // Group by subject+predicate
    const groups = new Map<string, KnowledgeFact[]>();
    for (const fact of allFacts) {
      const key = `${fact.subject}||${fact.predicate}`;
      const list = groups.get(key) ?? [];
      list.push(fact);
      groups.set(key, list);
    }

    for (const [, facts] of groups) {
      // Filter to high-confidence facts
      const highConf = facts.filter(f => f.confidence > threshold);
      if (highConf.length > 1) {
        // Check if objects differ
        const uniqueObjects = new Set(highConf.map(f => f.object));
        if (uniqueObjects.size > 1) {
          result.push({
            subject: highConf[0]!.subject,
            predicate: highConf[0]!.predicate,
            facts: highConf,
          });
        }
      }
    }

    this.log.debug(`[KnowledgeGraph] Found ${result.length} contradiction(s)`);
    this.ts?.emit('knowledge-graph', 'analyzing', `Found ${result.length} contradiction(s)`, result.length > 0 ? 'notable' : 'routine');

    return result;
  }

  subgraph(topic: string, depth: number): KnowledgeFact[] {
    const visited = new Set<string>();
    const result: KnowledgeFact[] = [];
    const queue: Array<{ node: string; currentDepth: number }> = [{ node: topic, currentDepth: 0 }];
    visited.add(topic);

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.currentDepth >= depth) continue;

      const neighbors = this.stmtGetNeighbors.all(current.node, current.node) as KnowledgeFact[];

      for (const fact of neighbors) {
        // Add fact if not already in result (by id)
        if (!result.some(r => r.id === fact.id)) {
          result.push(fact);
        }

        // Explore both subject and object sides
        const nextNode = fact.subject === current.node ? fact.object : fact.subject;
        if (!visited.has(nextNode)) {
          visited.add(nextNode);
          queue.push({ node: nextNode, currentDepth: current.currentDepth + 1 });
        }
      }
    }

    this.log.debug(`[KnowledgeGraph] Subgraph for "${topic}" depth=${depth}: ${result.length} fact(s)`);
    return result;
  }

  getStatus(): KnowledgeGraphStatus {
    const totalRow = this.stmtTotalFacts.get() as { cnt: number };
    const distRows = this.stmtPredicateDistribution.all() as Array<{ predicate: string; cnt: number }>;
    const avgRow = this.stmtAvgConfidence.get() as { avg: number | null };

    const predicateDistribution: Record<string, number> = {};
    for (const row of distRows) {
      predicateDistribution[row.predicate] = row.cnt;
    }

    return {
      totalFacts: totalRow.cnt,
      predicateDistribution,
      avgConfidence: avgRow.avg ?? 0,
    };
  }
}
