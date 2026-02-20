#!/usr/bin/env node

/**
 * SubagentStop hook (Plan matcher) — auto-persist plan records.
 * Reads classification JSON from stdin, upserts plan as a spec record.
 * On malformed JSON or action=none, exits silently.
 */

import { embed } from '../src/embed.js';
import { initDb } from '../src/db.js';

try {
  // Start DB init early — runs in parallel with stdin reading
  const dbPromise = initDb();

  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString().trim();

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write('Auto-persist-plan skipped: malformed JSON from classification prompt\n');
    process.exit(0);
  }

  if (!input.action || input.action === 'none') {
    process.exit(0);
  }

  if (input.action === 'upsert') {
    const kind = input.kind || 'spec';
    const title = input.title || 'Untitled Plan';
    const body = input.body || '';
    const status = input.status || 'open';

    const db = await dbPromise;
    const text = `${title} ${body}`.trim();

    // Parallelize embedding + project lookup
    const [embedding, project] = await Promise.all([
      embed(text),
      db.getCurrentProject(),
    ]);

    const record = await db.upsert(
      {
        projectId: project.id,
        kind,
        title,
        body,
        status,
      },
      embedding,
    );

    process.stdout.write(`Auto-persisted plan as ${kind}: "${record.title}" (id=${record.id})\n`);
  }
} catch (err) {
  // Non-blocking: exit cleanly on any error
  console.error(`[dude] auto-persist-plan error: ${err.message}`);
  process.stdout.write(`Auto-persist-plan skipped: ${err.message}\n`);
  process.exit(0);
}
