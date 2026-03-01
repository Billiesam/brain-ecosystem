import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  // Competitors: Track competitor accounts across platforms
  db.exec(`
    CREATE TABLE IF NOT EXISTS competitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      handle TEXT NOT NULL,
      url TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_competitors_handle
      ON competitors(platform, handle);
  `);

  // Competitor Posts: Record competitor content and engagement
  db.exec(`
    CREATE TABLE IF NOT EXISTS competitor_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competitor_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      content TEXT NOT NULL,
      url TEXT,
      engagement_json TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (competitor_id) REFERENCES competitors(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_competitor_posts_competitor
      ON competitor_posts(competitor_id);
    CREATE INDEX IF NOT EXISTS idx_competitor_posts_platform
      ON competitor_posts(platform);
    CREATE INDEX IF NOT EXISTS idx_competitor_posts_detected
      ON competitor_posts(detected_at);
  `);

  // Scheduled Posts: Queue posts for future publishing
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      platform TEXT NOT NULL,
      content TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'text',
      hashtags TEXT,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      published_at TEXT,
      webhook_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status
      ON scheduled_posts(status);
    CREATE INDEX IF NOT EXISTS idx_scheduled_posts_scheduled
      ON scheduled_posts(scheduled_at);
  `);
}
