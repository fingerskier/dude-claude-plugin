import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock embed
vi.mock('../src/embed.js', () => ({
  embed: vi.fn(async () => new Float32Array(384)),
}));

// Mock db.js — initDb must return an adapter-shaped object
const mockDb = {
  search: vi.fn(async () => []),
  getCurrentProject: vi.fn(async () => ({ id: 1, name: 'test-project' })),
  upsert: vi.fn(async (fields) => ({ id: fields.id || 1, ...fields })),
  get: vi.fn(async (id) => (id === 999 ? null : { id, kind: 'issue', title: 'Test', status: 'open' })),
  list: vi.fn(async () => []),
  delete: vi.fn(async (id) => id !== 999),
  listProjects: vi.fn(async () => [{ id: 1, name: 'test-project' }]),
  syncStatus: vi.fn(async () => ({ enabled: false })),
  sync: vi.fn(async () => ({ synced: false, message: 'Cloud sync not configured' })),
};

vi.mock('../src/db.js', () => ({
  initDb: vi.fn(async () => mockDb),
}));

// Capture registered tools
const registeredTools = [];
let mcpServerInstance;

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  class MockMcpServer {
    constructor() {
      this.tool = vi.fn((name, desc, schema, handler) => {
        registeredTools.push({ name, desc, schema, handler });
      });
      this.connect = vi.fn(async () => {});
      mcpServerInstance = this;
    }
  }
  return { McpServer: MockMcpServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  class MockStdioServerTransport {}
  return { StdioServerTransport: MockStdioServerTransport };
});

describe('server.js', () => {
  let toolHandlers;

  beforeAll(async () => {
    const serverModule = await import('../src/server.js');
    await serverModule.startServer();

    // Build a map of tool name -> handler
    toolHandlers = {};
    for (const t of registeredTools) {
      toolHandlers[t.name] = t.handler;
    }
  });

  it('should export startServer function', async () => {
    const serverModule = await import('../src/server.js');
    expect(typeof serverModule.startServer).toBe('function');
  });

  it('should register all 7 MCP tools', () => {
    expect(registeredTools).toHaveLength(7);
    const names = registeredTools.map(t => t.name);
    expect(names).toContain('search');
    expect(names).toContain('upsert_record');
    expect(names).toContain('get_record');
    expect(names).toContain('list_records');
    expect(names).toContain('delete_record');
    expect(names).toContain('list_projects');
    expect(names).toContain('sync_status');
  });

  it('should initialize DB before registering tools', async () => {
    const db = await import('../src/db.js');
    expect(db.initDb).toHaveBeenCalled();
  });

  it('should connect to stdio transport', () => {
    expect(mcpServerInstance.connect).toHaveBeenCalled();
  });

  describe('tool handlers', () => {
    it('search should call embed and db.search', async () => {
      const { embed } = await import('../src/embed.js');

      const result = await toolHandlers.search({ query: 'test query' });
      expect(embed).toHaveBeenCalledWith('test query');
      expect(mockDb.search).toHaveBeenCalled();
      expect(result.content[0].type).toBe('text');
    });

    it('search should return error on failure', async () => {
      mockDb.search.mockRejectedValueOnce(new Error('DB failure'));

      const result = await toolHandlers.search({ query: 'bad query' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error');
    });

    it('upsert_record should create a record', async () => {
      const { embed } = await import('../src/embed.js');

      const result = await toolHandlers.upsert_record({
        kind: 'issue',
        title: 'New Bug',
        body: 'Description',
        status: 'open',
      });

      expect(embed).toHaveBeenCalled();
      expect(mockDb.upsert).toHaveBeenCalled();
      expect(result.content[0].text).toContain('Saved');
    });

    it('upsert_record should indicate update when id is provided', async () => {
      const result = await toolHandlers.upsert_record({
        id: 5,
        kind: 'issue',
        title: 'Updated Bug',
        body: 'Updated description',
      });

      expect(result.content[0].text).toContain('Updated');
    });

    it('get_record should return record data', async () => {
      const result = await toolHandlers.get_record({ id: 1 });
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBe(1);
    });

    it('get_record should return error for missing record', async () => {
      const result = await toolHandlers.get_record({ id: 999 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
    });

    it('list_records should return records array', async () => {
      const result = await toolHandlers.list_records({});
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
    });

    it('delete_record should confirm deletion', async () => {
      const result = await toolHandlers.delete_record({ id: 1 });
      expect(result.content[0].text).toContain('deleted');
    });

    it('delete_record should handle missing record', async () => {
      const result = await toolHandlers.delete_record({ id: 999 });
      expect(result.content[0].text).toContain('not found');
    });

    it('list_projects should return projects', async () => {
      const result = await toolHandlers.list_projects();
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
    });

    it('sync_status should return sync status', async () => {
      const result = await toolHandlers.sync_status({});
      expect(result.content[0].type).toBe('text');
      const data = JSON.parse(result.content[0].text);
      expect(data.enabled).toBe(false);
    });

    it('sync_status should trigger sync when requested', async () => {
      mockDb.syncStatus.mockResolvedValueOnce({ enabled: true, syncUrl: 'libsql://test.turso.io' });
      mockDb.sync.mockResolvedValueOnce({ synced: true, message: 'Synced with libsql://test.turso.io' });

      const result = await toolHandlers.sync_status({ trigger_sync: true });
      const data = JSON.parse(result.content[0].text);
      expect(data.enabled).toBe(true);
      expect(data.sync.synced).toBe(true);
    });

    it('sync_status should not trigger sync when disabled', async () => {
      const result = await toolHandlers.sync_status({ trigger_sync: true });
      const data = JSON.parse(result.content[0].text);
      expect(data.enabled).toBe(false);
      expect(data.sync).toBeUndefined();
    });
  });
});
