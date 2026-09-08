import fs from 'fs';
import path from 'path';
import { fixMojibake } from '../normalize/schema.js';

const RANK = { hosted: 6, ticket: 5, created: 4, joined: 3, interested: 2, invited: 1, declined: 0 };
const toMs = s => (s != null && Number(s) > 0) ? Number(s) * 1000 : null;
const fix = s => s ? fixMojibake(String(s)) : null;

export function findEventsDir(fbRoot) {
  if (!fbRoot || !fs.existsSync(fbRoot)) return null;
  for (const entry of fs.readdirSync(fbRoot)) {
    const d = path.join(fbRoot, entry, 'your_facebook_activity', 'events');
    if (fs.existsSync(d)) return d;
  }
  const direct = path.join(fbRoot, 'your_facebook_activity', 'events');
  if (fs.existsSync(direct)) return direct;
  if (fs.existsSync(path.join(fbRoot, 'your_event_responses.json'))) return fbRoot;
  return null;
}

function normEvent(e, response, extra = {}) {
  const place = e.place || {};
  const coord = place.coordinate || {};
  return {
    fbid: e.fbid || extra.fbid || null,
    name: fix(e.name || e.title || extra.name) || '',
    start_ts: toMs(e.start_timestamp ?? e.timestamp ?? extra.timestamp),
    end_ts: toMs(e.end_timestamp),
    place_name: fix(place.name),
    lat: coord.latitude ?? null,
    lng: coord.longitude ?? null,
    address: fix(place.address),
    description: fix(e.description),
    response,
    response_time: toMs(e.response_time ?? e.create_timestamp),
  };
}

export function loadFacebookEvents(fbRoot) {
  const dir = findEventsDir(fbRoot);
  if (!dir) { console.warn(`[fb-events] no events dir under ${fbRoot}`); return []; }
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); } catch { return null; } };
  const raw = [];
  const resp = read('your_event_responses.json');
  if (resp && resp.event_responses_v2) {
    for (const [bucket, r] of [['events_joined', 'joined'], ['events_interested', 'interested'], ['events_declined', 'declined']])
      for (const e of (resp.event_responses_v2[bucket] || [])) raw.push(normEvent(e, r));
  }
  for (const e of (read('event_invitations.json')?.events_invited_v2 || [])) raw.push(normEvent(e, 'invited'));
  for (const e of (read('your_events.json')?.your_events_v2 || [])) raw.push(normEvent(e, 'created'));
  const hosted = read('events_you_hosted.json');
  for (const e of (Array.isArray(hosted) ? hosted : [])) raw.push(normEvent(e, 'hosted'));
  const tk = read('tickets_purchased.json');
  for (const e of (Array.isArray(tk) ? tk : (tk ? [tk] : []))) {
    const dicts = (e.label_values || []).flatMap(l => l.dict || []).flatMap(l => l.dict || []);
    const name = dicts.find(l => l.label === 'Name')?.value;
    const startTs = dicts.find(l => l.label === 'Start time')?.timestamp_value;
    if (!name) continue;
    raw.push(normEvent({ ...e, start_timestamp: startTs }, 'ticket', { name }));
  }
  const key = e => e.fbid || `${(e.name || '').trim().toLowerCase()}|${e.start_ts}`;
  const best = new Map();
  for (const e of raw) {
    if (!e.name && !e.fbid) continue;
    const k = key(e);
    const prev = best.get(k);
    if (!prev) { best.set(k, e); continue; }
    const winner = RANK[e.response] >= RANK[prev.response] ? e : prev;
    const other = winner === e ? prev : e;
    winner.place_name = winner.place_name || other.place_name;
    winner.lat = winner.lat ?? other.lat; winner.lng = winner.lng ?? other.lng;
    winner.address = winner.address || other.address;
    winner.description = winner.description || other.description;
    best.set(k, winner);
  }
  return [...best.values()];
}
