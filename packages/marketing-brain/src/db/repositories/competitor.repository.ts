import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

export interface CompetitorRecord {
  id: number;
  name: string;
  platform: string;
  handle: string;
  url: string | null;
  notes: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface CompetitorPostRecord {
  id: number;
  competitor_id: number;
  platform: string;
  content: string;
  url: string | null;
  engagement_json: string | null;
  detected_at: string;
  created_at: string;
}

export class CompetitorRepository {
  private stmts: Record<string, Statement>;

  constructor(private db: Database.Database) {
    this.stmts = {
      create: db.prepare(`
        INSERT INTO competitors (name, platform, handle, url, notes)
        VALUES (@name, @platform, @handle, @url, @notes)
      `),
      getById: db.prepare('SELECT * FROM competitors WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM competitors ORDER BY created_at DESC'),
      getActive: db.prepare('SELECT * FROM competitors WHERE active = 1 ORDER BY created_at DESC'),
      getByHandle: db.prepare('SELECT * FROM competitors WHERE platform = ? AND handle = ?'),
      delete: db.prepare('DELETE FROM competitors WHERE id = ?'),
      addPost: db.prepare(`
        INSERT INTO competitor_posts (competitor_id, platform, content, url, engagement_json)
        VALUES (@competitor_id, @platform, @content, @url, @engagement_json)
      `),
      getPosts: db.prepare('SELECT * FROM competitor_posts WHERE competitor_id = ? ORDER BY detected_at DESC LIMIT ?'),
      getPostsByPlatform: db.prepare('SELECT * FROM competitor_posts WHERE platform = ? ORDER BY detected_at DESC LIMIT ?'),
      getRecentPosts: db.prepare(`
        SELECT * FROM competitor_posts
        WHERE detected_at > datetime('now', '-' || ? || ' days')
        ORDER BY detected_at DESC
        LIMIT ?
      `),
      countPosts: db.prepare('SELECT COUNT(*) as count FROM competitor_posts WHERE competitor_id = ?'),
    };
  }

  create(data: { name: string; platform: string; handle: string; url?: string; notes?: string }): number {
    const result = this.stmts.create.run({
      name: data.name,
      platform: data.platform,
      handle: data.handle,
      url: data.url ?? null,
      notes: data.notes ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getById(id: number): CompetitorRecord | undefined {
    return this.stmts.getById.get(id) as CompetitorRecord | undefined;
  }

  getAll(): CompetitorRecord[] {
    return this.stmts.getAll.all() as CompetitorRecord[];
  }

  getActive(): CompetitorRecord[] {
    return this.stmts.getActive.all() as CompetitorRecord[];
  }

  getByHandle(platform: string, handle: string): CompetitorRecord | undefined {
    return this.stmts.getByHandle.get(platform, handle) as CompetitorRecord | undefined;
  }

  update(id: number, data: Partial<{ name: string; handle: string; url: string; notes: string; active: number }>): void {
    const fields = Object.keys(data).filter(
      (key) => key !== 'id' && key !== 'created_at' && (data as Record<string, unknown>)[key] !== undefined
    );
    if (fields.length === 0) return;

    const setClauses = fields.map((f) => `${f} = @${f}`).join(', ');
    const stmt = this.db.prepare(
      `UPDATE competitors SET ${setClauses}, updated_at = datetime('now') WHERE id = @id`
    );
    stmt.run({ ...data, id });
  }

  delete(id: number): void {
    this.stmts.delete.run(id);
  }

  addPost(data: { competitor_id: number; platform: string; content: string; url?: string; engagement_json?: string }): number {
    const result = this.stmts.addPost.run({
      competitor_id: data.competitor_id,
      platform: data.platform,
      content: data.content,
      url: data.url ?? null,
      engagement_json: data.engagement_json ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getPosts(competitorId: number, limit: number = 50): CompetitorPostRecord[] {
    return this.stmts.getPosts.all(competitorId, limit) as CompetitorPostRecord[];
  }

  getPostsByPlatform(platform: string, limit: number = 50): CompetitorPostRecord[] {
    return this.stmts.getPostsByPlatform.all(platform, limit) as CompetitorPostRecord[];
  }

  getRecentPosts(days: number = 7, limit: number = 50): CompetitorPostRecord[] {
    return this.stmts.getRecentPosts.all(days, limit) as CompetitorPostRecord[];
  }

  countPosts(competitorId: number): number {
    const row = this.stmts.countPosts.get(competitorId) as { count: number };
    return row.count;
  }
}
