# dude-claude-plugin

[![npm version](https://img.shields.io/npm/v/dude-claude-plugin.svg)](https://www.npmjs.com/package/dude-claude-plugin)
[![license](https://img.shields.io/npm/l/dude-claude-plugin.svg)](./LICENSE)

Ultra-minimal RAG and cross-project memory for Claude Code.

Dude gives Claude a persistent memory across projects. It stores issues and specifications in a local SQLite database with vector embeddings, so Claude automatically recalls relevant context from past sessions.

## Install

### From marketplace (recommended)

Installs MCP tools **and** hooks (auto-retrieve on prompt, auto-persist on stop):

```bash
claude plugin marketplace add fingerskier/claude-plugins
claude plugin install dude-claude-plugin@fingerskier-plugins
```

### MCP server only (via npx)

If you just want the 6 MCP tools without auto-hooks:

```bash
claude mcp add dude -- npx dude-claude-plugin mcp
```

### Global install

```bash
npm install -g dude-claude-plugin
claude mcp add dude -- dude-claude mcp
```

## What it does

| Component | Description |
|-----------|-------------|
| **MCP server** | 6 tools: `search`, `upsert_record`, `get_record`, `list_records`, `delete_record`, `list_projects` |
| **Auto-retrieve hook** | On each prompt, searches memory for relevant context and injects it |
| **Auto-persist hook** | After each response, classifies the work and saves issues/specs |
| **Web UI** | Local dashboard at `http://127.0.0.1:3456` for manual CRUD |
| **Storage** | SQLite + sqlite-vec at `~/.dude-claude/dude.db` |
| **Embeddings** | Local all-MiniLM-L6-v2 via @huggingface/transformers (no API keys) |

## How it works

1. You submit a prompt -- the auto-retrieve hook embeds it and searches for related records across all your projects
2. Matching context is injected so Claude has relevant history before reasoning
3. After Claude responds, the auto-persist hook classifies the work:
   - Bug fix? Upserts an `issue` record (status: resolved)
   - Improvement? Upserts a `spec` record
   - Neither? Skips silently
4. Next session, step 1 finds those records automatically

## Web UI

```bash
npx dude-claude-plugin serve
# or if globally installed:
dude-claude serve
```

Opens a local dashboard on port 3456 for browsing and editing projects, issues, and specifications.

## Configuration

| Env variable | Default | Description |
|---|---|---|
| `DUDE_PORT` | `3456` | Web UI port |
| `DUDE_CONTEXT_LIMIT` | `5` | Max records injected per prompt |

## Requirements

- Node.js >= 18

## License

[MIT](./LICENSE)
