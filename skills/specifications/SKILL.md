---
name: specifications
description: "Document specifications using the dude MCP server. List, create, update specifications. Record requirements, architecture decisions, API contracts, design patterns. Search for specs. Use when documenting requirements, recording architecture decisions, writing API specs, capturing design patterns, or managing technical documentation."
---

# Dude Specifications - Technical Documentation

Document requirements and architecture via the `dude:` MCP tools.

Specs and architecture decisions are stored as records with kind `"spec"` or `"arch"`.

## Quick Start

```
dude:list_records { "kind": "spec" }              - List specifications
dude:list_records { "kind": "arch" }              - List architecture decisions
dude:upsert_record { "kind": "spec", "title": "API: POST /users ..." }  - Create spec
dude:search { "query": "...", "kind": "spec" }    - Find specs
```

## Specification Operations

### Listing Specifications
```
dude:list_records { "kind": "spec" }
dude:list_records { "kind": "arch" }
dude:list_records { "kind": "spec", "status": "open" }
```

**Parameters:**
- `kind` — `"spec"` for specifications, `"arch"` for architecture decisions
- `status` (optional) — `"open"`, `"resolved"`, `"archived"`, or `"all"`
- `project` (optional) — project name, or `"*"` for all projects

### Getting Specification Details
```
dude:get_record { "id": 42 }
```

**Parameters:**
- `id` (required): Record ID (integer)

### Creating Specifications
```
dude:upsert_record {
  "kind": "spec",
  "title": "AUTH: JWT tokens with 24h expiry",
  "body": "Refresh handled in authMiddleware.js. Tokens are RS256 signed."
}

dude:upsert_record {
  "kind": "arch",
  "title": "ARCH: Use libsql for local+cloud hybrid storage",
  "body": "Local SQLite file with optional Turso cloud sync."
}
```

**Parameters:**
- `kind` (required): `"spec"` or `"arch"`
- `title` (required): Short summary (use prefixes below)
- `body` (optional): Full description
- `status` (optional): Defaults to `"open"`

### Updating Specifications
Provide the `id` of an existing record to update it:
```
dude:upsert_record {
  "id": 42,
  "kind": "spec",
  "title": "AUTH: JWT tokens with 1h expiry (changed from 24h)",
  "body": "Updated based on security review..."
}
```

### Archiving Specifications
Set status to `"archived"` to mark as deprecated:
```
dude:upsert_record { "id": 42, "kind": "spec", "title": "...", "status": "archived" }
```

### Deleting Specifications
```
dude:delete_record { "id": 42 }
```

## Search for Specifications

### Semantic Search
```
dude:search {
  "query": "authentication flow JWT tokens",
  "kind": "spec",
  "project": "my-org/my-repo",
  "limit": 10
}
```

**Parameters:**
- `query` (required): Natural language search query
- `kind` (optional): `"spec"` or `"arch"` to filter results
- `project` (optional): Project name to boost, or `"*"` for equal weight
- `limit` (optional): Max results (default 5)

## Specification Conventions

Use prefixes to categorize:
- `AUTH:` - Authentication/authorization
- `API:` - API contracts
- `ARCH:` - Architecture decisions
- `DATA:` - Data models/schemas
- `UI:` - User interface patterns

## Related Skills

- **dude:projects** — List and explore projects
- **dude:issues** — Track bugs and tasks
