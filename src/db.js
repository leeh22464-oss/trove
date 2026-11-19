import { DatabaseSync } from 'node:sqlite';
import { ensureDataDirs, DB_PATH } from './config.js';
import { Settings } from './config.js';

export function openDb(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') ensureDataDirs();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);

  CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'unknown',
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_url TEXT NOT NULL DEFAULT '',
    source_platform TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'inbox',
    favorite INTEGER NOT NULL DEFAULT 0,
    use_count INTEGER NOT NULL DEFAULT 0,
    props_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL DEFAULT '',
    simhash TEXT NOT NULL DEFAULT '',
    processing TEXT NOT NULL DEFAULT '',
    ai_notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
  CREATE INDEX IF NOT EXISTS idx_items_hash ON items(content_hash);

  CREATE TABLE IF NOT EXISTS item_versions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    title TEXT, content TEXT, kind TEXT, props_json TEXT,
    snapshot_json TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'edit',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_versions_item ON item_versions(item_id, id DESC);

  CREATE TABLE IF NOT EXISTS assets(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    width INTEGER, height INTEGER,
    ocr_text TEXT NOT NULL DEFAULT '',
    ocr_provider TEXT NOT NULL DEFAULT '',
    ocr_state TEXT NOT NULL DEFAULT 'pending',
    vision_desc TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_assets_item ON assets(item_id);
  CREATE INDEX IF NOT EXISTS idx_assets_sha ON assets(sha256);

  CREATE TABLE IF NOT EXISTS tags(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    aliases_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS item_tags(
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'user',
    confidence REAL NOT NULL DEFAULT 1,
    PRIMARY KEY(item_id, tag_id)
  );
  CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

  CREATE TABLE IF NOT EXISTS links(
    src_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    dst_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY(src_id, dst_id)
  );

  CREATE TABLE IF NOT EXISTS collections(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
    description TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS collection_items(
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY(collection_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS item_files(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    UNIQUE(item_id, path)
  );

  CREATE TABLE IF NOT EXISTS jobs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 4,
    last_error TEXT NOT NULL DEFAULT '',
    next_run_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(state, next_run_at);

  CREATE TABLE IF NOT EXISTS plans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state TEXT NOT NULL DEFAULT 'draft',
    scope TEXT NOT NULL DEFAULT 'inbox',
    plan_json TEXT NOT NULL DEFAULT '{}',
    undo_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  // 轻量列迁移：老库补新列
  const colHas = (tbl, col) => db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`).get(tbl, col);
  if (!colHas('collections', 'cover')) db.exec(`ALTER TABLE collections ADD COLUMN cover TEXT NOT NULL DEFAULT ''`);
  if (!colHas('assets', 'kind')) db.exec(`ALTER TABLE assets ADD COLUMN kind TEXT NOT NULL DEFAULT 'gallery'`);

  // FTS5 trigram：中文子串检索
  db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    title, content, summary, ocr_text, tags,
    tokenize='trigram'
  );
  `);
}

export class Store {
  constructor(db) { this.db = db; this.settings = new Settings(db); }

  ftsUpdate(itemId) {
    const item = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
    if (!item) return;
    this.db.prepare('DELETE FROM items_fts WHERE rowid=?').run(itemId);
    if (item.status === 'trash') return;
    const ocr = this.db.prepare("SELECT group_concat(ocr_text,' ') t FROM assets WHERE item_id=?").get(itemId).t || '';
    const tags = this.db.prepare(`SELECT group_concat(t.name,' ') n FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?`).get(itemId).n || '';
    this.db.prepare('INSERT INTO items_fts(rowid,title,content,summary,ocr_text,tags) VALUES(?,?,?,?,?,?)')
      .run(itemId, item.title, item.content, item.summary, ocr, tags);
  }

  snapshot(itemId, reason = 'edit') {
    const it = this.db.prepare('SELECT * FROM items WHERE id=?').get(itemId);
    if (!it) return;
    this.db.prepare('INSERT INTO item_versions(item_id,title,content,kind,props_json,snapshot_json,reason) VALUES(?,?,?,?,?,?,?)')
      .run(itemId, it.title, it.content, it.kind, it.props_json, JSON.stringify(it), reason);
  }

  touch(itemId) {
    this.db.prepare("UPDATE items SET updated_at=datetime('now') WHERE id=?").run(itemId);
  }
}
