import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ConsensusEngine, runConsensusMigration } from '../consensus-engine.js';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('ConsensusEngine', () => {
  let db: Database.Database;
  let engine: ConsensusEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    engine = new ConsensusEngine(db, { brainName: 'brain' });
  });

  afterEach(() => {
    db.close();
  });

  it('propose creates a record', () => {
    const result = engine.propose({
      type: 'feature_decision',
      description: 'Should we add caching?',
      options: ['yes', 'no', 'defer'],
      context: 'Performance is degrading',
    });

    expect(result.id).toBeDefined();
    expect(result.type).toBe('feature_decision');
    expect(result.status).toBe('open');

    // Verify persisted
    const proposal = engine.getProposal(result.id);
    expect(proposal).not.toBeNull();
    expect(proposal!.description).toBe('Should we add caching?');
    expect(proposal!.options).toEqual(['yes', 'no', 'defer']);
    expect(proposal!.context).toBe('Performance is degrading');
  });

  it('vote records a choice', () => {
    const proposal = engine.propose({
      type: 'decision',
      description: 'Test vote',
      options: ['A', 'B'],
    });

    const vote = engine.vote(proposal.id, 'A', 0.8, 'I prefer A');
    expect(vote.voter).toBe('brain');
    expect(vote.chosenOption).toBe('A');
    expect(vote.confidence).toBe(0.8);
    expect(vote.reasoning).toBe('I prefer A');

    // Verify persisted
    const full = engine.getProposal(proposal.id);
    expect(full!.votes.length).toBe(1);
    expect(full!.votes[0].chosenOption).toBe('A');
  });

  it('vote upserts for same voter', () => {
    const proposal = engine.propose({
      type: 'decision',
      description: 'Upsert test',
      options: ['A', 'B'],
    });

    engine.vote(proposal.id, 'A', 0.5);
    engine.vote(proposal.id, 'B', 0.9, 'Changed my mind');

    const full = engine.getProposal(proposal.id);
    expect(full!.votes.length).toBe(1); // Still one vote from same voter
    expect(full!.votes[0].chosenOption).toBe('B');
    expect(full!.votes[0].confidence).toBe(0.9);
  });

  it('resolve determines simple majority winner', () => {
    const proposal = engine.propose({
      type: 'decision',
      description: 'Majority test',
      options: ['A', 'B'],
    });

    // Insert votes from different "brains" directly into DB
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'brain', 'A', 0.7);
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'trading-brain', 'A', 0.6);
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'marketing-brain', 'B', 0.5);

    const result = engine.resolve(proposal.id);
    expect(result.winner).toBe('A');
    expect(result.vetoed).toBe(false);
    expect(result.votes.length).toBe(3);
  });

  it('resolve requires 2/3 majority for selfmod_approval', () => {
    const proposal = engine.propose({
      type: 'selfmod_approval',
      description: 'Self-mod vote',
      options: ['approve', 'reject'],
    });

    // 2 approve, 1 reject → 66.7% which equals 2/3
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'brain', 'approve', 0.8);
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'trading-brain', 'approve', 0.7);
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'marketing-brain', 'reject', 0.4);

    const result = engine.resolve(proposal.id);
    // 2/3 = 0.667, votes are 2/3 = 0.667 which matches >= requiredMajority
    expect(result.winner).toBe('approve');
    expect(result.vetoed).toBe(false);
  });

  it('veto detection when lone dissenter has high confidence', () => {
    const proposal = engine.propose({
      type: 'decision',
      description: 'Veto test',
      options: ['go', 'stop'],
    });

    // Two agree, one dissents with very high confidence
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'brain', 'go', 0.6);
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'trading-brain', 'go', 0.5);
    db.prepare(
      'INSERT INTO consensus_votes (proposal_id, voter, chosen_option, confidence) VALUES (?, ?, ?, ?)',
    ).run(proposal.id, 'marketing-brain', 'stop', 0.8); // > 0.67 vetoThreshold

    const result = engine.resolve(proposal.id);
    expect(result.vetoed).toBe(true);
    expect(result.winner).toBeNull();
  });

  it('timeout status can be set', () => {
    const proposal = engine.propose({
      type: 'decision',
      description: 'Timeout test',
      options: ['A', 'B'],
    });

    const success = engine.timeoutProposal(proposal.id);
    expect(success).toBe(true);

    const updated = engine.getProposal(proposal.id);
    expect(updated!.status).toBe('timeout');
  });

  it('getProposal returns proposal with all votes', () => {
    const proposal = engine.propose({
      type: 'test',
      description: 'Full proposal',
      options: ['X', 'Y'],
    });

    engine.vote(proposal.id, 'X', 0.9, 'Strong preference');

    const full = engine.getProposal(proposal.id);
    expect(full).not.toBeNull();
    expect(full!.type).toBe('test');
    expect(full!.votes.length).toBe(1);
    expect(full!.votes[0].chosenOption).toBe('X');
    expect(full!.votes[0].reasoning).toBe('Strong preference');
  });

  it('getHistory returns proposals in order', () => {
    engine.propose({ type: 'a', description: 'First', options: ['1'] });
    engine.propose({ type: 'b', description: 'Second', options: ['2'] });
    const p3 = engine.propose({ type: 'c', description: 'Third', options: ['3'] });

    const all = engine.getHistory();
    expect(all.length).toBe(3);
    // Most recent first
    expect(all[0].description).toBe('Third');

    // Test status filter
    engine.vote(p3.id, 'yes', 0.9);

    const open = engine.getHistory('open');
    expect(open.length).toBe(3); // All still open (resolve not called)
  });

  it('migration is idempotent', () => {
    runConsensusMigration(db);
    runConsensusMigration(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'consensus%'")
      .all();
    expect(tables.length).toBe(2); // proposals + votes
  });
});
