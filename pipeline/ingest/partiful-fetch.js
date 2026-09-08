#!/usr/bin/env node
// Fetch partiful events → inputs/partiful/events.jsonl.
//   node pipeline/ingest/partiful-fetch.js          # mine corpus links + fetch public pages (+ IMAP if creds)
//   node pipeline/ingest/partiful-fetch.js --mbox   # backfill from inputs/gmail/*.mbox
//
// Partiful is SMS-first: invites arrive as texts, so the corpus itself is
// the index of event ids. Each id's public page embeds the full event
// object (no auth). IMAP is a residual channel — Demo's gmail has zero
// partiful mail, but it costs nothing to keep watching.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePartifulEmail, parsePartifulEventPage } from './partiful.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'inputs', 'partiful');
const OUT_FILE = path.join(OUT_DIR, 'events.jsonl');
const STATE_FILE = path.join(OUT_DIR, 'state.json');

function loadSyncEnv() {
  const p = path.join(ROOT, '.sync.env');
  if (!fs.existsSync(p)) return {};
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function existingKeys() {
  if (!fs.existsSync(OUT_FILE)) return new Set();
  return new Set(fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { const e = JSON.parse(l); return `${e.event_id}|${e.kind}|${e.email_ts}`; } catch { return null; } })
    .filter(Boolean));
}

function appendEvents(events) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const seen = existingKeys();
  let added = 0;
  for (const e of events) {
    const key = `${e.event_id}|${e.kind}|${e.email_ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fs.appendFileSync(OUT_FILE, JSON.stringify(e) + '\n');
    added++;
  }
  return added;
}

async function fetchImap(env) {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: env.GMAIL_IMAP_USER, pass: env.GMAIL_IMAP_APP_PASSWORD },
  });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const since = state.last ? new Date(state.last) : new Date('2020-01-01');
  await client.connect();
  const lock = await client.getMailboxLock('[Gmail]/All Mail');
  const events = [];
  try {
    for await (const msg of client.fetch(
      { from: 'partiful.com', since },
      { envelope: true, bodyParts: ['text'] },
    )) {
      const text = msg.bodyParts?.get('text')?.toString('utf8') ?? '';
      const parsed = parsePartifulEmail({
        from: msg.envelope.from?.map((a) => `${a.name} <${a.address}>`).join(', ') ?? '',
        subject: msg.envelope.subject ?? '',
        date: msg.envelope.date?.toISOString() ?? '',
        text,
      });
      if (parsed) events.push(parsed);
    }
  } finally {
    lock.release();
    await client.logout();
  }
  const added = appendEvents(events);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ last: Date.now() - 86_400_000 })); // 1d overlap
  console.log(`[partiful] imap: ${events.length} matched, ${added} new`);
}

async function backfillMbox() {
  const { mboxReader } = await import('mbox-reader');
  const { simpleParser } = await import('mailparser');
  const gmailDir = path.join(ROOT, 'inputs', 'gmail');
  const mboxes = fs.existsSync(gmailDir)
    ? fs.readdirSync(gmailDir).filter((f) => f.endsWith('.mbox')) : [];
  const events = [];
  for (const file of mboxes) {
    for await (const message of mboxReader(fs.createReadStream(path.join(gmailDir, file)))) {
      const raw = message.content.toString('utf8');
      if (!/partiful/i.test(raw)) continue;
      const mail = await simpleParser(raw);
      const parsed = parsePartifulEmail({
        from: mail.from?.text ?? '',
        subject: mail.subject ?? '',
        date: mail.date?.toISOString() ?? '',
        text: (mail.text ?? '') + ' ' + (mail.html || ''),
      });
      if (parsed) events.push(parsed);
    }
  }
  const added = appendEvents(events);
  console.log(`[partiful] mbox backfill: ${events.length} matched, ${added} new (${mboxes.length} mbox files)`);
}

/** Event ids already fetched as pages — stable identity is event_id alone. */
function fetchedPageIds() {
  if (!fs.existsSync(OUT_FILE)) return new Set();
  return new Set(fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { const e = JSON.parse(l); return e.kind === 'page' ? e.event_id : null; } catch { return null; } })
    .filter(Boolean));
}

async function mineCorpusAndFetchPages() {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const dbPath = path.join(ROOT, 'pipeline', 'output', 'raw', 'messages.duckdb');
  let ids = [];
  try {
    const inst = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
    const con = await inst.connect();
    const rows = (await con.runAndReadAll(`
      SELECT DISTINCT regexp_extract(body, '[Pp]artiful\\.com/e/([A-Za-z0-9_-]+)', 1) AS id
      FROM messages WHERE body_lower LIKE '%partiful.com/e/%'
    `)).getRowObjectsJson();
    con.closeSync(); inst.closeSync();
    ids = rows.map((r) => r.id).filter(Boolean);
  } catch (e) {
    console.log(`[partiful] corpus mine skipped (${e.message.slice(0, 60)})`);
    return;
  }
  const done = fetchedPageIds();
  const fresh = ids.filter((id) => !done.has(`partiful:${id}`));
  console.log(`[partiful] corpus: ${ids.length} event ids, ${fresh.length} unfetched`);
  const events = [];
  for (const id of fresh) {
    try {
      const res = await fetch(`https://partiful.com/e/${id}`, { redirect: 'follow' });
      const parsed = parsePartifulEventPage(await res.text(), id);
      if (parsed) events.push(parsed);
      else console.log(`  (no event data for ${id} — gone or private)`);
    } catch (e) {
      console.log(`  (fetch failed for ${id}: ${e.message.slice(0, 50)})`);
    }
    await new Promise((r) => setTimeout(r, 300)); // gentle
  }
  const added = appendEvents(events);
  console.log(`[partiful] pages: ${events.length} parsed, ${added} new`);
}

const env = loadSyncEnv();
if (process.argv.includes('--mbox')) {
  await backfillMbox();
} else {
  await mineCorpusAndFetchPages();
  if (env.GMAIL_IMAP_USER && env.GMAIL_IMAP_APP_PASSWORD) await fetchImap(env);
  else console.log('[partiful] imap skipped (no creds)');
}
