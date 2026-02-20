---
name: projects
description: "Manage development projects using the dude MCP server. List projects, view records by project, search across projects. Projects are auto-detected from git — no manual creation needed. Use when exploring project organization, starting work on a codebase, or needing project-level context."
---

# Dude Projects - Project Management

Explore development projects via the `dude:` MCP tools.

Projects are **auto-detected** from the git repository (remote origin or directory name). There is no need to manually create projects — they are created automatically when records are added.

## Quick Start

```
dude:list_projects                                - List all known projects
dude:list_records { "project": "org/repo" }       - Records for a project
dude:search { "query": "...", "project": "org/repo" }  - Search with project boost
```

## Project Operations

### Listing Projects
```
dude:list_projects
```

Returns all known projects with their IDs, names, and timestamps.

### Viewing Project Records
```
dude:list_records { "project": "my-org/my-repo" }
dude:list_records { "project": "my-org/my-repo", "kind": "issue", "status": "open" }
dude:list_records { "project": "*" }
```

**Parameters:**
- `project` — project name (e.g. `"fingerskier/dude-claude-plugin"`), or `"*"` for all projects
- `kind` (optional) — `"issue"`, `"spec"`, `"arch"`, `"update"`, `"test"`, or `"all"`
- `status` (optional) — `"open"`, `"resolved"`, `"archived"`, `"active"`, `"inactive"`, or `"all"`

### Searching Within a Project
```
dude:search {
  "query": "authentication flow",
  "project": "my-org/my-repo",
  "limit": 10
}
```

The `project` parameter boosts results from that project in similarity ranking.

## How Projects Work

- **Auto-detection**: When the MCP server starts, it detects the project from `git remote get-url origin` (falls back to the directory basename)
- **Format**: Projects are named like `org/repo` (e.g. `fingerskier/dude-claude-plugin`)
- **Current project**: Records are automatically associated with the current project when created
- **Cross-project**: Use `project: "*"` to list/search across all projects

## Common Workflows

### Starting Work on a Codebase
1. `dude:list_projects` — See what's tracked
2. `dude:list_records { "kind": "issue", "status": "open" }` — Open issues for current project
3. `dude:list_records { "kind": "spec" }` — Existing specifications

### Exploring Across Projects
```
dude:list_records { "project": "*", "kind": "arch" }
dude:search { "query": "database migration", "project": "*" }
```

## Related Skills

- **dude:issues** — Create and manage issues within projects
- **dude:specifications** — Create and manage specifications within projects
