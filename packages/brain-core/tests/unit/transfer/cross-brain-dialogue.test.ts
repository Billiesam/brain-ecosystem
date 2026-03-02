import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { TransferEngine } from '../../../src/transfer/transfer-engine.js';

describe('CrossBrainDialogue', () => {
  let db: Database.Database;
  let engine: TransferEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    engine = new TransferEngine(db, { brainName: 'brain' });
  });

  it('formulateQuestion() generates a question string', () => {
    const question = engine.formulateQuestion('latency spikes');
    expect(typeof question).toBe('string');
    expect(question).toContain('latency spikes');
    expect(question).toContain('code quality and error patterns');
  });

  it('formulateQuestion() uses domain description for the brain', () => {
    const tradingEngine = new TransferEngine(db, { brainName: 'trading-brain' });
    const question = tradingEngine.formulateQuestion('volatility');
    expect(question).toContain('trading signals and risk management');
  });

  it('answerQuestion() returns an answer', () => {
    const answer = engine.answerQuestion('What is error rate?');
    expect(typeof answer).toBe('string');
    expect(answer.length).toBeGreaterThan(0);
    // Without NarrativeEngine or principles, falls back to default
    expect(answer).toContain('brain has no specific knowledge');
  });

  it('recordDialogue() stores a dialogue', () => {
    const dialogue = engine.recordDialogue(
      'brain',
      'trading-brain',
      'How does latency affect trades?',
      'High latency causes slippage.',
      'latency-investigation',
    );

    expect(dialogue.id).toBeDefined();
    expect(dialogue.sourceBrain).toBe('brain');
    expect(dialogue.targetBrain).toBe('trading-brain');
    expect(dialogue.question).toBe('How does latency affect trades?');
    expect(dialogue.answer).toBe('High latency causes slippage.');
    expect(dialogue.usefulnessScore).toBe(0);
    expect(dialogue.context).toBe('latency-investigation');
  });

  it('rateDialogue() updates usefulness score', () => {
    const dialogue = engine.recordDialogue(
      'brain', 'trading-brain', 'Question?', 'Answer.', '',
    );

    engine.rateDialogue(dialogue.id!, 0.85);

    const history = engine.getDialogueHistory();
    const updated = history.find(d => d.id === dialogue.id);
    expect(updated).toBeDefined();
    expect(updated!.usefulnessScore).toBe(0.85);
  });

  it('getDialogueHistory() returns dialogues', () => {
    engine.recordDialogue('brain', 'trading-brain', 'Q1', 'A1', '');
    engine.recordDialogue('brain', 'marketing-brain', 'Q2', 'A2', '');
    engine.recordDialogue('trading-brain', 'brain', 'Q3', 'A3', '');

    const history = engine.getDialogueHistory();
    expect(history).toHaveLength(3);
  });

  it('getDialogueHistory() filters by peer', () => {
    engine.recordDialogue('brain', 'trading-brain', 'Q1', 'A1', '');
    engine.recordDialogue('brain', 'marketing-brain', 'Q2', 'A2', '');
    engine.recordDialogue('trading-brain', 'brain', 'Q3', 'A3', '');

    const tradingOnly = engine.getDialogueHistory('trading-brain');
    // Should include dialogues where trading-brain is source OR target
    expect(tradingOnly.length).toBe(2);
    for (const d of tradingOnly) {
      expect(
        d.sourceBrain === 'trading-brain' || d.targetBrain === 'trading-brain',
      ).toBe(true);
    }
  });

  it('getDialogueStats() returns correct stats', () => {
    engine.recordDialogue('brain', 'trading-brain', 'Q1', 'A1', '');
    engine.recordDialogue('brain', 'marketing-brain', 'Q2', 'A2', '');
    engine.rateDialogue(1, 0.8);
    engine.rateDialogue(2, 0.6);

    const stats = engine.getDialogueStats();
    expect(stats.totalDialogues).toBe(2);
    expect(stats.avgUsefulness).toBeCloseTo(0.7, 1);
    expect(stats.byPeer.length).toBeGreaterThan(0);
  });

  it('getStatus() includes totalDialogues', () => {
    engine.recordDialogue('brain', 'trading-brain', 'Q1', 'A1', '');
    engine.recordDialogue('brain', 'trading-brain', 'Q2', 'A2', '');

    const status = engine.getStatus();
    expect(status.totalDialogues).toBe(2);
  });
});
