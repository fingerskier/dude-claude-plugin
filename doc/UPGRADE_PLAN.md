# dude-claude-plugin: Freeform Kind & Accurate Status Updates

## Problem

The current hook system produces low-quality records in three ways:

1. **Rigid `kind` enum** — The 5-value enum (`issue`, `spec`, `arch`, `update`, `test`) doesn't map well to real work.  Agents shoehorn everything into the closest match, producing meaningless labels.  A bugfix gets called `issue`, a feature gets called both `spec` (when planned) and `update` (when done), and `arch`/`test` are rarely used correctly.

2. **Duplicate records for the same work** — The Stop hook always creates a *new* record.  It never searches for an existing open record to update.  A single feature ends up as a `spec` (open) + an `update` (resolved), with nearly identical titles.  Specs are left permanently open even after the work is done.

3. **Kind-constrained dedup** — The vector dedup in `upsert()` filters by `project_id AND kind`, so a record created as `spec` won't match when the agent later tries to close it as `update`.  This defeats the dedup mechanism for exactly the case where it matters most.

### Evidence

From the `fingerskier/agendabot` project (35 records):

- "Stream Pre-Command Output" appears as 2 `spec` records + 2 `update` records (4 records for 1 feature)
- "Fix NOT NULL constraint" exists as both an `issue` (resolved) and a `spec` (open)
- 12 of 14 `spec` records are still `open` despite their corresponding work being `resolved`
- The `spec`→`update` pattern is mechanical, not meaningful

---

## Changes

### A. `src/server.js` — Make `kind` a freeform string

**File:** `src/server.js`
**Lines:** 21, 45, 99

Replace the `z.enum()` constraints with `z.string()` throughout. The tool descriptions should guide agents toward good labels without enforcing a fixed list.

#### `search` tool (line 21)

```js
// BEFORE
kind: z.enum(['issue', 'spec', 'arch', 'update', 'test', 'all']).optional()
  .describe('Filter by record kind'),

// AFTER
kind: z.string().optional()
  .describe('Filter by record kind (freeform string, e.g. "bugfix", "feature", "plan")'),
```

#### `upsert_record` tool (line 45)

```js
// BEFORE
kind: z.enum(['issue', 'spec', 'arch', 'update', 'test'])
  .describe('Record kind: issue (bug), spec (plan), arch (architecture decision), update (feature change), test (verification procedure)'),

// AFTER
kind: z.string()
  .describe(
    'Single-word label for this record (e.g. bugfix, feature, refactor, ' +
    'investigation, config, docs, plan, test, migration, cleanup). ' +
    'Use whatever word best describes the work — there is no fixed list.'
  ),
```

#### `list_records` tool (line 99)

```js
// BEFORE
kind: z.enum(['issue', 'spec', 'arch', 'update', 'test', 'all']).optional()
  .describe('Filter by kind'),

// AFTER
kind: z.string().optional()
  .describe('Filter by kind (freeform string, or omit for all)'),
```

---

### B. `hooks.json` — Rewrite the Stop hook prompt

**File:** `hooks.json`
**Lines:** 26–36 (the `Stop` hook entry)

The new prompt instructs the agent to:
1. Search for existing open records before creating new ones
2. Update (with `id=`) when a match is found
3. Use a freeform single-word kind
4. Set status accurately

```json
{
  "type": "agent",
  "prompt": "Event data: $ARGUMENTS\n\nCheck the \"stop_hook_active\" field. If it is true, return decision: ALLOW (ok: true). Do not read any files.\n\nOtherwise, read the transcript file at the \"transcript_path\" path from the event data. Read the last 200 lines to understand what work was done.\n\nDecide if this work is worth recording. Trivial Q&A, chat, or clarifications are NOT worth recording — ALLOW the stop (ok: true).\n\nIf the work IS worth recording:\n\n1. First, use dude:search to check if there is an existing open record that this work completes or updates. Search with keywords from the work done.\n\n2. If you find a matching open record, BLOCK the stop (ok: false) with reason:\n\"Please use the dude:upsert_record tool to UPDATE the existing record: id=<existing_id>, kind=<single word label>, title=<updated title>, body=<summary of what was done>, status=resolved. After saving, briefly confirm what was persisted.\"\n\n3. If no matching record exists, BLOCK the stop (ok: false) with reason:\n\"Please use the dude:upsert_record tool to save this work: kind=<single word label>, title=<concise title>, body=<brief summary>, status=<open if planned but not done, resolved if completed>. After saving, briefly confirm what was persisted.\"\n\nFor the kind, choose a single lowercase word that best describes the work (e.g. bugfix, feature, refactor, config, docs, investigation, migration, cleanup, test, plan). Do not use generic words — be specific about what the work actually was.",
  "timeout": 120
}
```

---

### C. `hooks.json` — Rewrite the SubagentStop hook prompt

**File:** `hooks.json`
**Lines:** 14–25 (the `SubagentStop` hook entry)

Same pattern: search before creating, use freeform kind.

```json
{
  "matcher": "Plan",
  "hooks": [
    {
      "type": "agent",
      "prompt": "Event data: $ARGUMENTS\n\nA Plan subagent has finished. Read the plan transcript at the \"agent_transcript_path\" path from the event data. Read the last 200 lines to understand the plan.\n\nFirst use dude:search to check if a record for this plan already exists.\n\nIf a matching record exists, BLOCK the stop (ok: false) with reason:\n\"Please use the dude:upsert_record tool to UPDATE the existing plan: id=<existing_id>, kind=plan, title=<plan title>, body=<plan details and steps>, status=open. After saving, briefly confirm what was persisted.\"\n\nIf no match, BLOCK the stop (ok: false) with reason:\n\"Please use the dude:upsert_record tool to save this plan: kind=plan, title=<plan title>, body=<plan details and steps>, status=open. After saving, briefly confirm what was persisted.\"\n\nIf you cannot read the transcript or extract a meaningful plan, ALLOW the stop (ok: true).",
      "timeout": 120
    }
  ]
}
```

---

### D. `src/db-libsql.js` — Relax dedup to be kind-agnostic

**File:** `src/db-libsql.js`
**Lines:** 384–393 (inside `upsert()`)

The dedup check currently filters by `project_id AND kind`.  This means a `plan` record won't match when the agent later tries to close it as `feature`.  Remove the kind constraint so vector similarity alone handles matching.

```js
// BEFORE (lines 386-393)
const candidates = await this.db.execute({
  sql: `SELECT r.id, r.embedding
        FROM vector_top_k('idx_record_embedding', vector(?), 5) AS v
        JOIN record r ON r.rowid = v.id
        WHERE r.project_id = ? AND r.kind = ?`,
  args: [embJson, proj, kind],
});

// AFTER
const candidates = await this.db.execute({
  sql: `SELECT r.id, r.kind, r.embedding
        FROM vector_top_k('idx_record_embedding', vector(?), 5) AS v
        JOIN record r ON r.rowid = v.id
        WHERE r.project_id = ?`,
  args: [embJson, proj],
});
```

The 0.85 similarity threshold is sufficient to prevent false matches across unrelated records.  When a match is found, the kind naturally evolves with the work (e.g. `plan` → `feature`).

---

### E. Remove dead code

**Files to delete:**
- `hooks/auto-persist.js`
- `hooks/auto-persist-plan.js`

These were the original `type: "command"` hook handlers from an earlier architecture where the Stop hook piped classification JSON through stdin.  The current `hooks.json` uses `type: "agent"` hooks that instruct Claude to call `dude:upsert_record` via MCP directly — these scripts are never invoked.

The `hooks/auto-retrieve.js` file is still active (used by the `UserPromptSubmit` hook) and should be kept.

---

### F. Update skill files

**Files:** `skills/issues/SKILL.md`, `skills/specifications/SKILL.md`

These skills reference the old enum-based kinds.  Update them to reflect the freeform kind model, mentioning that agents should use descriptive single-word labels rather than choosing from a fixed list.

---

## Migration Notes

- **No schema migration needed.**  The `record.kind` column is already `TEXT NOT NULL` with no CHECK constraint (the CHECK was removed in a previous migration via `_migrateDropChecks()`).  Existing records with old kinds (`issue`, `spec`, etc.) will continue to work — they just won't be the only kinds going forward.

- **Existing records are unaffected.**  The freeform kind is additive.  Old `issue` and `spec` records remain valid and searchable.  Over time, new records will use more descriptive kinds.

- **The `auto-retrieve.js` hook is unchanged.**  It queries by vector similarity, not by kind, so it works with any kind value.

- **Windows users:**  Consider adding `"async": true` to the Stop and SubagentStop hook handlers.  Synchronous agent hooks can hang on Windows due to how Node.js handles subprocess polling.  The hooks don't return permission decisions, so async execution is safe.

---

## Expected Outcomes

| Before | After |
|--------|-------|
| 4 records for 1 feature (spec + spec + update + update) | 1 record, updated as work progresses |
| Specs left permanently open | Matching spec found and resolved when work completes |
| `kind=issue` for everything from bugfixes to config changes | `kind=bugfix`, `kind=config`, `kind=migration`, etc. |
| Dedup fails across kind boundaries | Dedup works regardless of kind evolution |
| Dead hook scripts in `hooks/` | Clean codebase, only active code |

---

## Implementation Order

1. **`src/server.js`** — change Zod enums to strings (backward compatible, no data change)
2. **`src/db-libsql.js`** — remove kind filter from dedup (backward compatible)
3. **`hooks.json`** — deploy new Stop and SubagentStop prompts
4. **Delete** `hooks/auto-persist.js` and `hooks/auto-persist-plan.js`
5. **Update** skill files (optional)
6. **Publish** new version to npm