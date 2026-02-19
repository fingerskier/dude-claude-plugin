/**
 * Shared test helpers — sets up an in-memory SQLite database with sqlite-vec
 * so db.js tests can run without touching the real filesystem.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/**
 * Create a fresh in-memory database with sqlite-vec loaded and migrations applied.
 * Returns the db instance.
 */
export function createTestDb() {
  const db = new Database(':memory:');
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run migrations inline (mirrors 001-initial + 002-expand-kinds)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);

    CREATE TABLE project (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE record (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL,
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL DEFAULT '',
      status     TEXT    NOT NULL DEFAULT 'open',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_record_project_kind ON record(project_id, kind);

    CREATE VIRTUAL TABLE record_embedding USING vec0(
      record_id  INTEGER PRIMARY KEY,
      embedding  FLOAT[384] distance_metric=cosine
    );

    INSERT INTO schema_version (version) VALUES (1);
    INSERT INTO schema_version (version) VALUES (2);
  `);

  return db;
}

/**
 * Insert a project into the test DB and return it.
 */
export function insertProject(db, name = 'test-project') {
  db.prepare(`
    INSERT INTO project (name) VALUES (?)
    ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')
  `).run(name);
  return db.prepare('SELECT * FROM project WHERE name = ?').get(name);
}

/**
 * Generate a random 384-dim Float32Array embedding for testing.
 */
export function fakeEmbedding() {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = Math.random() * 2 - 1;
  }
  // Normalize to unit vector (cosine distance expects this)
  const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  for (let i = 0; i < 384; i++) {
    arr[i] /= norm;
  }
  return arr;
}

/**
 * Generate a deterministic 384-dim embedding based on a seed number.
 * Two calls with the same seed produce the same embedding.
 */
export function seededEmbedding(seed) {
  const arr = new Float32Array(384);
  // Simple deterministic pseudo-random
  let s = seed;
  for (let i = 0; i < 384; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    arr[i] = (s / 0x7fffffff) * 2 - 1;
  }
  const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
  for (let i = 0; i < 384; i++) {
    arr[i] /= norm;
  }
  return arr;
}

/**
 * Convert a Float32Array embedding to a Buffer for sqlite-vec.
 */
export function embeddingBuffer(emb) {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}
