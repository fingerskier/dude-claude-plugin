export const version = 2;

export function up(db) {
  // SQLite doesn't support ALTER TABLE to change CHECK constraints.
  // Recreate the record table with the expanded kind set.
  db.exec(`
    CREATE TABLE record_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL CHECK (kind IN ('issue', 'spec', 'arch', 'update')),
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL DEFAULT '',
      status     TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO record_new SELECT * FROM record;

    DROP TABLE record;

    ALTER TABLE record_new RENAME TO record;

    CREATE INDEX idx_record_project_kind ON record(project_id, kind);
  `);
}
