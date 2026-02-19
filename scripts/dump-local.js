#!/usr/bin/env node
/**
 * Export the local libsql database as SQL INSERT statements.
 *
 * Usage:
 *   node scripts/dump-local.js > dump.sql
 *   turso db shell <dbname> < dump.sql
 *
 * Reads from ~/.dude-claude/dude-libsql.db (or DUDE_DB_PATH env override).
 * Outputs projects first, then records (with vector embeddings), to stdout.
 */

import { createClient } from '@libsql/client';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), '.dude-claude');
const DB_PATH = process.env.DUDE_DB_PATH || join(DATA_DIR, 'dude-libsql.db');

function esc(str) {
  if (str == null) return 'NULL';
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function parseEmbedding(blob) {
  if (!blob) return null;
  if (blob instanceof Float32Array) return blob;
  if (blob instanceof ArrayBuffer) return new Float32Array(blob);
  if (ArrayBuffer.isView(blob)) {
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  }
  if (typeof blob === 'string') return new Float32Array(JSON.parse(blob));
  return null;
}

async function main() {
  const db = createClient({ url: `file:${DB_PATH}` });

  // -- Projects --
  const projects = await db.execute('SELECT * FROM project ORDER BY id');
  for (const p of projects.rows) {
    console.log(
      `INSERT INTO project (id, name, created_at, updated_at) VALUES (${p.id}, ${esc(p.name)}, ${esc(p.created_at)}, ${esc(p.updated_at)});`
    );
  }

  // -- Records (with embeddings) --
  const records = await db.execute('SELECT * FROM record ORDER BY id');
  for (const r of records.rows) {
    const emb = parseEmbedding(r.embedding);
    const embExpr = emb
      ? `vector('${JSON.stringify(Array.from(emb))}')`
      : 'NULL';

    console.log(
      `INSERT INTO record (id, project_id, kind, title, body, status, embedding, created_at, updated_at) VALUES (${r.id}, ${r.project_id}, ${esc(r.kind)}, ${esc(r.title)}, ${esc(r.body)}, ${esc(r.status)}, ${embExpr}, ${esc(r.created_at)}, ${esc(r.updated_at)});`
    );
  }

  db.close();
  console.error(`[dump] Exported ${projects.rows.length} projects, ${records.rows.length} records`);
}

main().catch(err => {
  console.error('dump-local failed:', err);
  process.exit(1);
});
