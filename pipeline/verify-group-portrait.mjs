#!/usr/bin/env node
// Generic group-portrait verifier — accepts blockquotes from any sender
// inside the group thread.
//
// Usage:
//   node pipeline/verify-group-portrait.mjs <portrait.md> <thread_id>
//
// Blockquote format expected:
//   > Sender: quoted text
// where Sender is any sender_name that has actually messaged in the thread.
// The quoted text must appear verbatim in some message body (whitespace+
// curly-quote normalised, with iMessage Tapbacks/timestamp footers stripped).
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';

const NAMED_LINE = /^>\s*([^:\n]{1,60}?)\s*:\s*(.*)$/i;
const PROSE_QUOTE_RE = /["“”]([^"“”]{8,300})["“”]/g;

function normalize(s) {
  return (s || '')
    .replace(/\nTapbacks:[\s\S]*$/i, '')
    .replace(/\n[ \t]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}[\s\S]*$/i, '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—―]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractQuotes(md) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const m = NAMED_LINE.exec(line);
    if (m) {
      const speaker = m[1].trim();
      const body = m[2].trim();
      if (body) out.push({ speaker, body, kind: 'blockquote' });
      continue;
    }
    PROSE_QUOTE_RE.lastIndex = 0;
    let qm;
    while ((qm = PROSE_QUOTE_RE.exec(line)) !== null) {
      out.push({ speaker: null, body: qm[1].trim(), kind: 'prose' });
    }
  }
  return out;
}

const [, , portraitPath, threadId] = process.argv;
if (!portraitPath || !threadId) {
  console.error('usage: node pipeline/verify-group-portrait.mjs <portrait.md> <thread_id>');
  process.exit(2);
}
const md = fs.readFileSync(portraitPath, 'utf-8');

const inst = await DuckDBInstance.create('pipeline/output/raw/messages.duckdb');
const conn = await inst.connect();
const msgs = (await conn.runAndReadAll(`
  SELECT id, ts, sender_name, body
  FROM messages
  WHERE thread_id = '${threadId.replace(/'/g, "''")}'
    AND body IS NOT NULL AND body <> ''
`)).getRows().map(r => ({ id: r[0], ts: Number(r[1]), sender: r[2], body: r[3] }));
await conn.disconnectSync();

const allBodies = new Set();
const senderSet = new Set();
for (const m of msgs) {
  allBodies.add(normalize(m.body));
  if (m.sender) senderSet.add(m.sender);
}

const quotes = extractQuotes(md);
const failures = [];
for (const q of quotes) {
  if (!q.body) continue;
  const k = normalize(q.body);
  if (!k) continue;
  if (!allBodies.has(k)) {
    failures.push(q);
  }
}

console.log(`ok=${failures.length === 0}, failures=${failures.length}, msgs=${msgs.length}, senders=${senderSet.size}`);
for (const f of failures) {
  console.log(`  - ${f.kind} ${f.speaker || '(prose)'}: ${JSON.stringify(f.body.slice(0, 200))}`);
}
process.exit(failures.length === 0 ? 0 : 1);
