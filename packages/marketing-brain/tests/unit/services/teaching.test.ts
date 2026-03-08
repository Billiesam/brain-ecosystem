import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Import from brain-core directly (TeachingProtocol is a shared engine)
import { TeachingProtocol, runTeachingMigration, Curriculum, runCurriculumMigration } from '@timmeck/brain-core';

describe('Marketing-Brain Teaching Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });
  afterEach(() => { db.close(); });

  it('marketing-brain can teach and learn', () => {
    const protocol = new TeachingProtocol(db, { brainName: 'marketing-brain' });

    // Teach a lesson
    const sent = protocol.teach('brain', {
      domain: 'content-strategy',
      principle: 'Consistent posting improves engagement baseline',
      applicability: 0.8,
    });
    expect(sent.direction).toBe('sent');
    expect(sent.targetBrain).toBe('brain');

    // Learn a lesson
    const result = protocol.learn({
      sourceBrain: 'brain',
      domain: 'content patterns',
      principle: 'Content strategy with engagement tracking improves audience growth',
      applicability: 0.7,
    });
    expect(typeof result.relevanceScore).toBe('number');
    expect(typeof result.accepted).toBe('boolean');

    // Status reflects both
    const status = protocol.getStatus();
    expect(status.totalSent).toBe(1);
    expect(status.totalReceived).toBe(1);
  });

  it('marketing-brain curriculum works', () => {
    const curriculum = new Curriculum(db);
    const item = curriculum.registerPrinciple('marketing-brain', 'engagement', 'Post at peak hours', 0.9);
    expect(item.id).toBeDefined();
    expect(item.brainName).toBe('marketing-brain');

    curriculum.markTeachable(item.id!);
    const teachable = curriculum.getTeachable('marketing-brain');
    expect(teachable.length).toBe(1);
    expect(teachable[0].principle).toBe('Post at peak hours');
  });
});
