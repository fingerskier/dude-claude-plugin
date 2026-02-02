# Dude Claude Plugin
A context multiplier plug-in for Claude CLI

## Install

### As a plugin (recommended)

```bash
git clone https://github.com/fingerskier/dude-claude-plugin
cd dude-claude-plugin
npm install
claude --plugin-dir /path/to/dude-claude-plugin
```

This registers the MCP server and hooks (auto-retrieve on prompt, auto-persist on stop).

### MCP server only (via npx)

If you just want the MCP tools without hooks:

```bash
claude mcp add dude -- npx dude-claude-plugin mcp
```

### Optional: Web UI

```bash
npm run serve
```

## Features

* Local sqlite database~ auto-create
* Save records for each project
  * by repo name (for Git)
  * by path (for non-Git)
* Each record gets a vector embedding
* Prior to a think
  * retrieve relevant records from db via semantic search
* After each think
  * If it's a fix upsert associated `issue`record(s)
  * if it's an improvement upsert associated `specification` record(s)
* Tools for Claude
  * search ~ semantic vector search
  * CRUD project
  * CRUD issue ~ per project
  * CRID specification ~ per project
* Local webserver to do manual CRUD
