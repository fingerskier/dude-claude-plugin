export const version = 3;

export function up(db) {
  // Remove CHECK constraints from the record table.
  // Constraints are now enforced at the business logic layer (Zod validation).
  // This also enables new kinds (e.g. 'test') and statuses (e.g. 'active', 'inactive')
  // without requiring further schema migrations.
  db.exec(`
    CREATE TABLE record_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL,
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL DEFAULT '',
      status     TEXT    NOT NULL DEFAULT 'open',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO record_new SELECT * FROM record;

    DROP TABLE record;

    ALTER TABLE record_new RENAME TO record;

    CREATE INDEX idx_record_project_kind ON record(project_id, kind);
  `);
}
