#!/usr/bin/env node
// Upsert partiful events (inputs/partiful/events.jsonl) into the duckdb
// events table. Idempotent: deletes source='partiful' rows and reinserts
// from the jsonl. start_ts is the invite email's timestamp — a placeholder
// until the parser learns real event-time formats from live samples; the
// summary carries kind/host/url so nothing is lost.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { renderEventPage } from './render/event-page.js';
import { renderIndexFromDb } from './build-events.js';
import { geocodePlace, RATE_LIMIT_MS } from './ingest/reverse-geocode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const JSONL = path.join(__dirname, '..', 'inputs', 'partiful', 'events.jsonl');
const GUESTS_JSONL = path.join(__dirname, '..', 'inputs', 'partiful', 'guests.jsonl');
const EVENTS_DIR = process.env.EVENTS_DIR || path.join(__dirname, 'output', 'events');
const GEO_CACHE = path.join(__dirname, 'output', 'inferred-events', 'geocode-cache.json');

if (!fs.existsSync(JSONL)) {
  console.log('[partiful] no events.jsonl — nothing to build');
  process.exit(0);
}

const byId = new Map();
const rank = (kind) => (kind === 'page' ? 2 : kind === 'invite' ? 1 : 0);
for (const line of fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean)) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  const cur = byId.get(e.event_id);
  // page-scraped entries carry real start/end times and beat email guesses
  if (!cur || rank(e.kind) > rank(cur.kind) || (rank(e.kind) === rank(cur.kind) && e.email_ts > cur.email_ts)) {
    byId.set(e.event_id, { ...cur, ...e });
  }
}

// Authed page detail (hosts, venue, attended counts) from partiful-guests.js.
// The public payload has none of it: hosts is null when logged out.
const detail = new Map();
if (fs.existsSync(GUESTS_JSONL)) {
  for (const line of fs.readFileSync(GUESTS_JSONL, 'utf8').split('\n').filter(Boolean)) {
    try { const d = JSON.parse(line); detail.set(d.event_id, d); } catch { /* skip */ }
  }
}

const inst = await DuckDBInstance.create(DB_PATH);
const con = await inst.connect();
await con.run(`DELETE FROM events WHERE source = 'partiful'`);

// participants must hold canonical_ids like every other builder — a raw host
// name never matches list_contains, so the person would appear nowhere.
const nameToCid = new Map(
  (await con.runAndReadAll(`SELECT canonical_id, display_name FROM identities WHERE display_name IS NOT NULL`))
    .getRows().map(([cid, nm]) => [String(nm).toLowerCase(), cid]));

fs.mkdirSync(EVENTS_DIR, { recursive: true });
for (const f of fs.readdirSync(EVENTS_DIR)) {
  if (/^partiful.*\.html$/.test(f)) fs.unlinkSync(path.join(EVENTS_DIR, f));
}

// Venue → coords, reusing the meetup geocode cache (same key shape) so a
// venue already resolved there costs nothing and nothing re-hits Nominatim
// without need.
let geo = {};
if (fs.existsSync(GEO_CACHE)) { try { geo = JSON.parse(fs.readFileSync(GEO_CACHE, 'utf8')); } catch { /* ignore */ } }
let geoDirty = false;

let n = 0, nHost = 0, nGeo = 0, nRestricted = 0, nInviter = 0;
for (const e of byId.values()) {
  const d = detail.get(e.event_id) || {};
  const startTs = e.start_ts ?? e.email_ts;
  const endTs = Math.trunc(e.end_ts ?? startTs + 3 * 3600_000);

  // Hosts: the authed page is the only place they exist. Resolve each to an
  // identity; unresolved names still show on the page, they just can't link.
  const hostNames = d.hosts?.length ? d.hosts : (e.host ? [e.host] : []);
  const hostCids = [], idLookup = {};
  for (const h of hostNames) {
    const cid = nameToCid.get(String(h).toLowerCase());
    if (cid && !hostCids.includes(cid)) { hostCids.push(cid); idLookup[cid] = h; }
  }
  if (hostCids.length) nHost++;

  // Partiful is SMS-first: the invite arrived as a text, so whoever sent the
  // link is a real, already-resolved connection to this event — often the
  // host under a nickname the scrape can't match. Weaker claim than "host",
  // so it's recorded as invited-by, but it still belongs in participants.
  const raw = e.event_id.replace(/^partiful:/, '').replace(/'/g, "''");
  const inv = (await con.runAndReadAll(`
    SELECT ti.canonical_id, i.display_name, COUNT(*) n
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN identities i ON i.canonical_id = ti.canonical_id
    WHERE m.body LIKE '%${raw}%' AND NOT m.from_me
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 1`)).getRows();
  let inviterName = null;
  if (inv.length) {
    const [cid, name] = inv[0];
    inviterName = name;
    if (!hostCids.includes(cid)) { hostCids.push(cid); idLookup[cid] = name; nInviter++; }
  }

  const venue = d.venue && !/^Private Location$/i.test(d.venue) ? d.venue : null;
  let coords = null;
  if (venue) {
    const key = `PARTIFUL|${venue.toLowerCase()}`;
    if (!(key in geo)) {
      try {
        const hit = await geocodePlace(venue, {});
        geo[key] = hit ? { lat: hit.lat, lng: hit.lng } : null;
        geoDirty = true;
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
      } catch { /* transient — retried next run, not cached */ }
    }
    if (geo[key]) { coords = geo[key]; nGeo++; }
  }
  if (d.restricted) nRestricted++;

  // Detail lines live on the event page; summary stays the clean name so
  // index cards and person pages read as a title, not a joined blob.
  const details = [];
  if (hostNames.length) details.push(`hosted by ${hostNames.join(', ')}`);
  if (inviterName) details.push(`invite texted by ${inviterName}`);
  if (d.venue) details.push(d.venue);
  if (d.went != null) details.push(`${d.went} went${d.maybe != null ? ` · ${d.maybe} maybe` : ''}`);
  else if (e.going != null) details.push(`${e.going} going`);
  if (e.status && e.status !== 'PUBLISHED') details.push(e.status.toLowerCase());
  if (d.restricted) details.push('guest list restricted by the host — attendees not recorded');

  // Escaped literals, not binds — node-api can't type bare nulls or [].
  const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const participants = hostCids.length ? `[${hostCids.map(esc).join(',')}]` : '[]::VARCHAR[]';
  await con.run(
    `INSERT INTO events (event_id, start_ts, end_ts, place_name, participants, n_photos, n_messages, summary, source, lat, lng)
     VALUES (${esc(e.event_id)}, ${Math.trunc(startTs)}, ${endTs}, ${esc(venue)}, ${participants}, 0, 0, ${esc(e.name)}, 'partiful', ${coords ? coords.lat : 'NULL'}, ${coords ? coords.lng : 'NULL'})`,
  );

  fs.writeFileSync(path.join(EVENTS_DIR, `${e.event_id}.html`), renderEventPage({
    event: { event_id: e.event_id, start_ts: startTs, end_ts: endTs, summary: e.name,
             place_name: venue, participants: hostCids, details, url: e.url },
    photos: [], messages: [], idLookup,
  }));
  n++;
}
if (geoDirty) { fs.mkdirSync(path.dirname(GEO_CACHE), { recursive: true }); fs.writeFileSync(GEO_CACHE, JSON.stringify(geo, null, 1)); }

await renderIndexFromDb(con, EVENTS_DIR);
con.closeSync();
inst.closeSync();
console.log(`[partiful] upserted ${n} events · ${nHost} with hosts resolved to identities · ${nGeo} geotagged · ${nInviter} linked via the inviter who texted the link · ${nRestricted} guest-list restricted · pages + index rendered`);
