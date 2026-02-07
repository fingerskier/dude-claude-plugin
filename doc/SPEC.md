# Dude Claude Plugin — Implementation Specification

Ultra-minimal RAG and cross-project memory for Claude CLI.

## 1. Architecture Overview

The plugin is an **MCP (Model Context Protocol) stdio server** written in Node.js.
Claude CLI launches it as a subprocess and communicates via JSON-RPC 2.0 over stdin/stdout.

Companion **hooks** (configured in `.claude/settings.json`) fire at session boundaries to automatically inject retrieved context and persist learnings without explicit tool calls.

```
Claude CLI
  ├── MCP stdio server  (tools: search, CRUD)
  │     └── SQLite + vec0 extension
  └── Hooks
        ├── PreToolUse   → auto-retrieve relevant records
        └── Stop         → auto-upsert issue/spec records
```

## 2. Technology Stack

| Component       | Choice                | Rationale                              |
|-----------------|-----------------------|----------------------------------------|
| Runtime         | Node.js >=18          | Claude CLI ecosystem is JS/TS-centric  |
| Language        | Plain JavaScript (ESM)| Zero build step; ultra-minimal goal    |
| Database        | better-sqlite3        | Synchronous, zero-config, single-file  |
| Vector search   | sqlite-vec (vec0)     | SQLite extension; no external service  |
| Embeddings      | Local: all-MiniLM-L6-v2 via `@huggingface/transformers` | Offline, fast, 384-dim |
| MCP SDK         | `@modelcontextprotocol/sdk` | Official MCP server library   |
| Web UI          | Bare `http` module + static HTML | No framework; minimal       |

### Dependency Summary

```
dependencies:
  @modelcontextprotocol/sdk
  better-sqlite3
  sqlite-vec
  @huggingface/transformers   # local ONNX embedding generation
```

## 3. Data Model

Single SQLite file per user: `~/.dude-claude/dude.db`

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

### 3.3 `record_embedding` (virtual — vec0)

| Column      | Type         | Notes                          |
|-------------|--------------|--------------------------------|
| record_id   | INTEGER      | FK → record.id                 |
| embedding   | FLOAT[384]   | all-MiniLM-L6-v2 output        |

Created via:
```sql
CREATE VIRTUAL TABLE record_embedding USING vec0(
  record_id INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);
```

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

When Claude finishes responding, a `Stop` hook evaluates whether the conversation involved a fix or improvement and upserts records accordingly.

**Settings entry:**
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Review the conversation. Bug fix: kind=issue. Architectural change: kind=arch. Feature update/improvement: kind=update. New plan/spec: kind=spec. Output JSON: {\"action\":\"upsert\",\"kind\":\"...\",\"title\":\"...\",\"body\":\"...\",\"status\":\"resolved\"}. If none apply: {\"action\":\"none\"}.",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

A follow-up command hook parses this output and calls `mcp__dude__upsert_record`.

**Fallback behavior**: If the model returns malformed JSON or declines to classify, the hook silently skips the upsert (no data loss, no user-facing error) **and** emits a tool-result message to Claude's worklog noting that the auto-persist step was skipped and why (e.g., "Auto-persist skipped: malformed JSON from classification prompt").

### 5.3 Classification Logic

The work classification (issue, spec, arch, or update) is determined by the Stop hook's LLM prompt evaluation — not by heuristics.
The prompt asks Claude to classify the work into one of four kinds:
- **issue**: a bug was fixed
- **spec**: a plan or specification was created (or completed)
- **arch**: an architectural decision, new pattern, or structural reorganization
- **update**: a feature was added or improved

This keeps the logic simple and leverages the model's understanding of the conversation.

The same fallback applies here: if classification fails, the hook skips silently and logs a worklog message.

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

The SPA is a single `index.html` file served from `web/index.html` using the built-in `http` module. No bundler.

## 7. File Layout

```
dude-claude-plugin/
  package.json
  bin/
    dude-claude.js          # CLI entry point (MCP server + serve command)
  src/
    server.js               # MCP server setup + tool handlers
    db.js                   # SQLite schema init, migration runner, query helpers
    embed.js                # Embedding generation
    web.js                  # HTTP server for manual CRUD
    migrations/
      001-initial.js        # Creates project, record, record_embedding tables
  web/
    index.html              # Single-page CRUD UI
  hooks/
    auto-retrieve.js        # UserPromptSubmit hook script
    auto-persist.js         # Stop hook follow-up script
  doc/
    SPEC.md                 # This file
  .mcp.json                 # MCP server registration for Claude CLI
```

## 8. Schema Migration

Schema changes are handled via **versioned migration scripts** stored in `src/migrations/` (e.g., `001-initial.js`, `002-add-index.js`).

On startup, `db.js`:
1. Ensures a `schema_version` table exists (`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`).
2. Reads the current version (or 0 if the table is empty).
3. Runs any migration scripts with a version number greater than the current version, in order.
4. Updates `schema_version` to the latest version after all pending migrations succeed.

Migrations run inside a transaction so a failed migration leaves the database unchanged.

### File Layout Addition

```
src/
  migrations/
    001-initial.js        # Creates project, record, record_embedding tables
    002-...               # Future schema changes
```

## 9. Configuration

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
