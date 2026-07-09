import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { logger } from '../logger.js';
import * as schema from './schema.js';

export type Sqlite = Database.Database;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export type DatabaseHandle = {
  sqlite: Sqlite;
  db: Db;
};

export function openDatabase(databaseUrl: string): DatabaseHandle {
  const path = databaseUrl.startsWith('file:')
    ? databaseUrl.slice('file:'.length)
    : databaseUrl;
  mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  migrate(sqlite);

  logger.info('SQLite ready', { path });
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function migrate(db: Sqlite) {
  db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE IF NOT EXISTS policies (
  guild_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  action_type TEXT NOT NULL,
  duration_seconds INTEGER,
  role_id TEXT,
  delete_messages INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, scope)
);

CREATE TABLE IF NOT EXISTS moderators (
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, type, id)
);

CREATE TABLE IF NOT EXISTS honeypots (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS models (
  guild_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT,
  encrypted_api_key TEXT,
  api_key_hint TEXT,
  api_key_nonce TEXT,
  api_key_auth_tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, purpose)
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  action_taken TEXT,
  reason TEXT,
  evidence_summary_json TEXT NOT NULL,
  review_channel_id TEXT,
  review_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cases_active_lookup_idx ON cases (guild_id, user_id, trigger_type, status);

CREATE TABLE IF NOT EXISTS case_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  text_hash TEXT,
  deleted INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS case_messages_message_idx ON case_messages (message_id);

CREATE TABLE IF NOT EXISTS case_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  case_message_id INTEGER NOT NULL,
  discord_attachment_id TEXT NOT NULL,
  name TEXT,
  original_url TEXT NOT NULL,
  review_attachment_url TEXT,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT,
  perceptual_hash TEXT,
  storage_key TEXT,
  processing_slot INTEGER,
  processing_state TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  matched INTEGER NOT NULL,
  score REAL NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reviewer_id TEXT,
  note TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS known_texts (
  id TEXT PRIMARY KEY,
  normalized_text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_vector_json TEXT,
  description TEXT NOT NULL,
  scam_reason TEXT NOT NULL,
  source_case_id TEXT,
  source_discord_message_id TEXT,
  approved_by TEXT,
  scope TEXT NOT NULL,
  guild_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS known_texts_hash_idx ON known_texts (text_hash, status, guild_id);

CREATE TABLE IF NOT EXISTS known_images (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  perceptual_hash TEXT,
  storage_key TEXT NOT NULL,
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding_vector_json TEXT,
  description TEXT NOT NULL,
  scam_reason TEXT NOT NULL,
  source_case_id TEXT,
  source_discord_attachment_id TEXT,
  approved_by TEXT,
  scope TEXT NOT NULL,
  guild_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS known_images_sha_idx ON known_images (sha256, status, guild_id);

CREATE TABLE IF NOT EXISTS global_bans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_case_id TEXT,
  published_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS global_bans_user_idx ON global_bans (user_id, status);
`);

  const attachmentColumns = db.pragma('table_info(case_attachments)') as Array<{
    name: string;
  }>;
  if (!attachmentColumns.some((column) => column.name === 'processing_slot')) {
    db.exec('ALTER TABLE case_attachments ADD COLUMN processing_slot INTEGER');
  }
  if (!attachmentColumns.some((column) => column.name === 'processing_state')) {
    db.exec(`
      ALTER TABLE case_attachments ADD COLUMN processing_state TEXT;
      UPDATE case_attachments
      SET processing_state = CASE
        WHEN processing_slot IS NULL THEN NULL
        WHEN storage_key IS NOT NULL THEN 'stored'
        ELSE 'pending'
      END;
    `);
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS case_attachments_processing_slot_idx ON case_attachments (case_id, processing_slot)',
  );
}
