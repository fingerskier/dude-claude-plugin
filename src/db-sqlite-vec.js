import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DbAdapter } from './db-adapter.js';

/** Convert a Float32Array embedding to a Node.js Buffer for sqlite-vec binding. */
function embeddingBuffer(emb) {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

const DATA_DIR = join(homedir(), '.dude-claude');
const DB_PATH = join(DATA_DIR, 'dude.db');

/**
 * SqliteVecAdapter — wraps better-sqlite3 + sqlite-vec behind the DbAdapter interface.
 * Sync calls are wrapped in Promises for a uniform async API.
 */
export class SqliteVecAdapter extends DbAdapter {
  constructor() {
    super();
    this.db = null;
    this.currentProject = null;
  }

  // ---------------------------------------------------------------------------
  // Initialisation
  // ---------------------------------------------------------------------------

  async init() {
    if (this.db) return;
    this._ensureDataDir();
    this.db = this._openDb();
    await this._runMigrations();
    const projectName = this._detectProject();
    this.currentProject = this._upsertProject(projectName);
    this._migrateProjectNames(projectName);
    console.error(`[dude] DB ready — project "${this.currentProject.name}" (id=${this.currentProject.id})`);
  }

  _ensureDataDir() {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _openDb() {
    const d = new Database(DB_PATH);
    sqliteVec.load(d);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    d.pragma('busy_timeout = 5000');
    console.error(`[dude] Database opened: ${DB_PATH}`);
    return d;
  }

  async _runMigrations() {
    const d = this.db;
    d.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
    const row = d.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    const currentVersion = row?.v ?? 0;

    const migrationsDir = new URL('./migrations/', import.meta.url);
    const migrationsPath = fileURLToPath(migrationsDir);

    const files = readdirSync(migrationsPath)
      .filter(f => f.endsWith('.js'))
      .sort();

    for (const file of files) {
      const mod = await import(pathToFileURL(join(migrationsPath, file)).href);
      if (mod.version > currentVersion) {
        console.error(`[dude] Running migration ${file} (v${mod.version})…`);
        const tx = d.transaction(() => {
          mod.up(d);
          d.prepare('INSERT INTO schema_version (version) VALUES (?)').run(mod.version);
        });
        tx();
      }
    }
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
          /(?:github\.com|gitlab\.com|bitbucket\.org)[/:]([^/]+)\/([^/.]+)/
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

  _upsertProject(name) {
    this.db.prepare(`
      INSERT INTO project (name) VALUES (?)
      ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')
    `).run(name);
    return this.db.prepare('SELECT * FROM project WHERE name = ?').get(name);
  }

  _migrateProjectNames(projectName) {
    if (projectName.includes('/')) {
      const oldName = basename(projectName);
      const oldProject = this.db.prepare('SELECT id FROM project WHERE name = ?').get(oldName);
      if (oldProject && oldProject.id !== this.currentProject.id) {
        this.db.prepare('UPDATE record SET project_id = ? WHERE project_id = ?')
          .run(this.currentProject.id, oldProject.id);
        this.db.prepare('DELETE FROM project WHERE id = ?').run(oldProject.id);
        console.error(`[dude] Migrated records from "${oldName}" to "${projectName}"`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // DbAdapter interface
  // ---------------------------------------------------------------------------

  async getCurrentProject() {
    if (!this.currentProject) throw new Error('Database not initialised');
    return { id: this.currentProject.id, name: this.currentProject.name };
  }

  async listProjects() {
    return this.db.prepare('SELECT id, name, created_at, updated_at FROM project ORDER BY name').all();
  }

  async get(id) {
    return this._getRecord(id);
  }

  async list({ kind, status, project } = {}) {
    let projectId;
    if (!project || project === 'current') {
      projectId = (await this.getCurrentProject()).id;
    } else if (project !== '*') {
      const p = this.db.prepare('SELECT id FROM project WHERE name = ?').get(project);
      projectId = p?.id;
    }

    let sql = `
      SELECT r.id, r.kind, r.title, r.status, r.updated_at, p.name AS project
      FROM record r JOIN project p ON r.project_id = p.id
      WHERE 1=1
    `;
    const params = [];

    if (projectId) {
      sql += ' AND r.project_id = ?';
      params.push(projectId);
    }
    if (kind && kind !== 'all') {
      sql += ' AND r.kind = ?';
      params.push(kind);
    }
    if (status && status !== 'all') {
      sql += ' AND r.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY r.updated_at DESC';

    return this.db.prepare(sql).all(...params);
  }

  async getRecentRecords(projectId, hours = 1) {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT r.id, r.kind, r.title, r.status, r.updated_at, p.name AS project
      FROM record r JOIN project p ON r.project_id = p.id
      WHERE r.project_id = ? AND r.updated_at > ?
      ORDER BY r.updated_at DESC
      LIMIT 10
    `).all(projectId, cutoff);
  }

  async delete(id) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM record WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return tx();
  }

  async search(embedding, { kind, project, limit = 5 } = {}) {
    const boostProject = project === '*' ? null : (project || (await this.getCurrentProject()).name);

    let sql = `
      SELECT
        re.record_id,
        re.distance,
        r.id, r.kind, r.title, r.body, r.status,
        r.created_at, r.updated_at,
        p.name AS project
      FROM record_embedding re
      JOIN record r ON r.id = re.record_id
      JOIN project p ON r.project_id = p.id
      WHERE re.embedding MATCH ? AND k = ?
    `;
    const params = [embeddingBuffer(new Float32Array(embedding)), limit * 3];

    if (kind && kind !== 'all') {
      sql += ' AND r.kind = ?';
      params.push(kind);
    }

    sql += ' ORDER BY re.distance';

    let rows = this.db.prepare(sql).all(...params);

    // Convert cosine distance to similarity and apply project boost
    rows = rows.map(row => {
      let similarity = 1 - row.distance;
      if (boostProject && row.project === boostProject) {
        similarity = Math.min(1.0, similarity + 0.1);
      }
      return { ...row, similarity };
    });

    // Filter out low-similarity results and limit
    return rows
      .filter(r => r.similarity >= 0.3)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map(({ record_id, distance, ...rest }) => rest);
  }

  async upsert({ id, projectId, kind, title, body = '', status = 'open' }, embedding) {
    const proj = projectId ?? (await this.getCurrentProject()).id;
    const now = new Date().toISOString();

    const tx = this.db.transaction(() => {
      if (id) {
        this.db.prepare(`
          UPDATE record SET kind = ?, title = ?, body = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(kind, title, body, status, now, id);

        // vec0 doesn't support UPDATE — delete then insert
        this.db.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(id);
        this.db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(BigInt(id), embeddingBuffer(embedding));

        return this._getRecord(id);
      }

      // Dedup check: look for close matches in same project+kind
      const candidates = this.db.prepare(`
        SELECT re.record_id, re.distance
        FROM record_embedding re
        JOIN record r ON r.id = re.record_id
        WHERE re.embedding MATCH ? AND k = 5
          AND r.project_id = ? AND r.kind = ?
        ORDER BY re.distance
        LIMIT 1
      `).all(embeddingBuffer(embedding), proj, kind);

      if (candidates.length > 0 && candidates[0].distance <= 0.15) {
        // Close match found — update existing record
        const existingId = candidates[0].record_id;
        this.db.prepare(`
          UPDATE record SET title = ?, body = ?, status = ?, updated_at = ?
          WHERE id = ?
        `).run(title, body, status, now, existingId);

        this.db.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(existingId);
        this.db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(BigInt(existingId), embeddingBuffer(embedding));

        return this._getRecord(existingId);
      }

      // Insert new record
      const result = this.db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(proj, kind, title, body, status, now, now);

      const newId = result.lastInsertRowid;
      this.db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(BigInt(newId), embeddingBuffer(embedding));

      return this._getRecord(Number(newId));
    });

    return tx();
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers (synchronous, for use within transactions)
  // ---------------------------------------------------------------------------

  _getRecord(id) {
    const row = this.db.prepare(`
      SELECT r.*, p.name AS project
      FROM record r JOIN project p ON r.project_id = p.id
      WHERE r.id = ?
    `).get(id);
    return row ?? null;
  }
}
