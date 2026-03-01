import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';

export interface ScheduledPostRecord {
  id: number;
  post_id: number | null;
  platform: string;
  content: string;
  format: string;
  hashtags: string | null;
  scheduled_at: string;
  status: string;
  published_at: string | null;
  webhook_url: string | null;
  created_at: string;
}

export class SchedulerRepository {
  private stmts: Record<string, Statement>;

  constructor(private db: Database.Database) {
    this.stmts = {
      create: db.prepare(`
        INSERT INTO scheduled_posts (post_id, platform, content, format, hashtags, scheduled_at, webhook_url)
        VALUES (@post_id, @platform, @content, @format, @hashtags, @scheduled_at, @webhook_url)
      `),
      getById: db.prepare('SELECT * FROM scheduled_posts WHERE id = ?'),
      getAll: db.prepare('SELECT * FROM scheduled_posts ORDER BY scheduled_at DESC LIMIT ?'),
      getPending: db.prepare(`
        SELECT * FROM scheduled_posts WHERE status = 'pending' ORDER BY scheduled_at ASC
      `),
      getDue: db.prepare(`
        SELECT * FROM scheduled_posts WHERE status = 'pending' AND scheduled_at <= datetime('now')
      `),
      getByStatus: db.prepare('SELECT * FROM scheduled_posts WHERE status = ? ORDER BY scheduled_at DESC LIMIT ?'),
      markPublished: db.prepare(`
        UPDATE scheduled_posts SET status = 'published', published_at = datetime('now') WHERE id = ?
      `),
      cancel: db.prepare(`
        UPDATE scheduled_posts SET status = 'cancelled' WHERE id = ?
      `),
      delete: db.prepare('DELETE FROM scheduled_posts WHERE id = ?'),
      countPending: db.prepare(`SELECT COUNT(*) as count FROM scheduled_posts WHERE status = 'pending'`),
    };
  }

  create(data: {
    post_id?: number;
    platform: string;
    content: string;
    format?: string;
    hashtags?: string;
    scheduled_at: string;
    webhook_url?: string;
  }): number {
    const result = this.stmts.create.run({
      post_id: data.post_id ?? null,
      platform: data.platform,
      content: data.content,
      format: data.format ?? 'text',
      hashtags: data.hashtags ?? null,
      scheduled_at: data.scheduled_at,
      webhook_url: data.webhook_url ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getById(id: number): ScheduledPostRecord | undefined {
    return this.stmts.getById.get(id) as ScheduledPostRecord | undefined;
  }

  getAll(limit: number = 50): ScheduledPostRecord[] {
    return this.stmts.getAll.all(limit) as ScheduledPostRecord[];
  }

  getPending(): ScheduledPostRecord[] {
    return this.stmts.getPending.all() as ScheduledPostRecord[];
  }

  getDue(): ScheduledPostRecord[] {
    return this.stmts.getDue.all() as ScheduledPostRecord[];
  }

  getByStatus(status: string, limit: number = 50): ScheduledPostRecord[] {
    return this.stmts.getByStatus.all(status, limit) as ScheduledPostRecord[];
  }

  markPublished(id: number): void {
    this.stmts.markPublished.run(id);
  }

  cancel(id: number): void {
    this.stmts.cancel.run(id);
  }

  update(id: number, data: Partial<{
    platform: string;
    content: string;
    format: string;
    hashtags: string;
    scheduled_at: string;
    webhook_url: string;
  }>): void {
    const fields = Object.keys(data).filter(
      (key) => (data as Record<string, unknown>)[key] !== undefined
    );
    if (fields.length === 0) return;

    const setClauses = fields.map((f) => `${f} = @${f}`).join(', ');
    const stmt = this.db.prepare(
      `UPDATE scheduled_posts SET ${setClauses} WHERE id = @id`
    );
    stmt.run({ ...data, id });
  }

  delete(id: number): void {
    this.stmts.delete.run(id);
  }

  countPending(): number {
    const row = this.stmts.countPending.get() as { count: number };
    return row.count;
  }
}
