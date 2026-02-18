# Dude Plugin Migration: better-sqlite3 + sqlite-vec → libsql/Turso

Migration plan for replacing `better-sqlite3` + `sqlite-vec` with `@libsql/client`, gaining native vector columns, async API, and optional Turso cloud sync.

## Current State ✅

| Component | Technology | Location |
|-----------|-----------|----------|
| Driver | `@libsql/client` (async) | `src/db-libsql.js` |
| Vector search | `F32_BLOB(384)` native column + `vector_top_k` | `src/db-libsql.js` |
| Embedding model | `Xenova/all-MiniLM-L6-v2` (384-dim) | `src/embed.js` — unchanged by migration |
| DB file | `~/.dude-claude/dude-libsql.db` | `src/db-libsql.js:9` |
| Legacy driver | `better-sqlite3` + `sqlite-vec` (for migration only) | `src/db-sqlite-vec.js` |
| DB factory | Auto-detects and migrates | `src/db.js` |

### Current Schema

```sql
-- src/db-libsql.js _runSchema()
CREATE TABLE project (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE record (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('issue','spec','arch','update')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','archived')),
  embedding  F32_BLOB(384),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_record_project_kind ON record(project_id, kind);
CREATE INDEX idx_record_embedding ON record(libsql_vector_idx(embedding, 'metric=cosine'));
```

### Current Query Patterns (src/db-libsql.js)

**Insert** — single statement with `vector()` SQL function:
```js
await db.execute({
  sql: `INSERT INTO record (project_id, kind, title, body, status, embedding, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, vector(?), ?, ?)`,
  args: [proj, kind, title, body, status, embJson, now, now],
});
```

**KNN search** — `vector_top_k` with application-side similarity:
```sql
SELECT r.*, r.embedding, p.name AS project
FROM vector_top_k('idx_record_embedding', vector(?), ?) AS v
JOIN record r ON r.rowid = v.id
JOIN project p ON r.project_id = p.id
```

**Embedding format** — `Float32Array` → JSON string via `_embeddingToJson()`:
```js
_embeddingToJson(embedding) { return JSON.stringify(Array.from(embedding)); }
```

### Legacy Schema (pre-migration)

```sql
-- Original better-sqlite3 + sqlite-vec schema (kept for reference)
CREATE VIRTUAL TABLE record_embedding USING vec0(
  record_id  INTEGER PRIMARY KEY,
  embedding  FLOAT[384] distance_metric=cosine
);
```

---

## Key Differences

| Aspect | Current (sqlite-vec) | Target (libsql) |
|--------|---------------------|------------------|
| **Driver** | `better-sqlite3` (sync) | `@libsql/client` (async) |
| **Vector storage** | `vec0` virtual table (separate from data) | `F32_BLOB(384)` native column type (same table) |
| **Insert vectors** | `Float32Array.buffer` bound to virtual table | `vector('[1,2,3,...]')` SQL function |
| **KNN query** | `WHERE embedding MATCH ? ORDER BY distance` | `vector_top_k('idx_name', vector(?), k) JOIN records ON records.rowid = id` |
| **Indexing** | Implicit in `vec0` virtual table | `CREATE INDEX ... ON tbl(libsql_vector_idx(col))` |
| **Cloud sync** | None | Embedded replicas with `syncUrl` |

The libsql approach is simpler — vectors live in the regular `record` table as a native column, eliminating the separate `record_embedding` virtual table and the two-insert pattern.

---

## Phased Migration Plan

Each phase is a standalone version bump. New users can start at any version.


### Phase 1: Abstract the DB Layer (non-breaking) ✅

**Goal:** Decouple all callers from `better-sqlite3` specifics so backends can be swapped without changing tool handlers, hooks, or the web server.

**Version bump:** patch (no user-visible change)

**Status:** COMPLETE — `src/db-adapter.js` base class created, `src/db-sqlite-vec.js` wraps legacy code, all callers use async adapter API.

Create `src/db-adapter.js` — a base class that both backends implement:

```js
// src/db-adapter.js
export class DbAdapter {
  async search(embedding, { limit, kind, project } = {}) {}  // → [{ id, project, kind, title, body, status, similarity }]
  async upsert(record, embedding) {}                          // → { id, ...record }
  async get(id) {}                                            // → record | null
  async list(filters) {}                                      // → [record]
  async delete(id) {}                                         // → boolean
  async listProjects() {}                                     // → [project]
  async getCurrentProject() {}                                // → project
  async close() {}
}
```

Wrap the existing `better-sqlite3` + `sqlite-vec` code in `src/db-sqlite-vec.js` implementing this interface. The sync calls get wrapped in Promises to make the API uniformly async.

**Files changed:**
| File | Change |
|------|--------|
| `src/db-adapter.js` | New — abstract interface |
| `src/db-sqlite-vec.js` | New — wraps current `db.js` logic behind adapter |
| `src/db.js` | Refactor to factory; exports `initDb()` returning a `DbAdapter` instance |
| `src/server.js` | Change `searchRecords(...)` calls to `db.search(...)` etc. (6 tools) |
| `src/web.js` | Same pattern — call through adapter |
| `hooks/auto-retrieve.js` | Use async adapter (`await db.search(...)`) |
| `hooks/auto-persist.js` | Use async adapter (`await db.upsert(...)`) |
| `hooks/auto-persist-plan.js` | Use async adapter (`await db.upsert(...)`) |

**Key detail:** The hook scripts (`hooks/*.js`) currently import from `src/db.js` directly and use sync APIs. They must become async even for the sqlite-vec backend — this is the main code change in Phase 1.

**Risk:** Low — pure refactor, same behavior.


### Phase 2: Implement the libsql Backend ✅

**Goal:** Add `src/db-libsql.js` implementing `DbAdapter` with `@libsql/client`.

**Version bump:** minor (new capability, not yet default)

**Status:** COMPLETE — `src/db-libsql.js` fully implements `DbAdapter` with native `F32_BLOB(384)` columns, `vector_top_k` search, application-side cosine similarity, and dedup logic.

#### New Schema

Vectors become a native column on `record`:

```sql
CREATE TABLE project (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE record (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('issue','spec','arch','update')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','archived')),
  embedding  F32_BLOB(384),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_record_project_kind
  ON record(project_id, kind);

CREATE INDEX idx_record_embedding
  ON record(libsql_vector_idx(embedding, 'metric=cosine'));
```

No `record_embedding` virtual table. The `embedding` column lives directly on `record`.

#### Query Translation

**Insert** — single statement:
```js
await db.execute({
  sql: `INSERT INTO record (project_id, kind, title, body, status, embedding)
        VALUES (?, ?, ?, ?, ?, vector(?))`,
  args: [projectId, kind, title, body, status, JSON.stringify(Array.from(embedding))]
});
```

**Update embedding** — direct UPDATE (vec0 required delete+insert):
```js
await db.execute({
  sql: `UPDATE record SET title=?, body=?, status=?, embedding=vector(?), updated_at=datetime('now')
        WHERE id=?`,
  args: [title, body, status, JSON.stringify(Array.from(embedding)), id]
});
```

**KNN search:**
```sql
SELECT r.*, v.id AS _vid
FROM vector_top_k('idx_record_embedding', vector(?), ?) AS v
JOIN record r ON r.rowid = v.id
```

Note: `vector_top_k` does not return a distance column directly. Cosine similarity must be computed application-side or via a subquery if needed.

**Deduplication check** (currently `db.js` line ~266, distance ≤ 0.15):
```sql
SELECT r.id
FROM vector_top_k('idx_record_embedding', vector(?), 5) AS v
JOIN record r ON r.rowid = v.id
WHERE r.project_id = ? AND r.kind = ?
LIMIT 1
```

After retrieving the top match, compute cosine distance application-side from the stored embedding and compare against the 0.15 threshold.

#### Client Initialization

```js
import { createClient } from '@libsql/client';

const db = createClient({
  url: `file:${dbPath}`,                      // local-first
  syncUrl: process.env.DUDE_TURSO_URL,         // optional cloud
  authToken: process.env.DUDE_TURSO_TOKEN,
  syncInterval: parseInt(process.env.DUDE_SYNC_INTERVAL || '60000'),
});
```

**Risk:** Low — new code, not yet wired in as default.


### Phase 3: Data Migration Script ✅

**Goal:** Migrate existing `~/.dude-claude/dude.db` data (including embeddings) to the libsql schema.

**Version bump:** included with Phase 4 release

**Status:** COMPLETE — `scripts/migrate-to-libsql.js` handles full data migration including embedding round-trip (Float32Array → JSON → vector()). Tested with empty DBs, orphaned records, and embedding fidelity checks.

```js
// scripts/migrate-to-libsql.js
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { createClient } from '@libsql/client';

async function migrate(oldDbPath, newDbPath) {
  const oldDb = new Database(oldDbPath);
  sqliteVec.load(oldDb);

  const newDb = createClient({ url: `file:${newDbPath}` });

  // 1. Create new schema (project + record tables, vector index)
  await newDb.batch([/* CREATE TABLE + CREATE INDEX statements */]);

  // 2. Migrate projects
  const projects = oldDb.prepare('SELECT * FROM project').all();
  for (const p of projects) {
    await newDb.execute({
      sql: 'INSERT INTO project (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      args: [p.id, p.name, p.created_at, p.updated_at],
    });
  }

  // 3. Migrate records with embeddings
  const records = oldDb.prepare('SELECT * FROM record').all();
  for (const r of records) {
    const vec = oldDb.prepare(
      'SELECT embedding FROM record_embedding WHERE record_id = ?'
    ).get(r.id);

    const embeddingJson = vec
      ? JSON.stringify(Array.from(new Float32Array(vec.embedding)))
      : null;

    await newDb.execute({
      sql: `INSERT INTO record (id, project_id, kind, title, body, status, embedding, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ${vec ? 'vector(?)' : 'NULL'}, ?, ?)`,
      args: [
        r.id, r.project_id, r.kind, r.title, r.body, r.status,
        ...(vec ? [embeddingJson] : []),
        r.created_at, r.updated_at,
      ],
    });
  }

  oldDb.close();
}
```

**Testing checklist:**
- Round-trip: verify embeddings survive Float32Array → JSON → vector() → F32_BLOB
- Verify KNN search returns same top-k results pre/post migration
- Test with empty DB (no records)
- Test with records missing embeddings (orphaned record rows)

**Risk:** Medium — data fidelity must be validated.


### Phase 4: Backend Selection + Auto-Migration ✅

**Goal:** On startup, detect which DB exists and choose the right backend. Auto-migrate existing users.

**Version bump:** major (breaking change to internal storage format)

**Status:** COMPLETE — `src/db.js` factory auto-detects old DB, runs migration, renames to `.backup`, and always returns `LibsqlAdapter`. Handles migration failures with cleanup and retry on next startup.

```js
// src/db.js (factory)
import { existsSync } from 'fs';
import { join } from 'path';
import { rename } from 'fs/promises';

const DB_DIR  = join(os.homedir(), '.dude-claude');
const OLD_DB  = join(DB_DIR, 'dude.db');
const NEW_DB  = join(DB_DIR, 'dude-libsql.db');

export async function initDb(config) {
  // Fresh install → libsql directly
  if (!existsSync(OLD_DB) && !existsSync(NEW_DB)) {
    return new LibsqlAdapter({ dbPath: NEW_DB, ...config });
  }

  // Already migrated
  if (existsSync(NEW_DB)) {
    return new LibsqlAdapter({ dbPath: NEW_DB, ...config });
  }

  // Old DB exists, not yet migrated → auto-migrate
  if (existsSync(OLD_DB)) {
    console.error('Migrating database to libsql format...');
    await migrate(OLD_DB, NEW_DB);
    await rename(OLD_DB, OLD_DB + '.backup');
    return new LibsqlAdapter({ dbPath: NEW_DB, ...config });
  }
}
```

**User impact:** One-time pause on first run while migration completes. Old DB preserved as `dude.db.backup`.

**Risk:** Medium — must handle edge cases (locked DB, partial migration, disk space).


### Phase 5: Cloud Sync (opt-in) ✅

**Goal:** Optional Turso cloud sync via environment variables.

**Version bump:** minor (opt-in feature)

**Status:** COMPLETE — Cloud sync wired up in `_createClient()`, manual `sync()` method added, `sync_status` MCP tool and `/api/sync-status` endpoint available for visibility.

```bash
# Environment variables
DUDE_TURSO_URL=libsql://your-db-name.turso.io
DUDE_TURSO_TOKEN=your-auth-token
DUDE_SYNC_INTERVAL=60000  # ms, default 1 min
```

When configured, `@libsql/client` automatically syncs the local embedded replica with Turso. The plugin works 100% offline by default; cloud sync is a bonus.

#### Implementation Details

The `_createClient()` method in `src/db-libsql.js` passes `syncUrl`, `authToken`, and `syncInterval` to `createClient()` when `DUDE_TURSO_URL` is set. Additional features:

- **`sync()` method** on `LibsqlAdapter` — triggers an immediate manual sync and returns stats
- **`syncStatus()` method** — returns whether cloud sync is configured and connection info
- **`sync_status` MCP tool** — lets Claude check sync configuration status
- **`/api/sync-status` endpoint** — exposes sync status to the web dashboard

**Risk:** Low — only activates with explicit env vars.

---

## Dependency Changes

```diff
  "dependencies": {
-   "better-sqlite3": "^11.8.1",
-   "sqlite-vec": "^0.1.6",
+   "@libsql/client": "^0.14.0",
    "@huggingface/transformers": "^3.4.1",
    "@modelcontextprotocol/sdk": "^1.12.1",
    "zod": "^3.24.2"
  }
```

The `@libsql/client` npm package bundles the libsql native binary — no separate extension loading. This simplifies installation since `sqlite-vec` sometimes has platform-specific build issues with native compilation.

**Current state:** Both old and new packages remain in `dependencies` to support auto-migration from legacy DBs. The `better-sqlite3` and `sqlite-vec` packages are only loaded on-demand during migration (dynamic import in `src/db.js`). They can be moved to `optionalDependencies` or removed once the legacy migration window closes.

---

## Rollout Summary

| Phase | Version Bump | User Impact | Risk | Status |
|-------|-------------|------------|------|--------|
| 1. Abstract DB layer | patch | Zero — refactor only | Low | **DONE** |
| 2. Implement libsql backend | minor | Zero — not yet active | Low | **DONE** |
| 3. Migration script | (bundled with 4) | Zero — not yet wired up | Medium | **DONE** |
| 4. Auto-migration on upgrade | **major** | One-time pause on first run; old DB kept as `.backup` | Medium | **DONE** |
| 5. Cloud sync opt-in | minor | Zero — only activates with env vars | Low | **DONE** |

---

## Gotchas

### 1. Sync → Async API

The biggest code change. Every `db.prepare().run()` / `.get()` / `.all()` becomes `await db.execute()`. Affected files:

- `src/server.js` — 6 tool handlers (already async, just need `await`)
- `src/web.js` — 7 route handlers (already async)
- `hooks/auto-retrieve.js` — imports `searchRecords` directly (line 25)
- `hooks/auto-persist.js` — imports `upsertRecord` directly (line 39)
- `hooks/auto-persist-plan.js` — imports `upsertRecord` directly (line 39)

The hooks are the riskiest because they currently rely on synchronous DB calls completing before the process exits.

### 2. Embedding Format

| Backend | Insert format | Read format |
|---------|--------------|-------------|
| sqlite-vec | `Buffer.from(Float32Array.buffer)` | Raw bytes → `new Float32Array(buf.buffer)` |
| libsql | `vector('[1.0, 2.0, ...]')` (JSON string in SQL function) | F32_BLOB → needs parsing |

The `embed()` function in `src/embed.js` returns `Float32Array` — each adapter converts to its backend's format.

### 3. Distance Metric

- sqlite-vec: cosine distance configured in `vec0` definition (`distance_metric=cosine`)
- libsql: cosine metric set in index creation (`'metric=cosine'`)
- Both return distance (0 = identical), converted to similarity via `1 - distance`
- Current similarity threshold of 0.3 and dedup distance of 0.15 should transfer directly

### 4. rowid vs Primary Key

libsql's `vector_top_k` returns an `id` column that maps to `rowid`. The `record` table uses `INTEGER PRIMARY KEY AUTOINCREMENT` for `id`, which in SQLite is an alias for `rowid` — so `JOIN record ON record.rowid = v.id` works correctly. No schema change needed.

### 5. Transaction Handling

Current code uses `d.transaction(() => { ... })` for atomic operations (delete + embedding, upsert with dedup). libsql equivalent:

```js
await db.batch([
  { sql: 'DELETE FROM record WHERE id = ?', args: [id] },
  // embedding deleted automatically since it's a column, not a separate table
], 'write');
```

Or for conditional logic (dedup check), use `db.transaction()`:

```js
const tx = await db.transaction('write');
try {
  // check for duplicates, then insert or update
  await tx.commit();
} catch (e) {
  await tx.rollback();
  throw e;
}
```

### 6. Platform Compatibility

`@libsql/client` works on Node 18+ and bundles native binaries for Linux, macOS, and Windows. Since the plugin is invoked via `npx dude-claude-plugin`, the binary is resolved at install time. Test on all three platforms.

### 7. vector_top_k Distance Access

Unlike sqlite-vec's `MATCH` which returns a `distance` column, libsql's `vector_top_k` may not expose distance directly in all versions. If distance is needed (for the 0.15 dedup threshold and similarity scoring), compute it application-side:

```js
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;  // vectors are already L2-normalized by embed()
}
```

This works because `src/embed.js` returns normalized vectors (`normalize: true`), so dot product = cosine similarity.
