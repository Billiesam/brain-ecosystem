import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { UserModel, runUserModelMigration } from '../user-model.js';
import { AdaptiveContext } from '../adaptive-context.js';
import type { UserProfile } from '../user-model.js';

function createDb(): Database.Database {
  return new Database(':memory:');
}

describe('UserModel', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('sets and gets a preference', () => {
    const model = new UserModel(db, { brainName: 'test' });
    model.setPreference('theme', 'dark');

    expect(model.getPreference('theme')).toBe('dark');
  });

  it('returns null for unknown preference', () => {
    const model = new UserModel(db, { brainName: 'test' });
    expect(model.getPreference('nonexistent')).toBeNull();
  });

  it('updateFromInteraction tracks tool frequency', () => {
    const model = new UserModel(db, { brainName: 'test' });
    model.updateFromInteraction('mcp.search', 'finding code', 'success');
    model.updateFromInteraction('mcp.search', 'finding docs', 'success');

    const profile = model.getProfile();
    expect(profile.topTools).toContain('mcp.search');
  });

  it('infers beginner skill level for < 3 successful uses', () => {
    const model = new UserModel(db, { brainName: 'test' });
    model.updateFromInteraction('trading.analyze', 'stocks', 'success');
    model.updateFromInteraction('trading.analyze', 'stocks', 'success');

    const profile = model.getProfile();
    expect(profile.skillDomains.get('trading')).toBe('beginner');
  });

  it('infers intermediate skill level for 3-10 successful uses', () => {
    const model = new UserModel(db, { brainName: 'test' });
    for (let i = 0; i < 5; i++) {
      model.updateFromInteraction('trading.analyze', 'stocks', 'success');
    }

    const profile = model.getProfile();
    expect(profile.skillDomains.get('trading')).toBe('intermediate');
  });

  it('infers expert skill level for > 10 successful uses', () => {
    const model = new UserModel(db, { brainName: 'test' });
    for (let i = 0; i < 12; i++) {
      model.updateFromInteraction('coding.refactor', 'cleanup', 'success');
    }

    const profile = model.getProfile();
    expect(profile.skillDomains.get('coding')).toBe('expert');
  });

  it('getProfile returns complete structure', () => {
    const model = new UserModel(db, { brainName: 'test' });
    model.updateFromInteraction('mcp.search', 'ctx', 'success');

    const profile = model.getProfile();
    expect(profile.skillDomains).toBeInstanceOf(Map);
    expect(Array.isArray(profile.topTools)).toBe(true);
    expect(Array.isArray(profile.activeHours)).toBe(true);
    expect(Array.isArray(profile.errorPatterns)).toBe(true);
  });

  it('migration is idempotent', () => {
    const model1 = new UserModel(db, { brainName: 'test' });
    model1.setPreference('lang', 'en');

    // Run migration again
    runUserModelMigration(db);
    const model2 = new UserModel(db, { brainName: 'test' });

    expect(model2.getPreference('lang')).toBe('en');
  });

  it('getStatus returns correct counts', () => {
    const model = new UserModel(db, { brainName: 'test' });

    const emptyStatus = model.getStatus();
    expect(emptyStatus.totalKeys).toBe(0);
    expect(emptyStatus.domains).toBe(0);
    expect(emptyStatus.lastUpdated).toBeNull();

    model.updateFromInteraction('mcp.search', 'ctx', 'success');

    const status = model.getStatus();
    expect(status.totalKeys).toBeGreaterThan(0);
    expect(status.domains).toBeGreaterThanOrEqual(1);
    expect(status.lastUpdated).not.toBeNull();
  });
});

describe('AdaptiveContext', () => {
  it('returns concise for all-expert profile', () => {
    const ctx = new AdaptiveContext();
    const profile: UserProfile = {
      skillDomains: new Map([['coding', 'expert'], ['trading', 'expert']]),
      topTools: [],
      activeHours: [],
      errorPatterns: [],
    };

    const result = ctx.enrichPrompt('How do I do X?', profile);
    expect(result).toContain('Be concise');
    expect(result).toContain('How do I do X?');
    expect(ctx.getDetailLevel(profile)).toBe('concise');
  });

  it('returns detailed for profile with any beginner domain', () => {
    const ctx = new AdaptiveContext();
    const profile: UserProfile = {
      skillDomains: new Map([['coding', 'expert'], ['trading', 'beginner']]),
      topTools: [],
      activeHours: [],
      errorPatterns: [],
    };

    const result = ctx.enrichPrompt('How do I do X?', profile);
    expect(result).toContain('Explain in detail');
    expect(result).toContain('How do I do X?');
    expect(ctx.getDetailLevel(profile)).toBe('detailed');
  });

  it('returns unmodified prompt for default/mixed profile', () => {
    const ctx = new AdaptiveContext();
    const profile: UserProfile = {
      skillDomains: new Map([['coding', 'intermediate'], ['trading', 'expert']]),
      topTools: [],
      activeHours: [],
      errorPatterns: [],
    };

    const result = ctx.enrichPrompt('How do I do X?', profile);
    expect(result).toBe('How do I do X?');
    expect(ctx.getDetailLevel(profile)).toBe('normal');
  });

  it('returns normal for empty profile', () => {
    const ctx = new AdaptiveContext();
    const profile: UserProfile = {
      skillDomains: new Map(),
      topTools: [],
      activeHours: [],
      errorPatterns: [],
    };

    const result = ctx.enrichPrompt('Hello', profile);
    expect(result).toBe('Hello');
    expect(ctx.getDetailLevel(profile)).toBe('normal');
  });
});
