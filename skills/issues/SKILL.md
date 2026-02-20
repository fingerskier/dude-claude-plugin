---
name: issues
description: "Track and manage issues using the dude MCP server. List, create, update issues. Track bugs, tasks, blockers, and problems within projects. Search for issues. Use when tracking bugs, creating tasks, managing blockers, recording problems, or working with issue hierarchies."
---

# Dude Issues - Issue Tracking

Track bugs, tasks, and blockers via the `dude:` MCP tools.

## Quick Start

```
dude:list_records { "kind": "issue" }         - List all issues
dude:upsert_record { "kind": "issue", "title": "BUG: ..." }  - Create issue
dude:search { "query": "...", "kind": "issue" }               - Find issues
```

## Issue Operations

### Listing Issues
```
dude:list_records { "kind": "issue" }
dude:list_records { "kind": "issue", "status": "open" }
dude:list_records { "kind": "issue", "project": "my-org/my-repo" }
```

**Parameters:**
- `kind` — set to `"issue"` to filter to issues only
- `status` (optional) — `"open"`, `"resolved"`, `"archived"`, or `"all"`
- `project` (optional) — project name, or `"*"` for all projects

### Getting Issue Details
```
dude:get_record { "id": 42 }
```

**Parameters:**
- `id` (required): Record ID (integer)

### Creating Issues
```
dude:upsert_record {
  "kind": "issue",
  "title": "BUG: Load cell readings drift after 2 hours",
  "body": "Detailed description of the problem..."
}
```

**Parameters:**
- `kind` (required): `"issue"`
- `title` (required): Short summary (use prefixes below)
- `body` (optional): Full description
- `status` (optional): Defaults to `"open"`

### Updating Issues
Provide the `id` of an existing record to update it:
```
dude:upsert_record {
  "id": 42,
  "kind": "issue",
  "title": "BUG: Load cell readings drift after 2 hours - found root cause",
  "status": "resolved"
}
```

### Completing Issues
Set status to `"resolved"`:
```
dude:upsert_record { "id": 42, "kind": "issue", "title": "...", "status": "resolved" }
```

To reopen:
```
dude:upsert_record { "id": 42, "kind": "issue", "title": "...", "status": "open" }
```

### Deleting Issues
```
dude:delete_record { "id": 42 }
```

## Search for Issues

### Semantic Search
```
dude:search {
  "query": "memory leak in worker thread",
  "kind": "issue",
  "project": "my-org/my-repo",
  "limit": 10
}
```

**Parameters:**
- `query` (required): Natural language search query
- `kind` (optional): Set to `"issue"` to filter results
- `project` (optional): Project name to boost, or `"*"` for equal weight
- `limit` (optional): Max results (default 5)

## Issue Conventions

Use prefixes to categorize issues:
- `BUG:` - Defects and errors
- `TASK:` - Work items
- `BLOCKER:` - Critical blockers
- `QUESTION:` - Unknowns needing resolution

## Related Skills

- **dude:projects** — List and explore projects
- **dude:specifications** — Document requirements and architecture
