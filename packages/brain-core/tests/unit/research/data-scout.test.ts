import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { DataScout } from '../../../src/research/data-scout.js';
import type { ScoutAdapter, ScoutDiscovery } from '../../../src/research/data-scout.js';

const createMockAdapter = (
  name: string,
  discoveries: ScoutDiscovery[],
  enabled = true,
): ScoutAdapter => ({
  name,
  isEnabled: () => enabled,
  scout: async () => discoveries,
});

const createErrorAdapter = (name: string): ScoutAdapter => ({
  name,
  isEnabled: () => true,
  scout: async () => { throw new Error(`${name} failed`); },
});

describe('DataScout', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
  });

  it('scout() with no adapters returns empty', async () => {
    const scout = new DataScout(db, []);
    const results = await scout.scout();
    expect(results).toEqual([]);
  });

  it('scout() with custom adapter returns discoveries', async () => {
    const mockAdapter = createMockAdapter('test', [
      {
        source: 'test',
        title: 'Test Repo',
        url: 'https://example.com',
        description: 'A test',
        relevanceScore: 0.8,
        metadata: {},
        discoveredAt: new Date().toISOString(),
        imported: false,
      },
    ]);

    const scout = new DataScout(db, [mockAdapter]);
    const results = await scout.scout();
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Test Repo');
    expect(results[0].source).toBe('test');
  });

  it('getDiscoveries() returns results', async () => {
    const mockAdapter = createMockAdapter('test', [
      {
        source: 'test',
        title: 'Discovery A',
        url: 'https://example.com/a',
        description: 'First discovery',
        relevanceScore: 0.9,
        metadata: { stars: 100 },
        discoveredAt: new Date().toISOString(),
        imported: false,
      },
      {
        source: 'test',
        title: 'Discovery B',
        url: 'https://example.com/b',
        description: 'Second discovery',
        relevanceScore: 0.7,
        metadata: { stars: 50 },
        discoveredAt: new Date().toISOString(),
        imported: false,
      },
    ]);

    const scout = new DataScout(db, [mockAdapter]);
    await scout.scout();

    const discoveries = scout.getDiscoveries();
    expect(discoveries).toHaveLength(2);
    // Should be ordered by relevance_score DESC
    expect(discoveries[0].relevanceScore).toBeGreaterThanOrEqual(discoveries[1].relevanceScore);
  });

  it('getDiscoveries() filters by source', async () => {
    const adapterA = createMockAdapter('source-a', [
      { source: 'source-a', title: 'From A', url: 'https://a.com', description: '', relevanceScore: 0.8, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ]);
    const adapterB = createMockAdapter('source-b', [
      { source: 'source-b', title: 'From B', url: 'https://b.com', description: '', relevanceScore: 0.6, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ]);

    const scout = new DataScout(db, [adapterA, adapterB]);
    await scout.scout();

    const fromA = scout.getDiscoveries('source-a');
    expect(fromA).toHaveLength(1);
    expect(fromA[0].source).toBe('source-a');

    const fromB = scout.getDiscoveries('source-b');
    expect(fromB).toHaveLength(1);
    expect(fromB[0].source).toBe('source-b');
  });

  it('markImported() marks as imported', async () => {
    const mockAdapter = createMockAdapter('test', [
      { source: 'test', title: 'Import Me', url: 'https://example.com', description: '', relevanceScore: 0.8, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ]);

    const scout = new DataScout(db, [mockAdapter]);
    await scout.scout();

    const discoveries = scout.getDiscoveries();
    expect(discoveries[0].imported).toBe(false);

    scout.markImported(discoveries[0].id!);

    const after = scout.getDiscoveries();
    expect(after[0].imported).toBe(true);
  });

  it('getStatus() returns correct stats', async () => {
    const mockAdapter = createMockAdapter('test', [
      { source: 'test', title: 'Item 1', url: 'https://example.com/1', description: '', relevanceScore: 0.9, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
      { source: 'test', title: 'Item 2', url: 'https://example.com/2', description: '', relevanceScore: 0.7, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ]);

    const scout = new DataScout(db, [mockAdapter]);
    await scout.scout();

    scout.markImported(1);

    const status = scout.getStatus();
    expect(status.totalDiscoveries).toBe(2);
    expect(status.importedCount).toBe(1);
    expect(status.bySource['test']).toBe(2);
    expect(status.recentDiscoveries).toHaveLength(2);
  });

  it('deduplicates discoveries', async () => {
    const mockAdapter = createMockAdapter('test', [
      { source: 'test', title: 'Same Title', url: 'https://example.com', description: 'First', relevanceScore: 0.8, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
      { source: 'test', title: 'Same Title', url: 'https://example.com', description: 'Duplicate', relevanceScore: 0.8, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ]);

    const scout = new DataScout(db, [mockAdapter]);
    const results = await scout.scout();
    // Second item is a duplicate (same source + title), should not be inserted
    expect(results).toHaveLength(1);

    const discoveries = scout.getDiscoveries();
    expect(discoveries).toHaveLength(1);
  });

  it('scout() handles adapter errors gracefully', async () => {
    const errorAdapter = createErrorAdapter('broken');
    const goodAdapter = createMockAdapter('good', [
      { source: 'good', title: 'Works Fine', url: 'https://example.com', description: '', relevanceScore: 0.5, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ]);

    const scout = new DataScout(db, [errorAdapter, goodAdapter]);
    // Should not throw, and should still return results from the good adapter
    const results = await scout.scout();
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('good');
  });

  it('scout() skips disabled adapters', async () => {
    const disabledAdapter = createMockAdapter('disabled', [
      { source: 'disabled', title: 'Should Not Appear', url: 'https://example.com', description: '', relevanceScore: 0.8, metadata: {}, discoveredAt: new Date().toISOString(), imported: false },
    ], false);

    const scout = new DataScout(db, [disabledAdapter]);
    const results = await scout.scout();
    expect(results).toEqual([]);
  });
});
