import { exec } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed } from './embed.js';
import { initDb } from './db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const INDEX_HTML = readFileSync(join(__dirname, '..', 'web', 'index.html'), 'utf8');

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  json(res, { error: 'Not found' }, 404);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function parseJsonBody(req, res) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    json(res, { error: 'Invalid JSON' }, 400);
    return null;
  }
}

async function handleRequest(db, req, res) {
  const { method } = req;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve SPA
  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }

  // --- API routes ---

  // GET /api/sync-status
  if (method === 'GET' && path === '/api/sync-status') {
    return json(res, await db.syncStatus());
  }

  // POST /api/sync
  if (method === 'POST' && path === '/api/sync') {
    return json(res, await db.sync());
  }

  // GET /api/projects
  if (method === 'GET' && path === '/api/projects') {
    return json(res, await db.listProjects());
  }

  // POST /api/search
  if (method === 'POST' && path === '/api/search') {
    const body = await parseJsonBody(req, res);
    if (!body) return;
    const embedding = await embed(body.query || '');
    const results = await db.search(embedding, {
      kind: body.kind,
      limit: body.limit,
    });
    return json(res, results);
  }

  // Record routes: /api/records[/:id]
  const recordMatch = path.match(/^\/api\/records(?:\/(\d+))?$/);

  if (recordMatch) {
    const id = recordMatch[1] ? Number(recordMatch[1]) : null;

    // GET /api/records
    if (method === 'GET' && !id) {
      const kind = url.searchParams.get('kind') || undefined;
      const status = url.searchParams.get('status') || undefined;
      const project = url.searchParams.get('project') || undefined;
      return json(res, await db.list({ kind, status, project }));
    }

    // GET /api/records/:id
    if (method === 'GET' && id) {
      const record = await db.get(id);
      if (!record) return notFound(res);
      return json(res, record);
    }

    // POST /api/records
    if (method === 'POST' && !id) {
      const body = await parseJsonBody(req, res);
      if (!body) return;
      const text = `${body.title || ''} ${body.body || ''}`.trim();
      const embedding = await embed(text);
      const project = await db.getCurrentProject();
      const record = await db.upsert(
        {
          projectId: project.id,
          kind: body.kind || 'issue',
          title: body.title || '',
          body: body.body || '',
          status: body.status || 'open',
        },
        embedding,
      );
      return json(res, record, 201);
    }

    // PUT /api/records/:id
    if (method === 'PUT' && id) {
      const existing = await db.get(id);
      if (!existing) return notFound(res);
      const body = await parseJsonBody(req, res);
      if (!body) return;
      const text = `${body.title || existing.title} ${body.body || existing.body}`.trim();
      const embedding = await embed(text);
      const record = await db.upsert(
        {
          id,
          projectId: existing.project_id,
          kind: body.kind || existing.kind,
          title: body.title || existing.title,
          body: body.body ?? existing.body,
          status: body.status || existing.status,
        },
        embedding,
      );
      return json(res, record);
    }

    // DELETE /api/records/:id
    if (method === 'DELETE' && id) {
      const deleted = await db.delete(id);
      if (!deleted) return notFound(res);
      return json(res, { ok: true });
    }
  }

  notFound(res);
}

export async function startWebServer() {
  const db = await initDb();
  const port = Number(process.env.DUDE_PORT) || 3456;
  const server = createServer((req, res) => {
    handleRequest(db, req, res).catch(err => {
      console.error('[dude] Request error:', err);
      json(res, { error: 'Internal server error' }, 500);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.error(`[dude] Web server listening on ${url}`);
    const cmd = process.platform === 'darwin' ? 'open'
              : process.platform === 'win32' ? 'start'
              : 'xdg-open';
    exec(`${cmd} ${url}`);
  });
}
