#!/usr/bin/env node

/**
 * UserPromptSubmit hook — auto-retrieve relevant records.
 * Reads the user prompt from stdin JSON, embeds it, searches the DB,
 * and writes formatted context to stdout for Claude to see.
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
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const prompt = input.prompt || input.tool_input?.prompt || '';

  if (!prompt.trim()) {
    process.exit(0);
  }

  const db = await dbPromise;

  // Parallelize embedding + project lookup
  const [embedding, project] = await Promise.all([
    embed(prompt),
    db.getCurrentProject(),
  ]);

  // 1) Project identification
  process.stdout.write(`[dude] Project: ${project.name} (id=${project.id})\n`);

  // 2) Recently updated records
  const recencyWindow = Number(process.env.DUDE_RECENCY_HOURS) || 1;
  const recentRecords = await db.getRecentRecords(project.id, recencyWindow);
  if (recentRecords.length > 0) {
    const recentLines = ['[dude] Recently updated records:'];
    for (const r of recentRecords) {
      recentLines.push(`- [${r.kind}] ${r.title} (id=${r.id}, status=${r.status}, updated: ${r.updated_at})`);
    }
    process.stdout.write(recentLines.join('\n') + '\n');
  }

  // 3) Semantic search
  const limit = Number(process.env.DUDE_CONTEXT_LIMIT) || 5;
  const results = await db.search(embedding, { limit });

  if (results.length > 0) {
    const lines = ['[dude] Relevant context from memory:'];
    for (const r of results) {
      lines.push(`- [${r.kind}] ${r.title} (project: ${r.project}, status: ${r.status}, similarity: ${r.similarity.toFixed(2)})`);
      if (r.body) {
        lines.push(`  ${r.body.slice(0, 200)}${r.body.length > 200 ? '…' : ''}`);
      }
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
} catch (err) {
  // Non-blocking: exit cleanly on any error
  console.error(`[dude] auto-retrieve error: ${err.message}`);
  process.exit(0);
}
