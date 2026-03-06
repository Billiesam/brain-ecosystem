// ── Tool Pattern Analyzer — Sequence & Transition Analysis ───
//
// Analyzes tool usage sequences to find patterns, build Markov
// transition matrices, and predict likely next tools.

import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';

// ── Types ───────────────────────────────────────────────

export interface ToolSequence {
  sequence: string[];
  count: number;
}

export interface ToolPrediction {
  tool: string;
  probability: number;
}

export interface ToolPair {
  toolA: string;
  toolB: string;
  count: number;
}

/** A single from→to transition with its count. */
export interface ToolTransition {
  from: string;
  to: string;
  count: number;
}

// ── Engine ──────────────────────────────────────────────

export class ToolPatternAnalyzer {
  private db: Database.Database;
  private log = getLogger();

  // Prepared statements
  private stmtAllUsage: Database.Statement;
  private stmtWindowUsage: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // These statements query the tool_usage table created by ToolTracker
    this.stmtAllUsage = db.prepare(`
      SELECT tool_name, created_at FROM tool_usage ORDER BY created_at ASC
    `);

    this.stmtWindowUsage = db.prepare(`
      SELECT tool_name, created_at FROM tool_usage ORDER BY created_at ASC
    `);

    this.log.info('[tool-patterns] Analyzer initialized');
  }

  /**
   * Find common tool sequences (N-grams) of the given window size.
   * Returns sequences sorted by frequency descending.
   */
  getSequences(windowSize = 3): ToolSequence[] {
    const rows = this.stmtAllUsage.all() as Array<{ tool_name: string; created_at: string }>;

    if (rows.length < windowSize) return [];

    const seqMap = new Map<string, number>();

    for (let i = 0; i <= rows.length - windowSize; i++) {
      const seq = rows.slice(i, i + windowSize).map(r => r.tool_name);
      const key = seq.join(' → ');
      seqMap.set(key, (seqMap.get(key) ?? 0) + 1);
    }

    const sequences: ToolSequence[] = [];
    for (const [key, count] of seqMap.entries()) {
      if (count >= 2) {
        sequences.push({ sequence: key.split(' → '), count });
      }
    }

    sequences.sort((a, b) => b.count - a.count);
    return sequences;
  }

  /**
   * Build a Markov transition matrix: which tool follows which.
   * Returns Map<toolA, Map<toolB, count>>.
   */
  getTransitions(): Map<string, Map<string, number>> {
    const rows = this.stmtAllUsage.all() as Array<{ tool_name: string; created_at: string }>;
    const transitions = new Map<string, Map<string, number>>();

    for (let i = 0; i < rows.length - 1; i++) {
      const from = rows[i]!.tool_name;
      const to = rows[i + 1]!.tool_name;

      if (!transitions.has(from)) {
        transitions.set(from, new Map());
      }
      const inner = transitions.get(from)!;
      inner.set(to, (inner.get(to) ?? 0) + 1);
    }

    return transitions;
  }

  /**
   * Predict the top 3 most likely next tools given the current tool,
   * based on transition probabilities from the Markov chain.
   */
  predictNext(currentTool: string): ToolPrediction[] {
    const transitions = this.getTransitions();
    const fromMap = transitions.get(currentTool);

    if (!fromMap || fromMap.size === 0) return [];

    // Calculate total transitions from this tool
    let total = 0;
    for (const count of fromMap.values()) {
      total += count;
    }

    const predictions: ToolPrediction[] = [];
    for (const [tool, count] of fromMap.entries()) {
      predictions.push({
        tool,
        probability: count / total,
      });
    }

    predictions.sort((a, b) => b.probability - a.probability);
    return predictions.slice(0, 3);
  }

  /**
   * Find tool pairs that frequently occur together within 5-minute windows.
   * Returns pairs sorted by co-occurrence count descending.
   */
  getFrequentPairs(): ToolPair[] {
    const rows = this.stmtWindowUsage.all() as Array<{ tool_name: string; created_at: string }>;

    if (rows.length < 2) return [];

    const pairMap = new Map<string, number>();
    const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    for (let i = 0; i < rows.length; i++) {
      const timeI = new Date(rows[i]!.created_at).getTime();

      for (let j = i + 1; j < rows.length; j++) {
        const timeJ = new Date(rows[j]!.created_at).getTime();

        if (timeJ - timeI > WINDOW_MS) break;

        const toolA = rows[i]!.tool_name;
        const toolB = rows[j]!.tool_name;

        if (toolA === toolB) continue;

        // Normalize pair key (alphabetical order) so A-B and B-A count together
        const key = toolA < toolB ? `${toolA}|${toolB}` : `${toolB}|${toolA}`;
        pairMap.set(key, (pairMap.get(key) ?? 0) + 1);
      }
    }

    const pairs: ToolPair[] = [];
    for (const [key, count] of pairMap.entries()) {
      if (count >= 2) {
        const [toolA, toolB] = key.split('|') as [string, string];
        pairs.push({ toolA, toolB, count });
      }
    }

    pairs.sort((a, b) => b.count - a.count);
    return pairs;
  }
}
