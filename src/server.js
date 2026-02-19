import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { embed } from './embed.js';
import { initDb } from './db.js';

export async function startServer() {
  const db = await initDb();

  const server = new McpServer({
    name: 'dude',
    version: '1.0.0',
  });

  // ---- search ----
  server.tool(
    'search',
    'Semantic search across records (issues, specs, arch decisions, updates & tests). Returns cross-project results ranked by similarity.',
    {
      query: z.string().describe('Natural language search query'),
      kind: z.enum(['issue', 'spec', 'arch', 'update', 'test', 'all']).optional().describe('Filter by record kind'),
      project: z.string().optional().describe('Project name to boost; "*" for equal weight'),
      limit: z.number().int().positive().optional().describe('Max results (default 5)'),
    },
    async ({ query, kind, project, limit }) => {
      try {
        const embedding = await embed(query);
        const results = await db.search(embedding, { kind, limit });
        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      } catch (err) {
        console.error('[dude] search failed:', err);
        return { content: [{ type: 'text', text: `Error in search: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- upsert_record ----
  server.tool(
    'upsert_record',
    'Create or update a record. If id is provided, updates that record. Otherwise inserts with dedup.',
    {
      id: z.number().int().optional().describe('Record ID to update (omit for new)'),
      kind: z.enum(['issue', 'spec', 'arch', 'update', 'test']).describe('Record kind: issue (bug), spec (plan), arch (architecture decision), update (feature change), test (verification procedure)'),
      title: z.string().describe('Short summary'),
      body: z.string().optional().describe('Full description'),
      status: z.enum(['open', 'resolved', 'archived', 'active', 'inactive']).optional().describe('Defaults to open. For tests: active = should be performed, inactive = disabled'),
    },
    async ({ id, kind, title, body, status }) => {
      try {
        const text = `${title} ${body || ''}`.trim();
        const embedding = await embed(text);
        const project = await db.getCurrentProject();
        const record = await db.upsert(
          { id, projectId: project.id, kind, title, body: body || '', status: status || 'open' },
          embedding,
        );
        const action = id ? 'Updated' : 'Saved';
        const summary = `[dude] ${action} ${record.kind}: "${record.title}" (id=${record.id}, status=${record.status})`;
        return {
          content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(record, null, 2)}` }],
        };
      } catch (err) {
        console.error('[dude] upsert_record failed:', err);
        return { content: [{ type: 'text', text: `Error in upsert_record: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- get_record ----
  server.tool(
    'get_record',
    'Get a record by ID.',
    {
      id: z.number().int().describe('Record ID'),
    },
    async ({ id }) => {
      try {
        const record = await db.get(id);
        if (!record) {
          return { content: [{ type: 'text', text: `Record ${id} not found.` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(record, null, 2) }],
        };
      } catch (err) {
        console.error('[dude] get_record failed:', err);
        return { content: [{ type: 'text', text: `Error in get_record: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- list_records ----
  server.tool(
    'list_records',
    'List records with optional filters.',
    {
      kind: z.enum(['issue', 'spec', 'arch', 'update', 'test', 'all']).optional().describe('Filter by kind'),
      status: z.enum(['open', 'resolved', 'archived', 'active', 'inactive', 'all']).optional().describe('Filter by status'),
      project: z.string().optional().describe('Project name, or "*" for all'),
    },
    async ({ kind, status, project }) => {
      try {
        const records = await db.list({ kind, status, project });
        return {
          content: [{ type: 'text', text: JSON.stringify(records, null, 2) }],
        };
      } catch (err) {
        console.error('[dude] list_records failed:', err);
        return { content: [{ type: 'text', text: `Error in list_records: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- delete_record ----
  server.tool(
    'delete_record',
    'Delete a record by ID.',
    {
      id: z.number().int().describe('Record ID to delete'),
    },
    async ({ id }) => {
      try {
        const deleted = await db.delete(id);
        return {
          content: [{ type: 'text', text: deleted ? `Record ${id} deleted.` : `Record ${id} not found.` }],
        };
      } catch (err) {
        console.error('[dude] delete_record failed:', err);
        return { content: [{ type: 'text', text: `Error in delete_record: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- list_projects ----
  server.tool(
    'list_projects',
    'List all known projects.',
    {},
    async () => {
      try {
        const projects = await db.listProjects();
        return {
          content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
        };
      } catch (err) {
        console.error('[dude] list_projects failed:', err);
        return { content: [{ type: 'text', text: `Error in list_projects: ${err.message}` }], isError: true };
      }
    },
  );

  // ---- sync_status ----
  server.tool(
    'sync_status',
    'Check cloud sync status and optionally trigger a manual sync.',
    {
      trigger_sync: z.boolean().optional().describe('If true, trigger an immediate sync'),
    },
    async ({ trigger_sync }) => {
      try {
        const status = await db.syncStatus();
        let result = { ...status };
        if (trigger_sync && status.enabled) {
          const syncResult = await db.sync();
          result.sync = syncResult;
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        console.error('[dude] sync_status failed:', err);
        return { content: [{ type: 'text', text: `Error in sync_status: ${err.message}` }], isError: true };
      }
    },
  );

  // Start transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[dude] MCP server running on stdio');
}
