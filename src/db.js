import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

/** Convert a Float32Array embedding to a Node.js Buffer for sqlite-vec binding. */
function embeddingBuffer(emb) {
  return Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
}

const DATA_DIR = join(homedir(), '.dude-claude');
const DB_PATH = join(DATA_DIR, 'dude.db');

let db = null;
let currentProject = null;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function openDb() {
  const d = new Database(DB_PATH);
  sqliteVec.load(d);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  return d;
}

async function runMigrations(d) {
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

function detectProject() {
  let name;
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    name = basename(toplevel);
  } catch {
    name = process.cwd();
  }
  return name;
}

function upsertProject(d, name) {
  d.prepare(`
    INSERT INTO project (name) VALUES (?)
    ON CONFLICT(name) DO UPDATE SET updated_at = datetime('now')
  `).run(name);
  return d.prepare('SELECT * FROM project WHERE name = ?').get(name);
}

export async function initDb() {
  if (db) return db;
  ensureDataDir();
  db = openDb();
  await runMigrations(db);
  const projectName = detectProject();
  currentProject = upsertProject(db, projectName);
  console.error(`[dude] DB ready — project "${currentProject.name}" (id=${currentProject.id})`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not initialised — call initDb() first');
  return db;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getCurrentProject() {
  if (!currentProject) throw new Error('Database not initialised');
  return { id: currentProject.id, name: currentProject.name };
}

export function listProjects() {
  return getDb().prepare('SELECT id, name, created_at, updated_at FROM project ORDER BY name').all();
}

export function getRecord(id) {
  const row = getDb().prepare(`
    SELECT r.*, p.name AS project
    FROM record r JOIN project p ON r.project_id = p.id
    WHERE r.id = ?
  `).get(id);
  return row ?? null;
}

export function listRecords({ kind, status, project } = {}) {
  const d = getDb();
  let projectId;
  if (!project || project === 'current') {
    projectId = getCurrentProject().id;
  } else if (project !== '*') {
    const p = d.prepare('SELECT id FROM project WHERE name = ?').get(project);
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

  return d.prepare(sql).all(...params);
}

export function deleteRecord(id) {
  const d = getDb();
  d.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(id);
  const result = d.prepare('DELETE FROM record WHERE id = ?').run(id);
  return result.changes > 0;
}

export function searchRecords(embedding, { kind, projectId, limit = 5 } = {}) {
  const d = getDb();
  const curProject = getCurrentProject();
  const targetProjectId = projectId ?? curProject.id;

  // vec0 MATCH query — cosine distance metric (0 = identical, 1 = orthogonal)
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
  const params = [embeddingBuffer(new Float32Array(embedding)), limit * 3]; // over-fetch for filtering

  if (kind && kind !== 'all') {
    sql += ' AND r.kind = ?';
    params.push(kind);
  }

  sql += ' ORDER BY re.distance';

  let rows = d.prepare(sql).all(...params);

  // Convert cosine distance to similarity and apply project boost
  rows = rows.map(row => {
    let similarity = 1 - row.distance;
    // Boost current-project results by +0.1, capped at 1.0
    if (row.project === curProject.name) {
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

export function upsertRecord({ id, projectId, kind, title, body = '', status = 'open' }, embedding) {
  const d = getDb();
  const proj = projectId ?? getCurrentProject().id;
  const now = new Date().toISOString();

  if (id) {
    // Explicit update
    d.prepare(`
      UPDATE record SET kind = ?, title = ?, body = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(kind, title, body, status, now, id);

    // vec0 doesn't support UPDATE — delete then insert
    d.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(id);
    d.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(BigInt(id), embeddingBuffer(embedding));

    return getRecord(id);
  }

  // Dedup check: look for close matches in same project+kind
  const candidates = d.prepare(`
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
    d.prepare(`
      UPDATE record SET title = ?, body = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(title, body, status, now, existingId);

    d.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(existingId);
    d.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(BigInt(existingId), embeddingBuffer(embedding));

    return getRecord(existingId);
  }

  // Insert new record
  const result = d.prepare(`
    INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(proj, kind, title, body, status, now, now);

  const newId = result.lastInsertRowid;
  d.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(BigInt(newId), embeddingBuffer(embedding));

  return getRecord(Number(newId));
}
