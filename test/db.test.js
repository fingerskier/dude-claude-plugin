import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, insertProject, fakeEmbedding, seededEmbedding, embeddingBuffer } from './helpers.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testHome = mkdtempSync(join(tmpdir(), 'dude-test-'));

// Mock child_process so detectProject() doesn't shell out
vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd) => {
    if (cmd === 'git rev-parse --show-toplevel') return '/home/user/test-project\n';
    if (cmd === 'git remote get-url origin') return 'https://github.com/testorg/test-project.git\n';
    throw new Error('Unknown command');
  }),
}));

// Mock os.homedir to use a temp dir (preserve other exports)
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    homedir: () => testHome,
  };
});

describe('db.js', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;
  /** @type {object} */
  let project;

  // For direct DB testing without module-level state, we use the test helper DB
  beforeEach(() => {
    db = createTestDb();
    project = insertProject(db, 'testorg/test-project');
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // Project operations
  // -----------------------------------------------------------------------

  describe('project operations', () => {
    it('should create a project', () => {
      expect(project).toBeDefined();
      expect(project.name).toBe('testorg/test-project');
      expect(project.id).toBeGreaterThan(0);
    });

    it('should upsert existing project (update timestamp)', () => {
      const again = insertProject(db, 'testorg/test-project');
      expect(again.id).toBe(project.id);
    });

    it('should create multiple projects', () => {
      const p2 = insertProject(db, 'other-project');
      expect(p2.id).not.toBe(project.id);
      const all = db.prepare('SELECT * FROM project ORDER BY name').all();
      expect(all).toHaveLength(2);
    });

    it('should list projects', () => {
      insertProject(db, 'alpha');
      insertProject(db, 'beta');
      const projects = db.prepare('SELECT id, name, created_at, updated_at FROM project ORDER BY name').all();
      expect(projects.length).toBeGreaterThanOrEqual(3);
      expect(projects.map(p => p.name)).toContain('alpha');
      expect(projects.map(p => p.name)).toContain('beta');
    });
  });

  // -----------------------------------------------------------------------
  // Record CRUD
  // -----------------------------------------------------------------------

  describe('record CRUD', () => {
    function insertRecord(fields, embedding) {
      const { projectId, kind, title, body = '', status = 'open' } = fields;
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, kind, title, body, status, now, now);

      const newId = result.lastInsertRowid;
      db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(
        BigInt(newId),
        embeddingBuffer(embedding),
      );

      return db.prepare(`
        SELECT r.*, p.name AS project
        FROM record r JOIN project p ON r.project_id = p.id
        WHERE r.id = ?
      `).get(Number(newId));
    }

    it('should insert a record', () => {
      const emb = fakeEmbedding();
      const record = insertRecord(
        { projectId: project.id, kind: 'issue', title: 'Test Bug', body: 'Something broke' },
        emb,
      );
      expect(record).toBeDefined();
      expect(record.title).toBe('Test Bug');
      expect(record.kind).toBe('issue');
      expect(record.status).toBe('open');
      expect(record.project).toBe('testorg/test-project');
    });

    it('should get a record by ID', () => {
      const emb = fakeEmbedding();
      const created = insertRecord(
        { projectId: project.id, kind: 'spec', title: 'Auth Spec' },
        emb,
      );
      const fetched = db.prepare(`
        SELECT r.*, p.name AS project
        FROM record r JOIN project p ON r.project_id = p.id
        WHERE r.id = ?
      `).get(created.id);
      expect(fetched).toBeDefined();
      expect(fetched.title).toBe('Auth Spec');
    });

    it('should return undefined for non-existent record', () => {
      const row = db.prepare(`
        SELECT r.*, p.name AS project
        FROM record r JOIN project p ON r.project_id = p.id
        WHERE r.id = ?
      `).get(99999);
      expect(row).toBeUndefined();
    });

    it('should update a record', () => {
      const emb = fakeEmbedding();
      const created = insertRecord(
        { projectId: project.id, kind: 'issue', title: 'Old Title', body: 'Old body' },
        emb,
      );

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE record SET title = ?, body = ?, status = ?, updated_at = ?
        WHERE id = ?
      `).run('New Title', 'New body', 'resolved', now, created.id);

      const updated = db.prepare('SELECT * FROM record WHERE id = ?').get(created.id);
      expect(updated.title).toBe('New Title');
      expect(updated.body).toBe('New body');
      expect(updated.status).toBe('resolved');
    });

    it('should delete a record and its embedding', () => {
      const emb = fakeEmbedding();
      const created = insertRecord(
        { projectId: project.id, kind: 'issue', title: 'To Delete' },
        emb,
      );

      db.prepare('DELETE FROM record_embedding WHERE record_id = ?').run(created.id);
      const result = db.prepare('DELETE FROM record WHERE id = ?').run(created.id);
      expect(result.changes).toBe(1);

      const gone = db.prepare('SELECT * FROM record WHERE id = ?').get(created.id);
      expect(gone).toBeUndefined();
    });

    it('should return 0 changes when deleting non-existent record', () => {
      const result = db.prepare('DELETE FROM record WHERE id = ?').run(99999);
      expect(result.changes).toBe(0);
    });

    it('should accept any kind value (no CHECK constraint)', () => {
      // Constraints are enforced at the business logic layer, not the DB
      expect(() => {
        db.prepare(`
          INSERT INTO record (project_id, kind, title, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(project.id, 'custom_kind', 'Test', 'open');
      }).not.toThrow();
    });

    it('should accept any status value (no CHECK constraint)', () => {
      // Constraints are enforced at the business logic layer, not the DB
      expect(() => {
        db.prepare(`
          INSERT INTO record (project_id, kind, title, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
        `).run(project.id, 'issue', 'Test', 'custom_status');
      }).not.toThrow();
    });

    it('should support all valid kinds: issue, spec, arch, update, test', () => {
      for (const kind of ['issue', 'spec', 'arch', 'update', 'test']) {
        const emb = fakeEmbedding();
        const record = insertRecord(
          { projectId: project.id, kind, title: `${kind} record` },
          emb,
        );
        expect(record.kind).toBe(kind);
      }
    });

    it('should support all valid statuses: open, resolved, archived, active, inactive', () => {
      for (const status of ['open', 'resolved', 'archived', 'active', 'inactive']) {
        const emb = fakeEmbedding();
        const record = insertRecord(
          { projectId: project.id, kind: 'issue', title: `${status} record`, status },
          emb,
        );
        expect(record.status).toBe(status);
      }
    });
  });

  // -----------------------------------------------------------------------
  // List records with filters
  // -----------------------------------------------------------------------

  describe('listRecords filtering', () => {
    function insertSimple(kind, title, status = 'open') {
      const emb = fakeEmbedding();
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, ?, ?, '', ?, ?, ?)
      `).run(project.id, kind, title, status, now, now);
      const newId = result.lastInsertRowid;
      db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(
        BigInt(newId), embeddingBuffer(emb),
      );
    }

    it('should filter records by kind', () => {
      insertSimple('issue', 'Bug A');
      insertSimple('spec', 'Spec A');
      insertSimple('issue', 'Bug B');

      const issues = db.prepare(`
        SELECT * FROM record WHERE project_id = ? AND kind = ?
      `).all(project.id, 'issue');
      expect(issues).toHaveLength(2);

      const specs = db.prepare(`
        SELECT * FROM record WHERE project_id = ? AND kind = ?
      `).all(project.id, 'spec');
      expect(specs).toHaveLength(1);
    });

    it('should filter records by status', () => {
      insertSimple('issue', 'Open Issue', 'open');
      insertSimple('issue', 'Resolved Issue', 'resolved');
      insertSimple('issue', 'Archived Issue', 'archived');

      const open = db.prepare(`
        SELECT * FROM record WHERE project_id = ? AND status = ?
      `).all(project.id, 'open');
      expect(open).toHaveLength(1);
      expect(open[0].title).toBe('Open Issue');
    });

    it('should return all records when no filters', () => {
      insertSimple('issue', 'A');
      insertSimple('spec', 'B');
      insertSimple('arch', 'C');

      const all = db.prepare(`
        SELECT * FROM record WHERE project_id = ?
      `).all(project.id);
      expect(all).toHaveLength(3);
    });
  });

  // -----------------------------------------------------------------------
  // Vector search
  // -----------------------------------------------------------------------

  describe('vector search', () => {
    function insertWithEmbedding(kind, title, body, embedding) {
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', ?, ?)
      `).run(project.id, kind, title, body, now, now);
      const newId = result.lastInsertRowid;
      db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(
        BigInt(newId), embeddingBuffer(embedding),
      );
      return Number(newId);
    }

    it('should find records by vector similarity', () => {
      const emb1 = seededEmbedding(1);
      const emb2 = seededEmbedding(2);
      const emb3 = seededEmbedding(3);

      insertWithEmbedding('issue', 'Bug One', 'First bug', emb1);
      insertWithEmbedding('issue', 'Bug Two', 'Second bug', emb2);
      insertWithEmbedding('spec', 'Spec Three', 'A specification', emb3);

      const results = db.prepare(`
        SELECT re.record_id, re.distance, r.title
        FROM record_embedding re
        JOIN record r ON r.id = re.record_id
        WHERE re.embedding MATCH ? AND k = 3
        ORDER BY re.distance
      `).all(embeddingBuffer(emb1));

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Bug One');
      expect(results[0].distance).toBeCloseTo(0, 1);
    });

    it('should respect k parameter for result limit', () => {
      for (let i = 0; i < 5; i++) {
        insertWithEmbedding('issue', `Record ${i}`, `Body ${i}`, seededEmbedding(i + 10));
      }

      const results = db.prepare(`
        SELECT re.record_id, re.distance
        FROM record_embedding re
        WHERE re.embedding MATCH ? AND k = 2
        ORDER BY re.distance
      `).all(embeddingBuffer(seededEmbedding(10)));

      expect(results).toHaveLength(2);
    });

    it('should filter vector search by kind via join', () => {
      insertWithEmbedding('issue', 'Bug Alpha', '', seededEmbedding(100));
      insertWithEmbedding('spec', 'Spec Beta', '', seededEmbedding(101));

      const results = db.prepare(`
        SELECT re.record_id, re.distance, r.title, r.kind
        FROM record_embedding re
        JOIN record r ON r.id = re.record_id
        WHERE re.embedding MATCH ? AND k = 10
          AND r.kind = 'issue'
        ORDER BY re.distance
      `).all(embeddingBuffer(seededEmbedding(100)));

      expect(results.every(r => r.kind === 'issue')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Dedup logic
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('should detect near-duplicate embeddings within distance threshold', () => {
      const emb = seededEmbedding(42);
      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, 'issue', 'Original', 'body', 'open', ?, ?)
      `).run(project.id, now, now);
      const id = result.lastInsertRowid;
      db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(
        BigInt(id), embeddingBuffer(emb),
      );

      const candidates = db.prepare(`
        SELECT re.record_id, re.distance
        FROM record_embedding re
        JOIN record r ON r.id = re.record_id
        WHERE re.embedding MATCH ? AND k = 5
          AND r.project_id = ? AND r.kind = 'issue'
        ORDER BY re.distance
        LIMIT 1
      `).all(embeddingBuffer(emb), project.id);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].distance).toBeLessThanOrEqual(0.15);
      expect(Number(candidates[0].record_id)).toBe(Number(id));
    });

    it('should not deduplicate distant embeddings', () => {
      const emb1 = seededEmbedding(1000);
      const emb2 = seededEmbedding(2000);
      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, 'issue', 'Record A', '', 'open', ?, ?)
      `).run(project.id, now, now);
      const id = result.lastInsertRowid;
      db.prepare('INSERT INTO record_embedding (record_id, embedding) VALUES (?, ?)').run(
        BigInt(id), embeddingBuffer(emb1),
      );

      const candidates = db.prepare(`
        SELECT re.record_id, re.distance
        FROM record_embedding re
        JOIN record r ON r.id = re.record_id
        WHERE re.embedding MATCH ? AND k = 5
          AND r.project_id = ? AND r.kind = 'issue'
        ORDER BY re.distance
        LIMIT 1
      `).all(embeddingBuffer(emb2), project.id);

      if (candidates.length > 0) {
        expect(candidates[0].distance).toBeGreaterThan(0.15);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Recent records
  // -----------------------------------------------------------------------

  describe('recent records', () => {
    it('should fetch recently updated records', () => {
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, 'issue', 'Recent Record', '', 'open', ?, ?)
      `).run(project.id, now, now);

      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recent = db.prepare(`
        SELECT r.id, r.kind, r.title, r.status, r.updated_at, p.name AS project
        FROM record r JOIN project p ON r.project_id = p.id
        WHERE r.project_id = ? AND r.updated_at > ?
        ORDER BY r.updated_at DESC
        LIMIT 10
      `).all(project.id, cutoff);

      expect(recent.length).toBeGreaterThanOrEqual(1);
      expect(recent[0].title).toBe('Recent Record');
    });

    it('should not return old records outside recency window', () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

      db.prepare(`
        INSERT INTO record (project_id, kind, title, body, status, created_at, updated_at)
        VALUES (?, 'issue', 'Old Record', '', 'open', ?, ?)
      `).run(project.id, oldDate, oldDate);

      const cutoff = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const recent = db.prepare(`
        SELECT * FROM record
        WHERE project_id = ? AND updated_at > ?
      `).all(project.id, cutoff);

      expect(recent).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // embeddingBuffer utility
  // -----------------------------------------------------------------------

  describe('embeddingBuffer', () => {
    it('should convert Float32Array to Buffer with correct byte length', () => {
      const emb = new Float32Array(384);
      const buf = embeddingBuffer(emb);
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.byteLength).toBe(384 * 4);
    });
  });
});

// -----------------------------------------------------------------------
// Integration test: initDb factory (mocked deps)
// -----------------------------------------------------------------------

describe('db.js factory (initDb)', () => {
  it('should export initDb, getDb, and _resetForTesting', async () => {
    const dbModule = await import('../src/db.js');
    expect(typeof dbModule.initDb).toBe('function');
    expect(typeof dbModule.getDb).toBe('function');
    expect(typeof dbModule._resetForTesting).toBe('function');
  });

  it('should not export legacy sync functions', async () => {
    const dbModule = await import('../src/db.js');
    expect(dbModule.getCurrentProject).toBeUndefined();
    expect(dbModule.listProjects).toBeUndefined();
    expect(dbModule.getRecord).toBeUndefined();
    expect(dbModule.listRecords).toBeUndefined();
    expect(dbModule.deleteRecord).toBeUndefined();
    expect(dbModule.searchRecords).toBeUndefined();
    expect(dbModule.upsertRecord).toBeUndefined();
    expect(dbModule.getRecentRecords).toBeUndefined();
  });

  it('should initialize and return a working adapter', async () => {
    const dbModule = await import('../src/db.js');
    dbModule._resetForTesting();

    const db = await dbModule.initDb({ url: 'file::memory:' });
    expect(db).toBeDefined();

    const proj = await db.getCurrentProject();
    expect(proj.name).toBe('testorg/test-project');
    expect(proj.id).toBeGreaterThan(0);
  });

  it('should return the same adapter on subsequent calls (singleton)', async () => {
    const dbModule = await import('../src/db.js');
    dbModule._resetForTesting();

    const db1 = await dbModule.initDb({ url: 'file::memory:' });
    const db2 = await dbModule.initDb();
    expect(db1).toBe(db2);
  });

  it('should return adapter via getDb after init', async () => {
    const dbModule = await import('../src/db.js');
    dbModule._resetForTesting();

    await dbModule.initDb({ url: 'file::memory:' });
    const db = dbModule.getDb();
    expect(db).toBeDefined();

    const proj = await db.getCurrentProject();
    expect(proj.name).toBe('testorg/test-project');
  });

  it('should perform CRUD through the adapter returned by initDb', async () => {
    const dbModule = await import('../src/db.js');
    dbModule._resetForTesting();

    const db = await dbModule.initDb({ url: 'file::memory:' });
    const emb = fakeEmbedding();

    // Create
    const created = await db.upsert(
      { kind: 'issue', title: 'Factory Test', body: 'Testing via factory' },
      emb,
    );
    expect(created.title).toBe('Factory Test');

    // Read
    const fetched = await db.get(created.id);
    expect(fetched.title).toBe('Factory Test');

    // List
    const records = await db.list({ kind: 'issue' });
    expect(records.length).toBeGreaterThanOrEqual(1);

    // Delete
    const deleted = await db.delete(created.id);
    expect(deleted).toBe(true);

    const gone = await db.get(created.id);
    expect(gone).toBeNull();
  });
});
