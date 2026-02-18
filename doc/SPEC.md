# Dude Claude Plugin — Implementation Specification

Ultra-minimal RAG and cross-project memory for Claude CLI.

## 1. Architecture Overview

The plugin is an **MCP (Model Context Protocol) stdio server** written in Node.js.
Claude CLI launches it as a subprocess and communicates via JSON-RPC 2.0 over stdin/stdout.

Companion **hooks** (configured in `.claude/settings.json`) fire at session boundaries to automatically inject retrieved context and persist learnings without explicit tool calls.

```
Claude CLI
  ├── MCP stdio server  (tools: search, CRUD, sync)
  │     └── libsql (local-first, optional Turso cloud sync)
  └── Hooks
        ├── UserPromptSubmit  → auto-retrieve relevant records (command hook)
        ├── Stop              → classify & persist via agent hook → MCP upsert
        └── SubagentStop      → persist plan specs via agent hook → MCP upsert
```

## 2. Technology Stack

| Component       | Choice                | Rationale                              |
|-----------------|-----------------------|----------------------------------------|
| Runtime         | Node.js >=18          | Claude CLI ecosystem is JS/TS-centric  |
| Language        | Plain JavaScript (ESM)| Zero build step; ultra-minimal goal    |
| Database        | `@libsql/client`      | Async, SQLite-compatible, native vector columns, optional Turso cloud sync |
| Vector search   | `F32_BLOB(384)` + `vector_top_k` | Native libsql vector index; no separate extension |
| Embeddings      | Local: all-MiniLM-L6-v2 via `@huggingface/transformers` | Offline, fast, 384-dim |
| MCP SDK         | `@modelcontextprotocol/sdk` | Official MCP server library   |
| Web UI          | Bare `http` module + static HTML | No framework; minimal       |
| Legacy support  | `better-sqlite3` + `sqlite-vec` | For one-time auto-migration from old DB format |

### Dependency Summary

```
dependencies:
  @modelcontextprotocol/sdk
  @libsql/client              # primary database driver (async, native vectors)
  @huggingface/transformers   # local ONNX embedding generation
  better-sqlite3              # legacy migration only
  sqlite-vec                  # legacy migration only
  zod                         # schema validation
```

## 3. Data Model

Single libsql file per user: `~/.dude-claude/dude-libsql.db`
(Legacy users are auto-migrated from `~/.dude-claude/dude.db` on first run; the old file is renamed to `dude.db.backup`.)

### 3.1 `project`

| Column      | Type    | Notes                                      |
|-------------|---------|--------------------------------------------|
| id          | INTEGER | PK, autoincrement                          |
| name        | TEXT    | UNIQUE — repo name (git) or absolute path  |
| created_at  | TEXT    | ISO-8601                                   |
| updated_at  | TEXT    | ISO-8601                                   |

### 3.2 `record`

A record is one of four kinds: **issue**, **spec**, **arch**, or **update**.
All share one table to keep queries and embeddings uniform.

| Kind     | Meaning                                                        |
|----------|----------------------------------------------------------------|
| `issue`  | A bug that was fixed                                           |
| `spec`   | A specification or plan (open = planned, resolved = done)      |
| `arch`   | An architectural decision, pattern, or structural change       |
| `update` | A feature implementation or improvement to existing functionality |

| Column      | Type    | Notes                                                       |
|-------------|---------|-------------------------------------------------------------|
| id          | INTEGER | PK, autoincrement                                           |
| project_id  | INTEGER | FK → project.id                                             |
| kind        | TEXT    | `'issue'` / `'spec'` / `'arch'` / `'update'`               |
| title       | TEXT    | Short summary                                               |
| body        | TEXT    | Full description / details                                  |
| status      | TEXT    | `'open'` / `'resolved'` / `'archived'`                      |
| created_at  | TEXT    | ISO-8601                                                    |
| updated_at  | TEXT    | ISO-8601                                                    |

### 3.3 Embeddings

Embeddings are stored as a native `F32_BLOB(384)` column directly on the `record` table (no separate virtual table). A vector index enables KNN search:

```sql
-- Column on record table:
embedding  F32_BLOB(384)

-- Vector index:
CREATE INDEX idx_record_embedding
  ON record(libsql_vector_idx(embedding, 'metric=cosine'));
```

**Insert format:** `vector('[1.0, 2.0, ...]')` — JSON string passed to the `vector()` SQL function.
**Search:** `vector_top_k('idx_record_embedding', vector(?), k)` returns rowid matches; cosine similarity is computed application-side since `embed()` returns L2-normalized vectors (dot product = cosine similarity).

### 3.4 Project Identification

On startup the server determines the current project:
1. Run `git rev-parse --show-toplevel` — if it succeeds, use the **basename** as the project name.
2. Try `git remote get-url origin` — if it succeeds and the URL matches a known host (GitHub, GitLab, Bitbucket), extract `org/repo` as the project name (e.g. `fingerskier/dude-claude-plugin`). Supports both HTTPS and SSH URL formats.
3. If no remote is found, keep the basename from step 1.
4. If not in a git repo at all, use the **working directory path** as the project name.
5. Upsert into `project` table.

## 4. MCP Tools

All tools are exposed under the MCP server name `dude`. Claude sees them as `mcp__dude__<tool>`.

### 4.1 `search`

Semantic search across records.
By default, search includes cross-project results so that learnings from one project can inform another.
Results from the current project are ranked higher; cross-project results appear at lower weight.
Each result includes the originating `project` name/ID for disambiguation.

| Parameter    | Type    | Required | Default | Description                       |
|--------------|---------|----------|---------|-----------------------------------|
| query        | string  | yes      | —       | Natural language search query     |
| kind         | string  | no       | all     | Filter: `'issue'`, `'spec'`, `'arch'`, `'update'`, or `'all'` |
| project      | string  | no       | current | Project name to boost; `'*'` for equal weight across all projects |
| limit        | integer | no       | 5       | Max results returned              |

Returns: array of `{ id, project, kind, title, body, status, similarity }` sorted by descending similarity.
Results with similarity < 0.3 are excluded.
The `project` field defaults to the current project but is always present in the response so callers can distinguish cross-project results.

### 4.2 `upsert_record`

Create or update a record.
If `id` is provided, update; otherwise insert with deduplication (see below).

| Parameter  | Type    | Required | Description              |
|------------|---------|----------|--------------------------|
| id         | integer | no       | Record ID to update      |
| kind       | string  | yes      | `'issue'`, `'spec'`, `'arch'`, or `'update'` |
| title      | string  | yes      | Short summary            |
| body       | string  | no       | Full description         |
| status     | string  | no       | Defaults to `'open'`     |

On upsert the server:
1. Generates an embedding from `title + ' ' + body`.
2. **Deduplication**: If no `id` is provided, query `record_embedding` for existing records in the same project and `kind` whose embedding distance is below a configurable threshold (default cosine distance ≤ 0.15).  If a close match exists, treat the operation as an update of that record instead of creating a duplicate.
3. Writes (insert or update) the record row.
4. Upserts into `record_embedding`.

### 4.3 `get_record`

| Parameter | Type    | Required |
|-----------|---------|----------|
| id        | integer | yes      |

Returns full record fields.

### 4.4 `list_records`

| Parameter | Type    | Required | Default |
|-----------|---------|----------|---------|
| kind      | string  | no       | both    |
| status    | string  | no       | all     |
| project   | string  | no       | current |

Returns array of `{ id, kind, title, status, updated_at }`.

### 4.5 `delete_record`

| Parameter | Type    | Required |
|-----------|---------|----------|
| id        | integer | yes      |

Deletes record and its embedding.

### 4.6 `list_projects`

No parameters. Returns all known projects.

### 4.7 `sync_status`

Check cloud sync status and optionally trigger a manual sync.

| Parameter      | Type    | Required | Default | Description                           |
|----------------|---------|----------|---------|---------------------------------------|
| trigger_sync   | boolean | no       | false   | If true, trigger an immediate sync    |

Returns: `{ enabled, syncUrl?, syncInterval?, sync?: { synced, message } }`

When cloud sync is not configured (`DUDE_TURSO_URL` not set), returns `{ enabled: false }`.
When `trigger_sync` is true and sync is enabled, performs an immediate sync and includes the result.

## 5. Hooks

Hooks are configured in the project or user settings and call into the MCP tools automatically.

### 5.1 Auto-Retrieve (UserPromptSubmit)

When the user submits a prompt, a hook runs `mcp__dude__search` with the user's message as the query.
Results are injected as additional context so Claude has relevant history before it begins reasoning.

**Settings entry:**
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.dude-claude/hooks/auto-retrieve.js"
          }
        ]
      }
    ]
  }
}
```

The hook script:
1. Reads the user prompt from stdin JSON (`tool_input` or equivalent).
2. Queries the SQLite database directly for speed (MCP is not required for hook scripts).
3. If results exist, writes the top **5** results (configurable via `DUDE_CONTEXT_LIMIT` env var or the `contextLimit` key in config) to stdout as context for Claude.

### 5.2 Auto-Persist (Stop)

When Claude finishes responding, a `Stop` hook uses an **agent** to read the session transcript, classify the work, and instruct Claude to persist the record via MCP tools.

**Settings entry:**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "agent",
            "prompt": "Event data: $ARGUMENTS\n\nCheck \"stop_hook_active\". If true, ALLOW (ok: true). Otherwise read the transcript at \"transcript_path\". Classify: bug fix=issue, architecture=arch, feature=update, plan=spec. BLOCK (ok: false) with reason instructing Claude to use dude:upsert_record. If trivial/unclassifiable, ALLOW (ok: true).",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**How it works:**
1. The agent hook spawns a Claude subagent that reads the transcript file.
2. If the work is classifiable, the agent returns `ok: false` with a reason instructing Claude to use `dude:upsert_record` to persist the classification.
3. Claude continues, sees the instruction, and calls the MCP tool to save the record.
4. On the second Stop, `stop_hook_active` is `true` — the agent returns `ok: true` and the session ends.
5. If the work is trivial/unclassifiable, the agent returns `ok: true` immediately (no extra turn).

**Loop prevention:** The `stop_hook_active` field in the event JSON is `true` when the Stop hook was triggered by a hook continuation. The agent checks this first and allows the stop immediately, preventing infinite loops.

### 5.3 Auto-Persist Plan (SubagentStop)

When a Plan subagent finishes, a `SubagentStop` hook (with `"matcher": "Plan"`) reads the plan transcript and instructs Claude to persist it as a spec record.

The flow is the same as the Stop hook: the agent reads the plan transcript, returns `ok: false` with a reason to persist, and Claude calls `dude:upsert_record`.

### 5.4 Classification Logic

The work classification (issue, spec, arch, or update) is determined by the agent hook's Claude subagent reading the actual session transcript — not by heuristics.
The agent classifies the work into one of four kinds:
- **issue**: a bug was fixed
- **spec**: a plan or specification was created (or completed)
- **arch**: an architectural decision, new pattern, or structural reorganization
- **update**: a feature was added or improved

This leverages Claude's understanding of the conversation for accurate classification.

**Fallback behavior**: If the agent cannot read the transcript or determine a classification, it returns `ok: true` and the session ends normally without persisting a record.

## 6. Web UI

A minimal local HTTP server for manual CRUD when Claude CLI isn't running.

| Detail     | Value                                    |
|------------|------------------------------------------|
| Port       | 3456 (configurable via `DUDE_PORT` env)  |
| Start      | `npx dude-claude serve`                  |
| Auth       | None (localhost only, binds 127.0.0.1)   |

### Endpoints

| Method | Path                     | Description               |
|--------|--------------------------|---------------------------|
| GET    | `/`                      | Static HTML SPA           |
| GET    | `/api/projects`          | List projects             |
| GET    | `/api/records?project=&kind=&status=` | List records |
| GET    | `/api/records/:id`       | Get record                |
| POST   | `/api/records`           | Create record             |
| PUT    | `/api/records/:id`       | Update record             |
| DELETE | `/api/records/:id`       | Delete record             |
| POST   | `/api/search`            | Semantic search           |
| GET    | `/api/sync-status`       | Cloud sync status         |
| POST   | `/api/sync`              | Trigger manual sync       |

The SPA is a single `index.html` file served from `web/index.html` using the built-in `http` module. No bundler.

## 7. File Layout

```
dude-claude-plugin/
  package.json
  bin/
    dude-claude.js          # CLI entry point (MCP server + serve command)
  src/
    server.js               # MCP server setup + 7 tool handlers
    db.js                   # Database factory — auto-detects, migrates, returns adapter
    db-adapter.js           # Abstract DbAdapter interface (async)
    db-libsql.js            # LibsqlAdapter — primary backend (@libsql/client)
    db-sqlite-vec.js        # SqliteVecAdapter — legacy backend (for migration)
    embed.js                # Embedding generation (all-MiniLM-L6-v2)
    web.js                  # HTTP server for manual CRUD + sync endpoints
    migrations/
      001-initial.js        # Legacy: creates project, record, record_embedding tables
      002-expand-kinds.js   # Legacy: adds 'arch' and 'update' kinds
  scripts/
    migrate-to-libsql.js    # One-time data migration: sqlite-vec → libsql
  web/
    index.html              # Single-page CRUD UI
  hooks/
    auto-retrieve.js        # UserPromptSubmit hook script
    auto-persist.js         # Stop hook follow-up script
    auto-persist-plan.js    # SubagentStop hook — persist plans as specs
  doc/
    SPEC.md                 # This file
    LIBSQL_PLAN.md          # Migration plan (all phases complete)
  .mcp.json                 # MCP server registration for Claude CLI
```

## 8. Schema & Database Migration

### 8.1 libsql Schema (current)

The libsql backend (`src/db-libsql.js`) creates the schema on first run via `_runSchema()`. Tables are created with `IF NOT EXISTS`, so the schema is idempotent. No versioned migrations are needed — the schema is defined inline.

### 8.2 Legacy Migration (sqlite-vec → libsql)

On startup, `src/db.js` detects whether a legacy `dude.db` exists:
1. If `dude.db` exists and `dude-libsql.db` does not: auto-migrate via `scripts/migrate-to-libsql.js`.
2. Rename `dude.db` to `dude.db.backup` after successful migration.
3. Always return `LibsqlAdapter` pointing to `dude-libsql.db`.

The migration script handles:
- Project table preservation (including IDs)
- Record migration with embedding round-trip (`Float32Array` → JSON → `vector()`)
- Orphaned records (missing embeddings)
- Empty databases

### 8.3 Legacy Schema Migrations (historical)

The old `better-sqlite3` backend used versioned migration scripts in `src/migrations/`:
- `001-initial.js` — project, record, record_embedding tables
- `002-expand-kinds.js` — added 'arch' and 'update' kinds

These are retained for legacy migration support but are not used by the libsql backend.

## 9. Cloud Sync (optional)

The plugin is local-first by default. When Turso environment variables are set, `@libsql/client` maintains a local embedded replica that auto-syncs with a Turso cloud database.

| Env variable | Description |
|---|---|
| `DUDE_TURSO_URL` | Turso database URL (e.g. `libsql://your-db.turso.io`) |
| `DUDE_TURSO_TOKEN` | Turso auth token |
| `DUDE_SYNC_INTERVAL` | Auto-sync interval in ms (default: `60000`) |

**Behavior:**
- Without env vars: fully offline, no cloud dependency.
- With env vars: local DB syncs bidirectionally with Turso on the configured interval.
- Manual sync available via `sync_status` MCP tool (`trigger_sync: true`) or `POST /api/sync`.
- Sync status visible via `sync_status` MCP tool or `GET /api/sync-status`.
- On startup, the log line includes the sync URL when configured.

## 10. Configuration

### `.mcp.json` (project-scoped, committed)

```json
{
  "mcpServers": {
    "dude": {
      "command": "node",
      "args": ["bin/dude-claude.js", "mcp"]
    }
  }
}
```

### User-global install

```bash
claude mcp add --transport stdio dude -- node /path/to/dude-claude-plugin/bin/dude-claude.js mcp
```
