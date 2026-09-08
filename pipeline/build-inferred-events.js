#!/usr/bin/env node
/**
 * Message-inferred events — meetups with no photos.
 *
 *   npm run build-inferred-events            # needs locallmm up on :8100
 *   INFER_LIMIT=200 node pipeline/build-inferred-events.js   # confirm a sample
 *
 * Heuristic half (analyze/meetups.js) finds (thread, Demo-local-day)
 * candidates: a meetup marker ("omw", "i'm here", "see you at"…) + both
 * sides active. Candidates already covered by an overlapping photo event
 * with a shared participant are dropped (the photo event proves it,
 * richer). The rest go to the local LLM (locallmm's OpenAI-compatible
 * proxy) which decides met/didn't + optional venue + a short gist.
 * Confirmed meetups land in events with source='messages' (mevt_* ids),
 * event_messages evidence, met_up_inferred links, and pages on the shared
 * /events index.
 *
 * Verdicts are cached in output/inferred-events/verdicts.jsonl — reruns
 * only ask the LLM about new candidates. Only clean LLM answers are
 * cached; transport errors abort the confirm loop (rerun to resume).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { findMeetupCandidates, confirmWindow } from './analyze/meetups.js';
import { renderEventPage } from './render/event-page.js';
import { renderIndexFromDb } from './build-events.js';
import { formatLocal, resolveTz } from './lib/local-time.js';
import { geocodePlace, RATE_LIMIT_MS } from './ingest/reverse-geocode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const EVENTS_DIR = process.env.EVENTS_DIR || path.join(__dirname, 'output', 'events');
const CACHE_PATH = process.env.INFER_CACHE || path.join(__dirname, 'output', 'inferred-events', 'verdicts.jsonl');
const CONFIRM_URL = process.env.INFER_URL || 'http://127.0.0.1:8100/v1/chat/completions';
const CONFIRM_MODEL = process.env.INFER_MODEL || '';
const HOUR_MS = 3600 * 1000;

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

export async function buildInferredEvents(conn, opts = {}) {
  const {
    eventsDir,
    cachePath,
    confirmFn,
    maxThreadSize = parseInt(process.env.INFER_MAX_THREAD_SIZE || '6', 10),
    limit = parseInt(process.env.INFER_LIMIT || '0', 10) || Infinity,
    dedupePadH = 6,
    retryDelayMs = 5000,
    geocodeCachePath = cachePath ? path.join(path.dirname(cachePath), 'geocode-cache.json') : null,
  } = opts;
  if (typeof confirmFn !== 'function') throw new Error('buildInferredEvents needs a confirmFn');

  const idLookup = {};
  for (const [cid, name] of (await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities`)).getRows()) {
    idLookup[cid] = name;
  }
  const georgeIds = new Set((await conn.runAndReadAll(
    `SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user'`)).getRows().map(r => r[0]));
  const georgeId = georgeIds.values().next().value || null;
  const dayKeyFn = opts.dayKeyFn ||
    ((ts) => formatLocal(georgeId, ts).iso.slice(0, 10)); // Demo-local day, never UTC

  // Idempotent: wipe only message-sourced rows; verdict cache survives.
  await conn.run(`
    DELETE FROM event_messages WHERE event_id IN (SELECT event_id FROM events WHERE source = 'messages');
    DELETE FROM event_photos WHERE event_id IN (SELECT event_id FROM events WHERE source = 'messages');
    DELETE FROM events WHERE source = 'messages';
    DELETE FROM links WHERE link_type = 'met_up_inferred';
  `);
  fs.mkdirSync(eventsDir, { recursive: true });
  for (const f of fs.readdirSync(eventsDir)) {
    if (/^mevt_.*\.html$/.test(f)) fs.unlinkSync(path.join(eventsDir, f));
  }

  // Threads with 1..maxThreadSize mapped identities. NOTE: build-db populates
  // thread_identity for 1-on-1 threads only (verified: max 1 identity per
  // thread), so today this is DMs — group-chat meetups are NOT inferred.
  // Group support needs group_membership here plus per-person presence from
  // the LLM (the `present` field below is the hook).
  const threadIds = new Map();
  for (const [tid, ids] of (await conn.runAndReadAll(`
    SELECT thread_id, list(DISTINCT canonical_id) FROM thread_identity
    GROUP BY 1 HAVING COUNT(DISTINCT canonical_id) <= ${maxThreadSize}
  `)).getRows()) {
    threadIds.set(tid, unw(ids));
  }

  const msgRows = (await conn.runAndReadAll(`
    SELECT id, ts, thread_id, from_me, sender_name, body
    FROM messages
    WHERE meaningful AND ts IS NOT NULL AND body IS NOT NULL
      AND thread_id IN (SELECT thread_id FROM thread_identity GROUP BY 1 HAVING COUNT(DISTINCT canonical_id) <= ${maxThreadSize})
  `)).getRows().map(r => ({
    id: r[0], ts: Number(r[1]), thread_id: r[2], from_me: r[3], sender_name: r[4], body: r[5],
  }));
  const byId = new Map(msgRows.map(m => [m.id, m]));

  const candidates = findMeetupCandidates(msgRows, { dayKeyFn });
  console.log(`${msgRows.length} messages in ${threadIds.size} small threads -> ${candidates.length} meetup candidates`);

  // Drop candidates a photo event already covers: time overlap + shared person,
  // OR time overlap with a photo event that has no non-Demo faces — an
  // anonymous photo cluster during a texted meetup is almost always the same
  // hangout, and two cards for one night mislead.
  const photoEvents = (await conn.runAndReadAll(`
    SELECT start_ts, end_ts, participants FROM events WHERE COALESCE(source, 'photos') = 'photos'
  `)).getRows().map(r => {
    const parts = new Set(unw(r[2]));
    const others = [...parts].filter(id => !georgeIds.has(id));
    return { start: Number(r[0]), end: Number(r[1]), parts, anonymous: others.length === 0 };
  });
  const pad = dedupePadH * HOUR_MS;
  const fresh = candidates.filter(c => {
    const ids = threadIds.get(c.thread_id) || [];
    return !photoEvents.some(e =>
      c.start_ts - pad <= e.end && c.end_ts + pad >= e.start &&
      (e.anonymous || ids.some(id => e.parts.has(id))));
  });
  console.log(`${fresh.length} not already covered by a photo event`);

  // Verdict cache. A '-haiku' sibling (written by a parallel API/agent worker
  // draining the queue from the back) is merged read-only; the main cache wins
  // on duplicate keys and new verdicts append to the main cache only.
  const cache = new Map();
  const cacheFiles = cachePath
    ? [cachePath, cachePath.replace(/\.jsonl$/, '-haiku.jsonl')]
    : [];
  for (const file of cacheFiles) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try { const v = JSON.parse(line); if (!cache.has(v.key)) cache.set(v.key, v); } catch {}
    }
  }
  if (cachePath) fs.mkdirSync(path.dirname(cachePath), { recursive: true });

  let asked = 0, skipped = 0, consecutiveFails = 0, llmDead = false;
  const confirmed = [];
  for (const c of fresh) {
    const key = `${c.thread_id}|${c.day}`;
    let verdict = cache.get(key);
    if (!verdict) {
      // The wipe already ran, so cached-confirmed candidates later in the list
      // must still be processed even when the LLM dies — skip, never break.
      if (llmDead || asked >= limit) continue;
      const msgs = confirmWindow(c.message_ids.map(id => byId.get(id)).filter(Boolean), c.marker_ids);
      const names = (threadIds.get(c.thread_id) || []).map(id => idLookup[id] || id);
      // Some prompts 502 locallmm deterministically (poison transcripts), and
      // the backend also hiccups transiently — retry each candidate briefly,
      // then SKIP it and keep going (it stays uncached, retried next run).
      // Only a long unbroken failure streak means the backend is really down.
      for (let attempt = 0; ; attempt++) {
        try {
          verdict = { key, ...(await confirmFn(c, msgs, { names, georgeId })) };
          consecutiveFails = 0;
          break;
        } catch (err) {
          if (attempt >= 2) {
            skipped++;
            if (++consecutiveFails >= 10) {
              console.error(`  ${consecutiveFails} candidates failed back-to-back (${err.message}) — backend looks down; rerun to resume`);
              llmDead = true;
            }
            break;
          }
          await new Promise(r => setTimeout(r, (attempt + 1) * retryDelayMs));
        }
      }
      if (!verdict) continue;
      asked++;
      // Cache only clean answers — an unparseable reply must not become a
      // permanent "no".
      if (!verdict.unparsed) {
        cache.set(key, verdict);
        if (cachePath) fs.appendFileSync(cachePath, JSON.stringify(verdict) + '\n');
      }
      if (asked % 25 === 0) console.log(`  asked ${asked}, confirmed ${confirmed.length + (verdict.met ? 1 : 0)} so far`);
    }
    if (verdict.met) confirmed.push({ ...c, verdict });
  }
  console.log(`asked LLM about ${asked} new candidates; ${confirmed.length} meetups confirmed (incl. cached)${skipped ? `; ${skipped} skipped on repeated failure (retried next run)` : ''}`);

  // Geotag: forward-geocode the LLM's venue string where one exists, biased
  // toward where Demo lived at the time (soft viewbox, never a restriction).
  // File-cached by era|place so reruns and repeat venues cost nothing.
  const geocodeFn = opts.geocodeFn || (async (place, ts) => {
    const label = resolveTz(georgeId, ts).label;
    const viewbox = label === 'AU' ? '140,-39,153,-32'
      : label === 'CHI' ? '-88.5,41.2,-87.0,42.5' : null;
    const hit = await geocodePlace(place, viewbox ? { viewbox } : {});
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    return hit;
  });
  let geo = {};
  if (geocodeCachePath && fs.existsSync(geocodeCachePath)) {
    try { geo = JSON.parse(fs.readFileSync(geocodeCachePath, 'utf-8')); } catch {}
  }
  let nGeo = 0;
  for (const c of confirmed) {
    // Explicit venue first; else a fleet-inferred location (suburb/city-level
    // guess from the transcript). Inferred strings only ever produce lat/lng —
    // place_name stays explicit-only, so no page asserts a guessed venue.
    const place = c.verdict.place || c.verdict.inferred_place;
    if (!place) continue;
    const geoKey = `${resolveTz(georgeId, c.start_ts).label}|${place.toLowerCase()}`;
    if (!(geoKey in geo)) {
      try {
        const hit = await geocodeFn(place, c.start_ts);
        geo[geoKey] = hit ? { lat: hit.lat, lng: hit.lng } : null;
      } catch { continue; } // transient — retried next run, not cached
      if (geocodeCachePath) fs.writeFileSync(geocodeCachePath, JSON.stringify(geo, null, 1));
    }
    if (geo[geoKey]) { c.coords = geo[geoKey]; nGeo++; }
  }
  console.log(`geotagged ${nGeo}/${confirmed.length} confirmed meetups`);

  await conn.run('BEGIN TRANSACTION');
  const usedIds = new Set();
  for (const c of confirmed) {
    let event_id = `mevt_${c.day}_${shortHash(c.thread_id)}`;
    for (let i = 2; usedIds.has(event_id); i++) event_id = `mevt_${c.day}_${shortHash(c.thread_id)}-${i}`;
    usedIds.add(event_id);
    const ids = threadIds.get(c.thread_id) || [];
    // If the LLM named who was present, trust that subset over "everyone in
    // the thread" (matters once group threads are supported).
    const presentNames = (c.verdict.present || []).map(n => String(n).toLowerCase());
    const presentIds = presentNames.length
      ? ids.filter(id => presentNames.includes(String(idLookup[id] || '').toLowerCase()))
      : [];
    const participants = [...new Set([...(georgeId ? [georgeId] : []), ...(presentIds.length ? presentIds : ids)])];
    const partsArr = `[${participants.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',')}]`;
    const msgs = c.message_ids.map(id => byId.get(id)).filter(Boolean);
    await conn.run(`
      INSERT OR IGNORE INTO events (event_id, start_ts, end_ts, place_name, participants, n_photos, n_messages, summary, source, lat, lng)
      VALUES (${esc(event_id)}, ${c.start_ts}, ${c.end_ts}, ${esc(c.verdict.place || null)}, ${partsArr}, 0, ${msgs.length}, ${esc(c.verdict.gist || null)}, 'messages', ${esc(c.coords ? c.coords.lat : null)}, ${esc(c.coords ? c.coords.lng : null)})
    `);
    for (const m of msgs) {
      await conn.run(`INSERT OR IGNORE INTO event_messages VALUES (${esc(event_id)}, ${esc(m.id)})`);
    }
    const html = renderEventPage({
      event: { event_id, start_ts: c.start_ts, end_ts: c.end_ts, place_name: c.verdict.place || null, participants, summary: c.verdict.gist || null },
      photos: [],
      messages: msgs,
      idLookup,
    });
    fs.writeFileSync(path.join(eventsDir, `${event_id}.html`), html);
  }
  await conn.run('COMMIT');

  // met_up_inferred: person <-> person per confirmed meetup, both directions.
  await conn.run(`
    WITH pe AS (
      SELECT event_id, unnest(participants) AS canonical_id FROM events WHERE source = 'messages'
    )
    INSERT INTO links (canonical_id, link_type, related_canonical_id, related_label, evidence, weight)
    SELECT a.canonical_id, 'met_up_inferred', b.canonical_id, i.display_name,
           'inferred meetups from messages: ' || COUNT(DISTINCT a.event_id) || ' days',
           COUNT(DISTINCT a.event_id)
    FROM pe a
    JOIN pe b ON a.event_id = b.event_id AND a.canonical_id <> b.canonical_id
    JOIN identities i ON i.canonical_id = b.canonical_id
    GROUP BY a.canonical_id, b.canonical_id, i.display_name
  `);

  await renderIndexFromDb(conn, eventsDir);
  const nLinks = Number((await conn.runAndReadAll(
    `SELECT COUNT(*) FROM links WHERE link_type = 'met_up_inferred'`)).getRows()[0][0]);
  console.log(`inferred_events=${confirmed.length} met_up_inferred=${nLinks}`);
  return confirmed.length;
}

// ─── Local LLM confirm (locallmm proxy) ────────────────────────────────────

async function qwenConfirm(candidate, msgs, ctx) {
  const lines = msgs.slice(0, 60).map(m => {
    const t = formatLocal(ctx.georgeId, m.ts, { withDate: false, withTz: false }).formatted;
    const who = m.from_me ? 'Demo' : (m.sender_name || 'them');
    return `${t} ${who}: ${String(m.body).slice(0, 200)}`;
  }).join('\n');
  // Transcript first, context after: a "Text messages between …:" header line
  // before the transcript deterministically 502s locallmm's verify layer
  // (its MLX response comes back without 'content'). Bisected 2026-07-30.
  const prompt = `${lines}

The messages above are between Demo and ${ctx.names.join(', ') || 'a friend'} on ${candidate.day} (times are Demo's local time). Did Demo and the other person(s) meet IN PERSON that day? Planning a future meetup does not count; only an actual same-day meeting does. Reply with ONLY a JSON object, no prose:
{"met": true or false, "place": "venue/place name if one is evident, else null", "gist": "3-6 word description of the meetup, else null", "present": ["names of the people Demo actually met, from: ${ctx.names.join(', ')}"] or []}`;

  const payload = { messages: [{ role: 'user', content: prompt }], stream: false };
  if (CONFIRM_MODEL) payload.model = CONFIRM_MODEL;
  const res = await fetch(CONFIRM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`confirm HTTP ${res.status}`);
  const content = String((await res.json()).choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '');
  const m = content.match(/\{[\s\S]*?\}/);
  if (!m) return { met: false, unparsed: true };
  try {
    const v = JSON.parse(m[0]);
    const clean = (x) => (x && x !== 'null') ? String(x).slice(0, 120) : null;
    const present = Array.isArray(v.present) ? v.present.map(n => String(n).slice(0, 80)).slice(0, 12) : [];
    return { met: v.met === true, place: clean(v.place), gist: clean(v.gist), present };
  } catch {
    return { met: false, unparsed: true };
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  // Proxy down is not fatal: cached verdicts still rebuild their events
  // (essential after build-db wipes the DB), and uncached candidates are
  // skipped by the poison/outage machinery and retried next run.
  let confirmFn = qwenConfirm;
  try {
    // Any HTTP response counts as reachable — locallmm 404s /v1/models but
    // serves /v1/chat/completions fine. Only a connection failure means down.
    await fetch(CONFIRM_URL.replace(/\/chat\/completions$/, '/models'), { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    console.warn(`LLM confirm proxy unreachable at ${CONFIRM_URL} (${err.message}) — rebuilding from cached verdicts only; new candidates wait for the next run.`);
    confirmFn = async () => { throw new Error('confirm proxy down'); };
  }
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  await buildInferredEvents(conn, { eventsDir: EVENTS_DIR, cachePath: CACHE_PATH, confirmFn });
  await conn.disconnectSync();
  console.log(`\nDone. http://127.0.0.1:8765/events/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
