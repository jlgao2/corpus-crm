#!/usr/bin/env node
/**
 * Photo events builder (Phase 6) — the linking layer.
 *
 *   npm run build-events
 *
 * Clusters photos (time × location) into events, attaches participants from
 * photo_faces (the face-recognition work), names events from *attended*
 * fb_events, links messages inside each event's window (participant threads
 * preferred), renders event pages, and derives person_event +
 * co_present_event edges into links.
 *
 * Additive: never touches photos/places/photo_faces. Runs any time after
 * build-gphotos-only.js + build-faces.js. (build-photos.js owns the Apple
 * path and wipes photo_faces on rebuild — this script exists so the gphotos
 * corpus gets events without that.)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { clusterEvents, haversineKm } from './analyze/events.js';
import { renderEventPage } from './render/event-page.js';
import { renderEventIndex } from './render/event-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const EVENTS_DIR = process.env.EVENTS_DIR || path.join(__dirname, 'output', 'events');
const HOUR_MS = 3600 * 1000;

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Attended fb_events only — interested/invited/declined never name a cluster.
const ATTENDED = ['hosted', 'created', 'ticket', 'joined'];

function pickFbEvent(candidates, center, fbKm, timeOnlyMs) {
  if (!candidates.length) return null;
  const dist = (f) => (center && f.lat != null && f.lng != null)
    ? haversineKm({ lat: f.lat, lng: f.lng }, center) : null;
  const near = candidates.filter(f => { const d = dist(f); return d != null && d <= fbKm; });
  if (near.length) return { fb: near.sort((a, b) => a.delta - b.delta)[0], match: 'geo' };
  // No geo on either side (575/576 'joined' exports carry no coords, so this
  // is the common path): time correlation only — demand a tight delta, and the
  // caller marks the match as unverified. Known-far candidates are rejected.
  const timeOnly = candidates.filter(f => dist(f) == null && f.delta <= timeOnlyMs);
  if (!timeOnly.length) return null;
  return { fb: timeOnly.sort((a, b) => a.delta - b.delta)[0], match: 'time' };
}

export async function buildEvents(conn, opts = {}) {
  const {
    eventsDir,
    timeGapHours = parseFloat(process.env.EVENT_TIME_GAP_H || '6'),
    locationKm = parseFloat(process.env.EVENT_LOCATION_KM || '1'),
    minPhotos = parseInt(process.env.EVENT_MIN_PHOTOS || '3', 10),
    messagePadH = parseFloat(process.env.EVENT_MESSAGE_PADDING_H || '12'),
    fbPadH = parseFloat(process.env.EVENT_FB_PAD_H || '6'),
    fbKm = parseFloat(process.env.EVENT_FB_KM || '5'),
    fbTimeOnlyH = parseFloat(process.env.EVENT_FB_TIME_ONLY_H || '3'),
    windowMsgs = process.env.EVENT_WINDOW_MSGS === '1',
  } = opts;
  const padMs = messagePadH * HOUR_MS;

  // Idempotent: wipe only this script's outputs — photo-sourced events (NULL
  // source = rows from before the column existed, also ours). Inferred
  // 'messages' events belong to build-inferred-events.js and survive.
  await conn.run(`
    DELETE FROM event_photos WHERE event_id IN (SELECT event_id FROM events WHERE COALESCE(source, 'photos') = 'photos');
    DELETE FROM event_messages WHERE event_id IN (SELECT event_id FROM events WHERE COALESCE(source, 'photos') = 'photos');
    DELETE FROM events WHERE COALESCE(source, 'photos') = 'photos';
    DELETE FROM links WHERE link_type IN ('person_event', 'co_present_event');
  `);
  fs.mkdirSync(eventsDir, { recursive: true });
  for (const f of fs.readdirSync(eventsDir)) {
    if (/^evt_.*\.html$/.test(f)) fs.unlinkSync(path.join(eventsDir, f));
  }

  const photoRows = (await conn.runAndReadAll(`
    SELECT p.id, p.ts, p.asset_path, pl.lat, pl.lng, pl.place_name, pl.city
    FROM photos p LEFT JOIN places pl ON pl.photo_id = p.id
    ORDER BY p.ts
  `)).getRows().map(r => ({
    id: r[0], ts: Number(r[1]), asset_path: r[2], lat: r[3], lng: r[4], place_name: r[5] || r[6],
  }));

  const events = clusterEvents(photoRows, { timeGapHours, locationKm, minPhotos });
  console.log(`${photoRows.length} photos -> ${events.length} events`);

  const idLookup = {};
  for (const [cid, name] of (await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities`)).getRows()) {
    idLookup[cid] = name;
  }
  const georgeIds = new Set(
    (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user'`))
      .getRows().map(r => r[0]));

  let fbRows = [];
  try {
    fbRows = (await conn.runAndReadAll(`
      SELECT event_key, name, start_ts, lat, lng FROM fb_events
      WHERE response IN (${ATTENDED.map(esc).join(',')}) AND name IS NOT NULL AND start_ts IS NOT NULL
    `)).getRows().map(r => ({ event_key: r[0], name: r[1], start_ts: Number(r[2]), lat: r[3], lng: r[4] }));
  } catch {
    console.log('  (no fb_events table — skipping facebook naming)');
  }

  // Each fb event may name at most ONE cluster — its closest-by-start — else a
  // pre-party dinner and the party both take the party's name.
  const fbBest = new Map(); // event_key -> index of its best cluster
  events.forEach((ev, i) => {
    for (const f of fbRows) {
      if (f.start_ts < ev.start_ts - fbPadH * HOUR_MS || f.start_ts > ev.end_ts + fbPadH * HOUR_MS) continue;
      const delta = Math.abs(f.start_ts - ev.start_ts);
      const b = fbBest.get(f.event_key);
      if (!b || delta < b.delta) fbBest.set(f.event_key, { i, delta });
    }
  });

  let nNamed = 0, nMsgs = 0, nWithPeople = 0;
  await conn.run('BEGIN TRANSACTION');
  for (const [evIdx, ev] of events.entries()) {
    const photoIds = ev.photos.map(p => `'${p.id.replace(/'/g, "''")}'`).join(',');
    const participants = (await conn.runAndReadAll(
      `SELECT DISTINCT canonical_id FROM photo_faces WHERE photo_id IN (${photoIds})`)).getRows().map(r => r[0]);
    if (participants.length) nWithPeople++;

    // Messages: threads belonging to the people actually in the photos —
    // their DMs (thread_identity) and group chats they're in (group_membership).
    // Demo is excluded from the filter set (he's in most photos; his id
    // matches nothing useful). Events with no named faces get NO messages by
    // default: the old whole-window fallback attached up to 200 arbitrary
    // messages from every thread and presented them as being at the event.
    // EVENT_WINDOW_MSGS=1 restores it.
    const filterIds = participants.filter(id => !georgeIds.has(id));
    const startPad = ev.start_ts - padMs;
    const endPad = ev.end_ts + padMs;
    let msgs = [];
    if (filterIds.length || windowMsgs) {
      const list = filterIds.map(esc).join(',');
      const threadFilter = filterIds.length
        ? `AND thread_id IN (
             SELECT thread_id FROM thread_identity WHERE canonical_id IN (${list})
             UNION SELECT thread_id FROM group_membership WHERE canonical_id IN (${list}))`
        : '';
      msgs = (await conn.runAndReadAll(`
        SELECT id, ts, from_me, sender_name, body
        FROM messages
        WHERE meaningful AND ts BETWEEN ${startPad} AND ${endPad} ${threadFilter}
        ORDER BY ts
        LIMIT 200
      `)).getRows().map(r => ({
        id: r[0], ts: Number(r[1]), from_me: r[2], sender_name: r[3], body: r[4],
      }));
    }
    nMsgs += msgs.length;

    const places = (await conn.runAndReadAll(`
      SELECT place_name, city, COUNT(*) AS n FROM places WHERE photo_id IN (${photoIds})
      GROUP BY place_name, city ORDER BY n DESC LIMIT 1
    `)).getRows();
    const place_name = places.length ? (places[0][1] || places[0][0] || null) : null;

    // Facebook naming: an attended fb event starting inside the padded window,
    // preferring one within fbKm of the photo cluster's GPS center.
    const gps = ev.photos.filter(p => p.lat != null && p.lng != null);
    const center = gps.length
      ? { lat: gps.reduce((s, p) => s + p.lat, 0) / gps.length, lng: gps.reduce((s, p) => s + p.lng, 0) / gps.length }
      : null;
    const candidates = fbRows
      .filter(f => fbBest.get(f.event_key)?.i === evIdx)
      .map(f => ({ ...f, delta: Math.abs(f.start_ts - ev.start_ts) }));
    const picked = pickFbEvent(candidates, center, fbKm, fbTimeOnlyH * HOUR_MS);
    const summary = picked ? picked.fb.name : null;
    if (picked) nNamed++;

    const partsArr = `[${participants.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',')}]`;
    await conn.run(`
      INSERT INTO events (event_id, start_ts, end_ts, place_name, participants, n_photos, n_messages, summary, source, lat, lng)
      VALUES (${esc(ev.event_id)}, ${ev.start_ts}, ${ev.end_ts}, ${esc(place_name)}, ${partsArr}, ${ev.photos.length}, ${msgs.length}, ${esc(summary)}, 'photos', ${esc(center ? center.lat : null)}, ${esc(center ? center.lng : null)})
    `);
    for (const p of ev.photos) {
      await conn.run(`INSERT OR IGNORE INTO event_photos VALUES (${esc(ev.event_id)}, ${esc(p.id)})`);
    }
    for (const m of msgs) {
      await conn.run(`INSERT OR IGNORE INTO event_messages VALUES (${esc(ev.event_id)}, ${esc(m.id)})`);
    }

    const html = renderEventPage({
      event: { ...ev, place_name, participants, summary, summary_match: picked ? picked.match : null },
      photos: ev.photos,
      messages: msgs,
      idLookup,
    });
    fs.writeFileSync(path.join(eventsDir, `${ev.event_id}.html`), html);
  }
  await conn.run('COMMIT');

  // person_event: person -> event they appear at (related_label = event_id,
  // the mentioned_in_thread idiom), weight = photos with their face there.
  await conn.run(`
    INSERT INTO links (canonical_id, link_type, related_label, evidence, weight)
    SELECT pf.canonical_id, 'person_event', ep.event_id,
           'in ' || COUNT(*) || ' photos at ' || ep.event_id, COUNT(*)
    FROM event_photos ep JOIN photo_faces pf ON pf.photo_id = ep.photo_id
    GROUP BY pf.canonical_id, ep.event_id
  `);

  // co_present_event: person <-> person, both directions (shared_group idiom),
  // weight = distinct events both faces appear at.
  await conn.run(`
    WITH pe AS (
      SELECT DISTINCT ep.event_id, pf.canonical_id
      FROM event_photos ep JOIN photo_faces pf ON pf.photo_id = ep.photo_id
    )
    INSERT INTO links (canonical_id, link_type, related_canonical_id, related_label, evidence, weight)
    SELECT a.canonical_id, 'co_present_event', b.canonical_id, i.display_name,
           'physically co-present at ' || COUNT(DISTINCT a.event_id) || ' photo events',
           COUNT(DISTINCT a.event_id)
    FROM pe a
    JOIN pe b ON a.event_id = b.event_id AND a.canonical_id <> b.canonical_id
    JOIN identities i ON i.canonical_id = b.canonical_id
    GROUP BY a.canonical_id, b.canonical_id, i.display_name
  `);

  await renderIndexFromDb(conn, eventsDir);

  const linkCounts = (await conn.runAndReadAll(`
    SELECT link_type, COUNT(*) FROM links
    WHERE link_type IN ('person_event', 'co_present_event') GROUP BY 1 ORDER BY 1
  `)).getRows().map(r => `${r[0]}=${Number(r[1])}`).join(' ');
  console.log(`events=${events.length} with_people=${nWithPeople} fb_named=${nNamed} messages_linked=${nMsgs} ${linkCounts}`);
  return events.length;
}

// Index over ALL events (photo-clustered + message-inferred) straight from the
// table, so either builder can re-render it after its own run.
export async function renderIndexFromDb(conn, eventsDir) {
  const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
  const idLookup = {};
  for (const [cid, name] of (await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities`)).getRows()) {
    idLookup[cid] = name;
  }
  const rows = (await conn.runAndReadAll(`
    SELECT e.event_id, e.start_ts, e.end_ts, e.place_name, e.summary, e.participants,
           e.n_photos, e.n_messages, COALESCE(e.source, 'photos') AS source,
           (SELECT p.asset_path FROM event_photos ep JOIN photos p ON p.id = ep.photo_id
            WHERE ep.event_id = e.event_id ORDER BY p.ts LIMIT 1) AS thumb
    FROM events e ORDER BY e.start_ts DESC
  `)).getRows();
  const summaries = rows.map(r => ({
    event_id: r[0],
    start_ts: Number(r[1]),
    end_ts: Number(r[2]),
    place_name: r[3],
    summary: r[4],
    participants_names: unw(r[5]).map(p => idLookup[p] || p),
    n_photos: Number(r[6] ?? 0),
    n_messages: Number(r[7] ?? 0),
    source: r[8],
    thumb_path: r[9],
  }));
  fs.writeFileSync(path.join(eventsDir, 'index.html'), renderEventIndex(summaries));
  return summaries.length;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  await buildEvents(conn, { eventsDir: EVENTS_DIR });
  await conn.disconnectSync();
  console.log(`\nDone. http://127.0.0.1:8765/events/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
