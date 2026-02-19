import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeEmbedding, seededEmbedding } from './helpers.js';

// Mock child_process so _detectProject() doesn't shell out
vi.mock('node:child_process', () => ({
  execSync: vi.fn((cmd) => {
    if (cmd === 'git rev-parse --show-toplevel') return '/home/user/test-project\n';
    if (cmd === 'git remote get-url origin') return 'https://github.com/testorg/test-project.git\n';
    throw new Error('Unknown command');
  }),
}));

// Mock os.homedir to avoid touching real filesystem
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = actual;
  const testHome = mkdtempSync(`${tmpdir()}/dude-libsql-test-`);
  return {
    ...actual,
    homedir: () => testHome,
  };
});

const { LibsqlAdapter } = await import('../src/db-libsql.js');

describe('LibsqlAdapter', () => {
  /** @type {LibsqlAdapter} */
  let adapter;

  beforeEach(async () => {
    adapter = new LibsqlAdapter({ url: 'file::memory:' });
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
  });

  // -----------------------------------------------------------------------
  // Initialisation
  // -----------------------------------------------------------------------

  describe('initialization', () => {
    it('should initialize and detect project', async () => {
      const proj = await adapter.getCurrentProject();
      expect(proj).toBeDefined();
      expect(proj.name).toBe('testorg/test-project');
      expect(proj.id).toBeGreaterThan(0);
    });

    it('should be idempotent (calling init twice is safe)', async () => {
      await adapter.init(); // second call
      const proj = await adapter.getCurrentProject();
      expect(proj.name).toBe('testorg/test-project');
    });
  });

  // -----------------------------------------------------------------------
  // Project operations
  // -----------------------------------------------------------------------

  describe('getCurrentProject', () => {
    it('should return current project id and name', async () => {
      const proj = await adapter.getCurrentProject();
      expect(proj.id).toBeGreaterThan(0);
      expect(proj.name).toBe('testorg/test-project');
    });

    it('should throw if not initialized', async () => {
      const fresh = new LibsqlAdapter({ url: 'file::memory:' });
      await expect(fresh.getCurrentProject()).rejects.toThrow('not initialised');
    });
  });

  describe('listProjects', () => {
    it('should list all projects', async () => {
      const projects = await adapter.listProjects();
      expect(projects.length).toBeGreaterThanOrEqual(1);
      expect(projects.some(p => p.name === 'testorg/test-project')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Record CRUD via upsert/get
  // -----------------------------------------------------------------------

  describe('upsert and get', () => {
    it('should insert a new record', async () => {
      const emb = fakeEmbedding();
      const record = await adapter.upsert(
        { kind: 'issue', title: 'Test Bug', body: 'Something broke' },
        emb,
      );
      expect(record).toBeDefined();
      expect(record.title).toBe('Test Bug');
      expect(record.kind).toBe('issue');
      expect(record.status).toBe('open');
      expect(record.project).toBe('testorg/test-project');
      expect(record.id).toBeGreaterThan(0);
    });

    it('should get a record by id', async () => {
      const emb = fakeEmbedding();
      const created = await adapter.upsert(
        { kind: 'spec', title: 'Auth Spec', body: 'JWT auth' },
        emb,
      );
      const fetched = await adapter.get(created.id);
      expect(fetched).toBeDefined();
      expect(fetched.title).toBe('Auth Spec');
      expect(fetched.body).toBe('JWT auth');
    });

    it('should return null for non-existent record', async () => {
      const result = await adapter.get(99999);
      expect(result).toBeNull();
    });

    it('should not include embedding column in get result', async () => {
      const emb = fakeEmbedding();
      const record = await adapter.upsert(
        { kind: 'issue', title: 'No Embedding', body: 'test' },
        emb,
      );
      const fetched = await adapter.get(record.id);
      expect(fetched.embedding).toBeUndefined();
    });

    it('should update an existing record by id', async () => {
      const emb = fakeEmbedding();
      const created = await adapter.upsert(
        { kind: 'issue', title: 'Old Title', body: 'Old body' },
        emb,
      );

      const newEmb = fakeEmbedding();
      const updated = await adapter.upsert(
        { id: created.id, kind: 'issue', title: 'New Title', body: 'New body', status: 'resolved' },
        newEmb,
      );

      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe('New Title');
      expect(updated.body).toBe('New body');
      expect(updated.status).toBe('resolved');
    });

    it('should support all valid kinds: issue, spec, arch, update, test', async () => {
      for (const kind of ['issue', 'spec', 'arch', 'update', 'test']) {
        const emb = fakeEmbedding();
        const record = await adapter.upsert(
          { kind, title: `${kind} record` },
          emb,
        );
        expect(record.kind).toBe(kind);
      }
    });

    it('should support all valid statuses: open, resolved, archived, active, inactive', async () => {
      for (const status of ['open', 'resolved', 'archived', 'active', 'inactive']) {
        const emb = fakeEmbedding();
        const record = await adapter.upsert(
          { kind: 'issue', title: `${status} record`, status },
          emb,
        );
        expect(record.status).toBe(status);
      }
    });
  });

  // -----------------------------------------------------------------------
  // List records
  // -----------------------------------------------------------------------

  describe('list', () => {
    it('should list records for current project', async () => {
      await adapter.upsert({ kind: 'issue', title: 'A' }, fakeEmbedding());
      await adapter.upsert({ kind: 'spec', title: 'B' }, fakeEmbedding());

      const records = await adapter.list();
      expect(records.length).toBe(2);
    });

    it('should filter by kind', async () => {
      await adapter.upsert({ kind: 'issue', title: 'Bug A' }, fakeEmbedding());
      await adapter.upsert({ kind: 'spec', title: 'Spec A' }, fakeEmbedding());
      await adapter.upsert({ kind: 'issue', title: 'Bug B' }, fakeEmbedding());

      const issues = await adapter.list({ kind: 'issue' });
      expect(issues).toHaveLength(2);
      expect(issues.every(r => r.kind === 'issue')).toBe(true);
    });

    it('should filter by status', async () => {
      await adapter.upsert({ kind: 'issue', title: 'Open', status: 'open' }, fakeEmbedding());
      await adapter.upsert({ kind: 'issue', title: 'Resolved', status: 'resolved' }, fakeEmbedding());
      await adapter.upsert({ kind: 'issue', title: 'Archived', status: 'archived' }, fakeEmbedding());

      const open = await adapter.list({ status: 'open' });
      expect(open).toHaveLength(1);
      expect(open[0].title).toBe('Open');
    });

    it('should return all records when kind=all', async () => {
      await adapter.upsert({ kind: 'issue', title: 'A' }, fakeEmbedding());
      await adapter.upsert({ kind: 'spec', title: 'B' }, fakeEmbedding());
      await adapter.upsert({ kind: 'arch', title: 'C' }, fakeEmbedding());

      const all = await adapter.list({ kind: 'all' });
      expect(all).toHaveLength(3);
    });

    it('should not include embedding in list results', async () => {
      await adapter.upsert({ kind: 'issue', title: 'Test' }, fakeEmbedding());
      const records = await adapter.list();
      expect(records[0].embedding).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  describe('delete', () => {
    it('should delete a record', async () => {
      const emb = fakeEmbedding();
      const record = await adapter.upsert({ kind: 'issue', title: 'To Delete' }, emb);

      const deleted = await adapter.delete(record.id);
      expect(deleted).toBe(true);

      const gone = await adapter.get(record.id);
      expect(gone).toBeNull();
    });

    it('should return false for non-existent record', async () => {
      const deleted = await adapter.delete(99999);
      expect(deleted).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Vector search
  // -----------------------------------------------------------------------

  describe('search', () => {
    it('should find records by vector similarity', async () => {
      const emb1 = seededEmbedding(1);
      const emb2 = seededEmbedding(2);
      const emb3 = seededEmbedding(3);

      await adapter.upsert({ kind: 'issue', title: 'Bug One', body: 'First bug' }, emb1);
      await adapter.upsert({ kind: 'issue', title: 'Bug Two', body: 'Second bug' }, emb2);
      await adapter.upsert({ kind: 'spec', title: 'Spec Three', body: 'A specification' }, emb3);

      const results = await adapter.search(emb1, { limit: 3 });
      expect(results.length).toBeGreaterThan(0);
      // The first result should be the most similar (exact match for emb1)
      expect(results[0].title).toBe('Bug One');
      expect(results[0].similarity).toBeGreaterThan(0.9);
    });

    it('should boost current project results', async () => {
      const emb = seededEmbedding(42);
      await adapter.upsert({ kind: 'issue', title: 'Boosted' }, emb);

      const results = await adapter.search(emb, { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      // Same project → boosted by 0.1, but capped at 1.0
      expect(results[0].similarity).toBeLessThanOrEqual(1.0);
    });

    it('should filter by kind', async () => {
      await adapter.upsert({ kind: 'issue', title: 'Bug Alpha' }, seededEmbedding(100));
      await adapter.upsert({ kind: 'spec', title: 'Spec Beta' }, seededEmbedding(101));

      const results = await adapter.search(seededEmbedding(100), { kind: 'issue', limit: 10 });
      expect(results.every(r => r.kind === 'issue')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.upsert(
          { kind: 'issue', title: `Record ${i}`, body: `Body ${i}` },
          seededEmbedding(i + 10),
        );
      }

      const results = await adapter.search(seededEmbedding(10), { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should not include embedding column in results', async () => {
      await adapter.upsert({ kind: 'issue', title: 'No Emb' }, seededEmbedding(200));
      const results = await adapter.search(seededEmbedding(200), { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].embedding).toBeUndefined();
    });

    it('should return empty array when no records exist', async () => {
      const results = await adapter.search(fakeEmbedding(), { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Dedup logic
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('should deduplicate near-identical records', async () => {
      const emb = seededEmbedding(42);

      const first = await adapter.upsert(
        { kind: 'issue', title: 'Original', body: 'body' },
        emb,
      );

      // Same embedding → should update existing, not insert new
      const second = await adapter.upsert(
        { kind: 'issue', title: 'Updated Title', body: 'new body' },
        emb,
      );

      expect(second.id).toBe(first.id);
      expect(second.title).toBe('Updated Title');

      // Verify only one record exists
      const all = await adapter.list({ kind: 'issue' });
      expect(all).toHaveLength(1);
    });

    it('should not deduplicate distant records', async () => {
      const emb1 = seededEmbedding(1000);
      const emb2 = seededEmbedding(2000);

      const first = await adapter.upsert(
        { kind: 'issue', title: 'Record A' },
        emb1,
      );

      const second = await adapter.upsert(
        { kind: 'issue', title: 'Record B' },
        emb2,
      );

      expect(second.id).not.toBe(first.id);

      const all = await adapter.list({ kind: 'issue' });
      expect(all).toHaveLength(2);
    });

    it('should not deduplicate across different kinds', async () => {
      const emb = seededEmbedding(42);

      const issue = await adapter.upsert(
        { kind: 'issue', title: 'Same Embedding' },
        emb,
      );

      const spec = await adapter.upsert(
        { kind: 'spec', title: 'Same Embedding' },
        emb,
      );

      expect(spec.id).not.toBe(issue.id);
    });
  });

  // -----------------------------------------------------------------------
  // Recent records
  // -----------------------------------------------------------------------

  describe('getRecentRecords', () => {
    it('should return recently updated records', async () => {
      await adapter.upsert({ kind: 'issue', title: 'Recent Record' }, fakeEmbedding());

      const proj = await adapter.getCurrentProject();
      const recent = await adapter.getRecentRecords(proj.id, 1);

      expect(recent.length).toBeGreaterThanOrEqual(1);
      expect(recent[0].title).toBe('Recent Record');
    });

    it('should not return old records outside recency window', async () => {
      // Insert a record and then manually backdate it
      const emb = fakeEmbedding();
      const record = await adapter.upsert({ kind: 'issue', title: 'Old Record' }, emb);

      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      await adapter.db.execute({
        sql: 'UPDATE record SET updated_at = ?, created_at = ? WHERE id = ?',
        args: [oldDate, oldDate, record.id],
      });

      const proj = await adapter.getCurrentProject();
      const recent = await adapter.getRecentRecords(proj.id, 1);
      expect(recent.every(r => r.title !== 'Old Record')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Cloud sync
  // -----------------------------------------------------------------------

  describe('syncStatus', () => {
    it('should report sync as disabled when no sync URL configured', async () => {
      const status = await adapter.syncStatus();
      expect(status.enabled).toBe(false);
      expect(status.syncUrl).toBeUndefined();
    });

    it('should report sync as enabled when syncUrl is in config', async () => {
      const syncAdapter = new LibsqlAdapter({
        url: 'file::memory:',
        syncUrl: 'libsql://test-db.turso.io',
        authToken: 'test-token',
        syncInterval: 30000,
      });
      // Don't init (would try to connect to Turso), just test config reading
      const status = await syncAdapter.syncStatus();
      expect(status.enabled).toBe(true);
      expect(status.syncUrl).toBe('libsql://test-db.turso.io');
      expect(status.syncInterval).toBe(30000);
    });
  });

  describe('sync', () => {
    it('should return not-configured message when sync is disabled', async () => {
      const result = await adapter.sync();
      expect(result.synced).toBe(false);
      expect(result.message).toContain('not configured');
    });
  });

  // -----------------------------------------------------------------------
  // Embedding round-trip
  // -----------------------------------------------------------------------

  describe('embedding round-trip', () => {
    it('should preserve embedding values through insert and read', async () => {
      const emb = seededEmbedding(999);
      const record = await adapter.upsert({ kind: 'issue', title: 'Round Trip' }, emb);

      // Read the raw embedding back via direct query
      const result = await adapter.db.execute({
        sql: 'SELECT embedding FROM record WHERE id = ?',
        args: [record.id],
      });

      const stored = adapter._parseEmbedding(result.rows[0].embedding);
      expect(stored).not.toBeNull();
      expect(stored.length).toBe(384);

      // Verify values are close (float precision)
      for (let i = 0; i < 384; i++) {
        expect(stored[i]).toBeCloseTo(emb[i], 4);
      }
    });

    it('should compute similarity correctly for identical embeddings', async () => {
      const emb = seededEmbedding(123);
      await adapter.upsert({ kind: 'issue', title: 'Identical' }, emb);

      // Search with the exact same embedding
      const results = await adapter.search(emb, { limit: 1 });
      expect(results.length).toBe(1);
      // Similarity should be very close to 1.0 (with +0.1 boost, capped at 1.0)
      expect(results[0].similarity).toBeCloseTo(1.0, 1);
    });
  });
});
