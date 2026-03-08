import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ContentForge, runContentForgeMigration } from '../content-forge.js';

describe('ContentForge', () => {
  let db: Database.Database;

  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('generates content from an insight', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromInsight({ id: 1, insight: 'Cross-domain patterns emerge between trading and marketing signals', noveltyScore: 0.8 });
    expect(piece.id).toBeGreaterThan(0);
    expect(piece.sourceType).toBe('insight');
    expect(piece.status).toBe('draft');
    expect(piece.platform).toBe('bluesky');
  });

  it('generates content from a mission', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromMission({ id: 5, topic: 'AI agent architectures', summary: 'Survey of modern agent designs' });
    expect(piece.sourceType).toBe('mission');
    expect(piece.title).toContain('Research');
  });

  it('generates content from a trend', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromTrend({ name: 'WebAssembly', description: 'WASM growing in backend usage', category: 'infrastructure' });
    expect(piece.sourceType).toBe('trend');
    expect(piece.title).toContain('Trend');
  });

  it('generates content from a principle', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromPrinciple({ id: 3, statement: 'Early feedback loops reduce cascading failures', domain: 'engineering' });
    expect(piece.sourceType).toBe('principle');
  });

  it('schedules content for later', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromInsight({ insight: 'Test insight', noveltyScore: 0.5 });
    forge.schedule(piece.id, '2026-03-15T10:00:00Z');

    const scheduled = forge.getSchedule();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].scheduledFor).toBe('2026-03-15T10:00:00Z');
    expect(scheduled[0].status).toBe('scheduled');
  });

  it('publishes content via social service', async () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    forge.setSocialService({ post: vi.fn().mockResolvedValue({ id: 'post-123' }) });

    const piece = forge.generateFromInsight({ insight: 'Publish me', noveltyScore: 0.9 });
    const result = await forge.publishNow(piece.id);
    expect(result.success).toBe(true);
    expect(result.postId).toBe('post-123');

    const updated = forge.getPiece(piece.id);
    expect(updated?.status).toBe('published');
  });

  it('handles publish failure', async () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    forge.setSocialService({ post: vi.fn().mockRejectedValue(new Error('Rate limited')) });

    const piece = forge.generateFromInsight({ insight: 'Fail publish', noveltyScore: 0.5 });
    const result = await forge.publishNow(piece.id);
    expect(result.success).toBe(false);

    const updated = forge.getPiece(piece.id);
    expect(updated?.status).toBe('failed');
  });

  it('returns failure when no social service', async () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromInsight({ insight: 'No service', noveltyScore: 0.5 });
    const result = await forge.publishNow(piece.id);
    expect(result.success).toBe(false);
  });

  it('records engagement metrics', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    forge.setSocialService({ post: vi.fn().mockResolvedValue({ id: 'p1' }) });

    const piece = forge.generateFromInsight({ insight: 'Engage me', noveltyScore: 0.7 });
    forge.recordEngagement(piece.id, { likes: 42, reposts: 10, replies: 5 });

    const updated = forge.getPiece(piece.id);
    expect(updated?.engagement?.likes).toBe(42);
  });

  it('gets best performing content', async () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    forge.setSocialService({ post: vi.fn().mockResolvedValue({ id: 'p1' }) });

    const p1 = forge.generateFromInsight({ insight: 'Popular', noveltyScore: 0.9 });
    const p2 = forge.generateFromInsight({ insight: 'Less popular', noveltyScore: 0.5 });
    await forge.publishNow(p1.id);
    await forge.publishNow(p2.id);
    forge.recordEngagement(p1.id, { likes: 100, reposts: 50, replies: 20 });
    forge.recordEngagement(p2.id, { likes: 5, reposts: 1, replies: 0 });

    const best = forge.getBestPerforming(2);
    expect(best).toHaveLength(2);
    expect(best[0].engagement?.likes).toBe(100);
  });

  it('returns optimal posting time', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    expect(forge.getOptimalTime('bluesky')).toBe('10:00');
    expect(forge.getOptimalTime('reddit')).toBe('08:00');
  });

  it('getStatus returns overview', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    forge.generateFromInsight({ insight: 'Draft 1', noveltyScore: 0.5 });
    forge.generateFromInsight({ insight: 'Draft 2', noveltyScore: 0.6 });

    const status = forge.getStatus();
    expect(status.drafts).toBe(2);
    expect(status.published).toBe(0);
  });

  it('migration is idempotent', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    forge.generateFromInsight({ insight: 'Survives', noveltyScore: 0.5 });
    runContentForgeMigration(db);
    const pieces = forge.getByStatus('draft');
    expect(pieces).toHaveLength(1);
  });

  it('uses custom platform', () => {
    const forge = new ContentForge(db, { brainName: 'test' });
    const piece = forge.generateFromInsight({ insight: 'Reddit post', noveltyScore: 0.7 }, 'reddit');
    expect(piece.platform).toBe('reddit');
  });
});
