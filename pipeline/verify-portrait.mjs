#!/usr/bin/env node
// Generic portrait verifier — works for any canonical_id.
// Usage:
//   node pipeline/verify-portrait.mjs <portrait.md> <canonical_id>
//
// Loads all messages for the canonical_id and runs verifyPortraitQuotes
// against the markdown's blockquotes and prose-embedded quotes.
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { verifyPortraitQuotes } from './agents/portrait/verify.js';

const [, , portraitPath, canonicalId] = process.argv;
if (!portraitPath || !canonicalId) {
  console.error('usage: node pipeline/verify-portrait.mjs <portrait.md> <canonical_id>');
  process.exit(2);
}
const md = fs.readFileSync(portraitPath, 'utf-8');

const inst = await DuckDBInstance.create('pipeline/output/raw/messages.duckdb');
const conn = await inst.connect();
const msgs = (await conn.runAndReadAll(`
  SELECT m.id, m.ts, m.from_me, m.body
  FROM messages m
  JOIN thread_identity ti ON ti.thread_id = m.thread_id
  WHERE ti.canonical_id = '${canonicalId.replace(/'/g, "''")}'
    AND m.body IS NOT NULL AND m.body <> ''
`)).getRows().map(r => ({ id: r[0], ts: Number(r[1]), from: r[2] ? 'me' : 'them', body: r[3] }));
await conn.disconnectSync();

const result = verifyPortraitQuotes(md, msgs);
console.log(`ok=${result.ok}, failures=${result.failures.length}, source_msgs=${msgs.length}`);
for (const f of result.failures) {
  console.log(`  - ${f.kind} ${f.speaker || '(prose)'}: ${JSON.stringify(f.body.slice(0, 200))}`);
}
process.exit(result.ok ? 0 : 1);
