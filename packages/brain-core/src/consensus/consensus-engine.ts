import type Database from 'better-sqlite3';
import { getLogger } from '../utils/logger.js';
import type { ThoughtStream } from '../consciousness/thought-stream.js';

// ── Types ───────────────────────────────────────────────

export interface ConsensusConfig {
  brainName: string;
  timeoutMs?: number;
  requiredMajority?: number;
  vetoThreshold?: number;
}

export type ProposalStatus = 'open' | 'resolved' | 'timeout';

export interface Proposal {
  id?: number;
  type: string;
  description: string;
  options: string[];
  context?: string;
  status: ProposalStatus;
  result?: string;
  votes: Vote[];
  createdAt?: string;
  resolvedAt?: string;
}

export interface ProposalInput {
  type: string;
  description: string;
  options: string[];
  context?: string;
}

export interface Vote {
  id?: number;
  proposalId: number;
  voter: string;
  chosenOption: string;
  confidence: number;
  reasoning?: string;
  createdAt?: string;
}

export interface ResolutionResult {
  winner: string | null;
  votes: Vote[];
  vetoed: boolean;
}

export interface ConsensusStatus {
  totalProposals: number;
  openCount: number;
  resolvedCount: number;
  avgParticipation: number;
}

// ── Migration ───────────────────────────────────────────

export function runConsensusMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consensus_proposals (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      options TEXT NOT NULL,
      context TEXT,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','timeout')),
      result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_consensus_status ON consensus_proposals(status);

    CREATE TABLE IF NOT EXISTS consensus_votes (
      id INTEGER PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES consensus_proposals(id),
      voter TEXT NOT NULL,
      chosen_option TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      reasoning TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(proposal_id, voter)
    );
    CREATE INDEX IF NOT EXISTS idx_consensus_votes_proposal ON consensus_votes(proposal_id);
  `);
}

// ── Engine ──────────────────────────────────────────────

export class ConsensusEngine {
  private readonly db: Database.Database;
  private readonly config: Required<ConsensusConfig>;
  private readonly log = getLogger();
  private ts: ThoughtStream | null = null;

  // Prepared statements
  private readonly stmtInsertProposal: Database.Statement;
  private readonly stmtGetProposal: Database.Statement;
  private readonly stmtUpdateProposalStatus: Database.Statement;
  private readonly stmtUpsertVote: Database.Statement;
  private readonly stmtGetVotes: Database.Statement;
  private readonly stmtListProposals: Database.Statement;
  private readonly stmtListByStatus: Database.Statement;
  private readonly stmtTotalProposals: Database.Statement;
  private readonly stmtOpenCount: Database.Statement;
  private readonly stmtResolvedCount: Database.Statement;
  private readonly stmtAvgVotesPerProposal: Database.Statement;

  constructor(db: Database.Database, config: ConsensusConfig) {
    this.db = db;
    this.config = {
      brainName: config.brainName,
      timeoutMs: config.timeoutMs ?? 60000,
      requiredMajority: config.requiredMajority ?? 0.5,
      vetoThreshold: config.vetoThreshold ?? 0.67,
    };

    runConsensusMigration(db);

    this.stmtInsertProposal = db.prepare(
      'INSERT INTO consensus_proposals (type, description, options, context) VALUES (?, ?, ?, ?)',
    );
    this.stmtGetProposal = db.prepare('SELECT * FROM consensus_proposals WHERE id = ?');
    this.stmtUpdateProposalStatus = db.prepare(
      'UPDATE consensus_proposals SET status = ?, result = ?, resolved_at = datetime(\'now\') WHERE id = ?',
    );
    this.stmtUpsertVote = db.prepare(
      `INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence, reasoning)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id, voter) DO UPDATE SET
         chosen_option = excluded.chosen_option,
         confidence = excluded.confidence,
         reasoning = excluded.reasoning`,
    );
    this.stmtGetVotes = db.prepare(
      'SELECT * FROM consensus_votes WHERE proposal_id = ? ORDER BY id ASC',
    );
    this.stmtListProposals = db.prepare(
      'SELECT * FROM consensus_proposals ORDER BY id DESC LIMIT ?',
    );
    this.stmtListByStatus = db.prepare(
      'SELECT * FROM consensus_proposals WHERE status = ? ORDER BY id DESC LIMIT ?',
    );
    this.stmtTotalProposals = db.prepare('SELECT COUNT(*) as cnt FROM consensus_proposals');
    this.stmtOpenCount = db.prepare("SELECT COUNT(*) as cnt FROM consensus_proposals WHERE status = 'open'");
    this.stmtResolvedCount = db.prepare("SELECT COUNT(*) as cnt FROM consensus_proposals WHERE status = 'resolved'");
    this.stmtAvgVotesPerProposal = db.prepare(
      `SELECT AVG(vote_count) as avg FROM (
         SELECT proposal_id, COUNT(*) as vote_count FROM consensus_votes GROUP BY proposal_id
       )`,
    );

    this.log.debug(`[ConsensusEngine] Initialized for ${this.config.brainName}`);
  }

  // ── Setters ──────────────────────────────────────────

  setThoughtStream(stream: ThoughtStream): void {
    this.ts = stream;
  }

  // ── Core: Propose ────────────────────────────────────

  propose(decision: ProposalInput): { id: number; type: string; status: ProposalStatus } {
    const info = this.stmtInsertProposal.run(
      decision.type,
      decision.description,
      JSON.stringify(decision.options),
      decision.context ?? null,
    );

    const id = Number(info.lastInsertRowid);

    this.ts?.emit(
      'consensus',
      'reflecting',
      `New proposal: ${decision.description.substring(0, 60)} (${decision.options.length} options)`,
      'notable',
    );

    this.log.debug(`[ConsensusEngine] Proposal #${id}: ${decision.type}`);

    return { id, type: decision.type, status: 'open' };
  }

  // ── Core: Vote ───────────────────────────────────────

  vote(proposalId: number, option: string, confidence: number, reasoning?: string): Vote {
    this.stmtUpsertVote.run(
      proposalId,
      this.config.brainName,
      option,
      confidence,
      reasoning ?? null,
    );

    this.ts?.emit(
      'consensus',
      'reflecting',
      `Voted on proposal #${proposalId}: ${option} (confidence=${confidence.toFixed(2)})`,
      'routine',
    );

    this.log.debug(`[ConsensusEngine] Vote on #${proposalId}: ${option} (${confidence.toFixed(2)})`);

    return {
      proposalId,
      voter: this.config.brainName,
      chosenOption: option,
      confidence,
      reasoning,
    };
  }

  // ── Core: Resolve ────────────────────────────────────

  resolve(proposalId: number): ResolutionResult {
    const proposal = this.getProposal(proposalId);
    if (!proposal) {
      return { winner: null, votes: [], vetoed: false };
    }

    const votes = proposal.votes;
    if (votes.length === 0) {
      return { winner: null, votes: [], vetoed: false };
    }

    // Determine majority requirement
    const isSelfmod = proposal.type === 'selfmod_approval';
    const requiredMajority = isSelfmod ? 2 / 3 : this.config.requiredMajority;

    // Count votes per option
    const voteCounts = new Map<string, { count: number; totalConfidence: number; voters: string[] }>();
    for (const v of votes) {
      const entry = voteCounts.get(v.chosenOption) ?? { count: 0, totalConfidence: 0, voters: [] };
      entry.count++;
      entry.totalConfidence += v.confidence;
      entry.voters.push(v.voter);
      voteCounts.set(v.chosenOption, entry);
    }

    // Check for veto: single dissenter with high confidence
    let vetoed = false;
    if (votes.length > 1) {
      for (const v of votes) {
        const entry = voteCounts.get(v.chosenOption)!;
        // This voter is the only one for their option and has high confidence
        if (entry.count === 1 && v.confidence > this.config.vetoThreshold) {
          // Check if all other votes agree on a different option
          const otherVotes = votes.filter(ov => ov.voter !== v.voter);
          const otherOptions = new Set(otherVotes.map(ov => ov.chosenOption));
          if (otherOptions.size === 1) {
            vetoed = true;
            break;
          }
        }
      }
    }

    // Find winner
    let winner: string | null = null;
    let maxCount = 0;
    for (const [option, entry] of voteCounts) {
      if (entry.count > maxCount) {
        maxCount = entry.count;
        winner = option;
      }
    }

    // Check if majority reached
    if (winner && maxCount / votes.length < requiredMajority) {
      winner = null; // Not enough votes for majority
    }

    // Update proposal status
    const status = vetoed ? 'resolved' : (winner ? 'resolved' : 'open');
    if (status === 'resolved') {
      const resultText = vetoed ? `VETOED (proposed: ${winner})` : winner;
      this.stmtUpdateProposalStatus.run('resolved', resultText, proposalId);
    }

    this.ts?.emit(
      'consensus',
      'discovering',
      `Proposal #${proposalId} ${vetoed ? 'VETOED' : (winner ? `resolved: ${winner}` : 'no majority')}`,
      vetoed ? 'breakthrough' : 'notable',
    );

    return { winner: vetoed ? null : winner, votes, vetoed };
  }

  // ── Core: Get Proposal ───────────────────────────────

  getProposal(id: number): Proposal | null {
    const row = this.stmtGetProposal.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const votes = this.loadVotes(id);
    return this.toProposal(row, votes);
  }

  // ── Core: History ────────────────────────────────────

  getHistory(status?: ProposalStatus, limit = 20): Proposal[] {
    const rows = status
      ? (this.stmtListByStatus.all(status, limit) as Record<string, unknown>[])
      : (this.stmtListProposals.all(limit) as Record<string, unknown>[]);

    return rows.map(r => {
      const votes = this.loadVotes(r.id as number);
      return this.toProposal(r, votes);
    });
  }

  // ── Core: Status ─────────────────────────────────────

  getStatus(): ConsensusStatus {
    const totalProposals = (this.stmtTotalProposals.get() as { cnt: number }).cnt;
    const openCount = (this.stmtOpenCount.get() as { cnt: number }).cnt;
    const resolvedCount = (this.stmtResolvedCount.get() as { cnt: number }).cnt;
    const avgRow = this.stmtAvgVotesPerProposal.get() as { avg: number | null };
    const avgParticipation = avgRow.avg ?? 0;

    return { totalProposals, openCount, resolvedCount, avgParticipation };
  }

  // ── Core: Timeout ────────────────────────────────────

  timeoutProposal(proposalId: number): boolean {
    const proposal = this.getProposal(proposalId);
    if (!proposal || proposal.status !== 'open') return false;

    this.stmtUpdateProposalStatus.run('timeout', null, proposalId);

    this.ts?.emit('consensus', 'reflecting', `Proposal #${proposalId} timed out`, 'routine');

    return true;
  }

  // ── Private: Vote Loading ────────────────────────────

  private loadVotes(proposalId: number): Vote[] {
    const rows = this.stmtGetVotes.all(proposalId) as Record<string, unknown>[];
    return rows.map(r => this.toVote(r));
  }

  // ── Private: Row Mapping ─────────────────────────────

  private toProposal(row: Record<string, unknown>, votes: Vote[]): Proposal {
    let options: string[] = [];
    try {
      options = JSON.parse((row.options as string) || '[]');
    } catch { /* ignore */ }

    return {
      id: row.id as number,
      type: row.type as string,
      description: row.description as string,
      options,
      context: (row.context as string) ?? undefined,
      status: row.status as ProposalStatus,
      result: (row.result as string) ?? undefined,
      votes,
      createdAt: row.created_at as string,
      resolvedAt: (row.resolved_at as string) ?? undefined,
    };
  }

  private toVote(row: Record<string, unknown>): Vote {
    return {
      id: row.id as number,
      proposalId: row.proposal_id as number,
      voter: row.voter as string,
      chosenOption: row.chosen_option as string,
      confidence: row.confidence as number,
      reasoning: (row.reasoning as string) ?? undefined,
      createdAt: row.created_at as string,
    };
  }
}
