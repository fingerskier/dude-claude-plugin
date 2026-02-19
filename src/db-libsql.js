import { createClient } from '@libsql/client';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { DbAdapter } from './db-adapter.js';

const DATA_DIR = join(homedir(), '.dude-claude');
const DB_PATH = join(DATA_DIR, 'dude-libsql.db');

/** Column list for record queries (excludes embedding blob). */
const RECORD_COLS = `r.id, r.project_id, r.kind, r.title, r.body, r.status, r.created_at, r.updated_at`;

/**
 * LibsqlAdapter — implements DbAdapter using @libsql/client with native vector columns.
 * Vectors are stored as F32_BLOB(384) directly on the record table.
 */
export class LibsqlAdapter extends DbAdapter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.db = null;
    this.currentProject = null;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  async init() {
    if (this.db) return;
    this._ensureDataDir();
    this.db = this._createClient();
    await this._runSchema();
    const projectName = this._detectProject();
    this.currentProject = await this._upsertProject(projectName);
    await this._migrateProjectNames(projectName);
    const syncInfo = await this.syncStatus();
    const syncMsg = syncInfo.enabled ? ` | cloud sync → ${syncInfo.syncUrl}` : '';
    console.error(`[dude] LibSQL DB ready — project "${this.currentProject.name}" (id=${this.currentProject.id})${syncMsg}`);
  }

  _ensureDataDir() {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _createClient() {
    const url = this.config.url
      || `file:${this.config.dbPath || DB_PATH}`;

    const opts = { url };

    if (this.config.syncUrl || process.env.DUDE_TURSO_URL) {
      opts.syncUrl = this.config.syncUrl || process.env.DUDE_TURSO_URL;
      opts.authToken = this.config.authToken || process.env.DUDE_TURSO_TOKEN;
      const interval = this.config.syncInterval || process.env.DUDE_SYNC_INTERVAL;
      if (interval) opts.syncInterval = parseInt(interval);
    }

    return createClient(opts);
  }

  async _runSchema() {
    await this.db.batch([
      {
        sql: `CREATE TABLE IF NOT EXISTS project (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS record (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          title      TEXT NOT NULL,
          body       TEXT NOT NULL DEFAULT '',
          status     TEXT NOT NULL DEFAULT 'open',
          embedding  F32_BLOB(384),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS idx_record_project_kind
              ON record(project_id, kind)`,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS idx_record_embedding
              ON record(libsql_vector_idx(embedding, 'metric=cosine'))`,
      },
    ], 'write');

    // Migrate existing databases that still have CHECK constraints
    await this._migrateDropChecks();
  }

  /**
   * Detect whether the record table was created with CHECK constraints
   * (from a previous schema version) and recreate it without them.
   * This is needed because SQLite/libsql doesn't support ALTER TABLE
   * to drop constraints — the table must be recreated.
   */
  async _migrateDropChecks() {
    const result = await this.db.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='record'",
    );
    const ddl = result.rows[0]?.sql || '';
    if (!ddl.includes('CHECK')) return; // already migrated or fresh DB

    await this.db.executeMultiple(`
      CREATE TABLE record_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        status     TEXT NOT NULL DEFAULT 'open',
        embedding  F32_BLOB(384),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO record_new SELECT * FROM record;

      DROP TABLE record;

      ALTER TABLE record_new RENAME TO record;

      CREATE INDEX IF NOT EXISTS idx_record_project_kind
        ON record(project_id, kind);

      CREATE INDEX IF NOT EXISTS idx_record_embedding
        ON record(libsql_vector_idx(embedding, 'metric=cosine'));
    `);
    console.error('[dude] Migrated record table: removed CHECK constraints');
  }

  _detectProject() {
    let name;
    try {
      const toplevel = execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      name = basename(toplevel);

      try {
        const remoteUrl = execSync('git remote get-url origin', {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const match = remoteUrl.match(
          /(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/.]+)/,
        );
        if (match) {
          name = `${match[1]}/${match[2]}`;
        }
      } catch {
        // No remote — keep basename
      }
    } catch {
      name = process.cwd();
    }
    return name;
  }

  async _upsertProject(name) {
    await this.db.execute({
      sql: `INSERT INTO project (name) VALUES (?)
            ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')`,
      args: [name],
    });
    const result = await this.db.execute({
      sql: 'SELECT * FROM project WHERE name = ?',
      args: [name],
    });
    return result.rows[0];
  }

  async _migrateProjectNames(projectName) {
    if (projectName.includes('/')) {
      const oldName = basename(projectName);
      const oldResult = await this.db.execute({
        sql: 'SELECT id FROM project WHERE name = ?',
        args: [oldName],
      });
      const oldProject = oldResult.rows[0];
      if (oldProject && oldProject.id !== this.currentProject.id) {
        await this.db.execute({
          sql: 'UPDATE record SET project_id = ? WHERE project_id = ?',
          args: [this.currentProject.id, oldProject.id],
        });
        await this.db.execute({
          sql: 'DELETE FROM project WHERE id = ?',
          args: [oldProject.id],
        });
        console.error(`[dude] Migrated records from "${oldName}" to "${projectName}"`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Embedding helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert a Float32Array embedding to the JSON string format needed by
   * libsql's vector() SQL function.
   */
  _embeddingToJson(embedding) {
    return JSON.stringify(Array.from(embedding));
  }

  /**
   * Parse an F32_BLOB column value from libsql back into a Float32Array.
   * @libsql/client may return blobs as ArrayBuffer, Uint8Array, Buffer, or string.
   */
  _parseEmbedding(blob) {
    if (!blob) return null;
    if (blob instanceof Float32Array) return blob;
    if (blob instanceof ArrayBuffer) return new Float32Array(blob);
    if (ArrayBuffer.isView(blob)) {
      return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    }
    if (typeof blob === 'string') return new Float32Array(JSON.parse(blob));
    return null;
  }

  /**
   * Compute cosine similarity between a query embedding (Float32Array)
   * and a stored embedding (F32_BLOB from DB).
   * Since embed() returns L2-normalized vectors, dot product = cosine similarity.
   */
  _computeSimilarity(queryEmbedding, storedBlob) {
    const stored = this._parseEmbedding(storedBlob);
    if (!stored) return 0;
    let dot = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      dot += queryEmbedding[i] * stored[i];
    }
    return dot;
  }

  // ---------------------------------------------------------------------------
  // DbAdapter interface
  // ---------------------------------------------------------------------------

  async getCurrentProject() {
    if (!this.currentProject) throw new Error('Database not initialised');
    return { id: this.currentProject.id, name: this.currentProject.name };
  }

  async listProjects() {
    const result = await this.db.execute(
      'SELECT id, name, created_at, updated_at FROM project ORDER BY name',
    );
    return result.rows;
  }

  async get(id) {
    const result = await this.db.execute({
      sql: `SELECT ${RECORD_COLS}, p.name AS project
            FROM record r JOIN project p ON r.project_id = p.id
            WHERE r.id = ?`,
      args: [id],
    });
    return result.rows[0] ?? null;
  }

  async list({ kind, status, project } = {}) {
    let projectId;
    if (!project || project === 'current') {
      projectId = (await this.getCurrentProject()).id;
    } else if (project !== '*') {
      const p = await this.db.execute({
        sql: 'SELECT id FROM project WHERE name = ?',
        args: [project],
      });
      projectId = p.rows[0]?.id;
    }

    let sql = `
      SELECT r.id, r.kind, r.title, r.status, r.updated_at, p.name AS project
      FROM record r JOIN project p ON r.project_id = p.id
      WHERE 1=1
    `;
    const args = [];

    if (projectId) {
      sql += ' AND r.project_id = ?';
      args.push(projectId);
    }
    if (kind && kind !== 'all') {
      sql += ' AND r.kind = ?';
      args.push(kind);
    }
    if (status && status !== 'all') {
      sql += ' AND r.status = ?';
      args.push(status);
    }
    sql += ' ORDER BY r.updated_at DESC';

    const result = await this.db.execute({ sql, args });
    return result.rows;
  }

  async getRecentRecords(projectId, hours = 1) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const result = await this.db.execute({
      sql: `SELECT r.id, r.kind, r.title, r.status, r.updated_at, p.name AS project
            FROM record r JOIN project p ON r.project_id = p.id
            WHERE r.project_id = ? AND r.updated_at > ?
            ORDER BY r.updated_at DESC LIMIT 10`,
      args: [projectId, cutoff],
    });
    return result.rows;
  }

  async delete(id) {
    const result = await this.db.execute({
      sql: 'DELETE FROM record WHERE id = ?',
      args: [id],
    });
    return result.rowsAffected > 0;
  }

  async search(embedding, { kind, projectId, limit = 5 } = {}) {
    const curProject = await this.getCurrentProject();
    const embJson = this._embeddingToJson(embedding);
    const candidateLimit = Math.floor(limit * 3);

    // vector_top_k returns rowid matches; join to get full record data + embedding for similarity
    // k must be inlined as a literal integer — libsql rejects bound float params for k
    let sql = `
      SELECT ${RECORD_COLS}, r.embedding, p.name AS project
      FROM vector_top_k('idx_record_embedding', vector(?), ${candidateLimit}) AS v
      JOIN record r ON r.rowid = v.id
      JOIN project p ON r.project_id = p.id
    `;
    const args = [embJson];

    if (kind && kind !== 'all') {
      sql += ' WHERE r.kind = ?';
      args.push(kind);
    }

    const result = await this.db.execute({ sql, args });

    let rows = result.rows.map(row => {
      const similarity = this._computeSimilarity(embedding, row.embedding);
      const boosted = (row.project === curProject.name)
        ? Math.min(1.0, similarity + 0.1)
        : similarity;
      return { ...row, similarity: boosted };
    });

    return rows
      .filter(r => r.similarity >= 0.3)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(({ embedding: _emb, ...rest }) => rest);
  }

  async upsert({ id, projectId, kind, title, body = '', status = 'open' }, embedding) {
    const proj = projectId ?? (await this.getCurrentProject()).id;
    const now = new Date().toISOString();
    const embJson = this._embeddingToJson(embedding);

    if (id) {
      await this.db.execute({
        sql: `UPDATE record SET kind = ?, title = ?, body = ?, status = ?,
              embedding = vector(?), updated_at = ?
              WHERE id = ?`,
        args: [kind, title, body, status, embJson, now, id],
      });
      return this.get(id);
    }

    // Dedup check: find close matches in same project + kind
    // k=5 inlined as literal — libsql rejects bound float params for k
    const candidates = await this.db.execute({
      sql: `SELECT r.id, r.embedding
            FROM vector_top_k('idx_record_embedding', vector(?), 5) AS v
            JOIN record r ON r.rowid = v.id
            WHERE r.project_id = ? AND r.kind = ?`,
      args: [embJson, proj, kind],
    });

    for (const row of candidates.rows) {
      const similarity = this._computeSimilarity(embedding, row.embedding);
      if (similarity >= 0.85) {
        // Close match — update existing record
        await this.db.execute({
          sql: `UPDATE record SET title = ?, body = ?, status = ?,
                embedding = vector(?), updated_at = ?
                WHERE id = ?`,
          args: [title, body, status, embJson, now, row.id],
        });
        return this.get(row.id);
      }
    }

    // Insert new record
    const result = await this.db.execute({
      sql: `INSERT INTO record (project_id, kind, title, body, status, embedding, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, vector(?), ?, ?)`,
      args: [proj, kind, title, body, status, embJson, now, now],
    });

    return this.get(Number(result.lastInsertRowid));
  }

  async syncStatus() {
    const syncUrl = this.config.syncUrl || process.env.DUDE_TURSO_URL || null;
    const syncInterval = this.config.syncInterval
      || process.env.DUDE_SYNC_INTERVAL
      || null;
    return {
      enabled: !!syncUrl,
      ...(syncUrl ? { syncUrl } : {}),
      ...(syncInterval ? { syncInterval: parseInt(syncInterval) } : {}),
    };
  }

  async sync() {
    const status = await this.syncStatus();
    if (!status.enabled) {
      return { synced: false, message: 'Cloud sync not configured. Set DUDE_TURSO_URL and DUDE_TURSO_TOKEN to enable.' };
    }
    try {
      await this.db.sync();
      return { synced: true, message: `Synced with ${status.syncUrl}` };
    } catch (err) {
      return { synced: false, message: `Sync failed: ${err.message}` };
    }
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
