#!/usr/bin/env node
/**
 * Photos layer orchestrator.
 *
 *   npm run build-photos
 *
 * Reads Apple Photos library (via osxphotos), iMessage attachments, and
 * Instagram exports. Hashes, dedupes, populates photos/photo_faces/places
 * tables. Clusters events. Reverse-geocodes. Renders HTML.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { mergeDuplicates, hashFile, canonicalIdFor } from './normalize/photo-dedup.js';
import { loadAppleLibraryMetadata, normalizeApplePhoto, resolveFaces } from './ingest/apple-photos.js';
import { loadIMessageAttachments, loadInstagramAttachments } from './ingest/message-attachments.js';
import { loadGooglePhotos, findGooglePhotosRoots } from './ingest/google-photos.js';
import { reverseGeocodeAll } from './ingest/reverse-geocode.js';
import { clusterEvents } from './analyze/events.js';
import { renderEventPage } from './render/event-page.js';
import { renderEventIndex } from './render/event-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const EVENTS_DIR = path.join(__dirname, 'output', 'events');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function main() {
  ensureDir(EVENTS_DIR);

  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }

  console.log('Opening DuckDB...');
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);

  // ─── Stage 1: Apple Photos ───────────────────────────────────────────────
  console.log('\n[1/6] Reading Apple Photos library...');
  let appleRecords = [];
  try {
    appleRecords = await loadAppleLibraryMetadata();
    console.log(`  ${appleRecords.length} records`);
  } catch (err) {
    console.error(`  Apple Photos: ${err.message}`);
  }

  // ─── Stage 2: Message attachments ────────────────────────────────────────
  console.log('\n[2/6] Walking message attachments...');
  let imsgPhotos = await loadIMessageAttachments(conn);
  console.log(`  iMessage: ${imsgPhotos.length}`);

  // Find IG export dir
  const igCandidates = fs.readdirSync(ROOT).filter(d =>
    d.startsWith('instagram-') && fs.statSync(path.join(ROOT, d)).isDirectory()
  );
  let igPhotos = [];
  if (igCandidates.length) {
    igPhotos = await loadInstagramAttachments(path.join(ROOT, igCandidates.sort().reverse()[0]));
    console.log(`  Instagram: ${igPhotos.length}`);
  }

  // Google Photos (Takeout sidecars). Base dir: inputs/gphotos or the archive.
  let gPhotos = [];
  {
    const base = fs.existsSync(path.join(ROOT, 'inputs', 'gphotos'))
      ? path.join(ROOT, 'inputs', 'gphotos')
      : path.join(ROOT, '..', 'social-media-archive', 'google');
    let roots = findGooglePhotosRoots(base);
    if (!roots.length && fs.existsSync(path.join(base, 'Google Photos'))) roots = [path.join(base, 'Google Photos')];
    if (roots.length) {
      gPhotos = loadGooglePhotos(roots);
      console.log(`  Google Photos: ${gPhotos.length}`);
    }
  }

  // ─── Stage 3: Normalize + dedup ──────────────────────────────────────────
  console.log('\n[3/6] Normalizing and deduping...');
  const allRows = [];
  for (const a of appleRecords) {
    const { photo, faces, place } = normalizeApplePhoto(a);
    if (photo.asset_path && fs.existsSync(photo.asset_path)) {
      try { photo.hash_sha256 = await hashFile(photo.asset_path); } catch {}
    }
    allRows.push({ photo, faces, place });
  }
  for (const item of imsgPhotos) allRows.push(item);
  for (const item of igPhotos) allRows.push(item);
  for (const item of gPhotos) allRows.push(item);

  const merged = mergeDuplicates(allRows.map(r => r.photo));
  console.log(`  ${allRows.length} → ${merged.length} after dedup`);

  // Index original rows by id so we can look up faces/place after merging
  const originalById = new Map();
  for (const item of allRows) originalById.set(item.photo.id, item);

  // ─── Stage 4: Insert ──────────────────────────────────────────────────────
  console.log('\n[4/6] Inserting into DuckDB...');
  // Wipe existing photos tables for a clean rebuild — incremental insertion
  // is a future improvement.
  await conn.run(`
    DELETE FROM photos;
    DELETE FROM photo_faces;
    DELETE FROM places;
    DELETE FROM event_photos WHERE event_id IN (SELECT event_id FROM events WHERE COALESCE(source, 'photos') = 'photos');
    DELETE FROM event_messages WHERE event_id IN (SELECT event_id FROM events WHERE COALESCE(source, 'photos') = 'photos');
    DELETE FROM events WHERE COALESCE(source, 'photos') = 'photos';
  `);

  for (const m of merged) {
    await conn.run(`
      INSERT INTO photos (id, ts, ts_iso, source, source_ref, message_id, asset_path, width, height, hash_sha256, has_named_face)
      VALUES (
        ${esc(m.id)}, ${m.ts}, ${esc(m.ts_iso)}, ${esc(m.source)}, ${esc(m.source_ref)},
        ${esc(m.message_id)}, ${esc(m.asset_path)}, ${esc(m.width)}, ${esc(m.height)},
        ${esc(m.hash_sha256)}, ${m.has_named_face}
      )
    `);
  }
  console.log(`  inserted ${merged.length} photos`);

  // Faces
  const idsReader = await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities WHERE display_name IS NOT NULL`);
  const nameToCanonical = new Map();
  for (const [cid, name] of idsReader.getRows()) {
    nameToCanonical.set(String(name).toLowerCase(), cid);
  }
  const allFaceRows = [];
  for (const item of allRows) {
    for (const name of item.faces) {
      allFaceRows.push({ photo_id: item.photo.id, name });
    }
  }
  const { matched, unmatched } = resolveFaces(allFaceRows, nameToCanonical);
  for (const f of matched) {
    await conn.run(`INSERT OR IGNORE INTO photo_faces VALUES (${esc(f.photo_id)}, ${esc(f.canonical_id)}, ${esc(f.face_cluster)})`);
  }
  console.log(`  faces: ${matched.length} matched, ${unmatched.length} unmatched`);
  if (unmatched.length) {
    console.log(`  unmatched names (${unmatched.length}): ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? '...' : ''}`);
    console.log(`    → either rename in Photos.app or add as alias in your contacts.vcf and rerun`);
  }

  // Places (lat/lng only at this stage; reverse geocode later)
  for (const item of allRows) {
    if (item.place && item.place.lat != null && item.place.lng != null) {
      await conn.run(`INSERT OR IGNORE INTO places (photo_id, lat, lng) VALUES (${esc(item.photo.id)}, ${item.place.lat}, ${item.place.lng})`);
    }
  }

  // ─── Stage 5: Reverse geocode + cluster events ───────────────────────────
  console.log('\n[5/6] Reverse-geocoding places...');
  const allPlaceCoords = (await conn.runAndReadAll(`SELECT lat, lng FROM places`)).getRows().map(r => ({ lat: r[0], lng: r[1] }));
  const geocoded = await reverseGeocodeAll(allPlaceCoords, conn);
  // Update places with resolved names
  for (const [key, info] of geocoded.entries()) {
    const [lat, lng] = key.split(',').map(Number);
    await conn.run(`
      UPDATE places SET place_name = ${esc(info.place_name)}, city = ${esc(info.city)}, region = ${esc(info.region)}, country = ${esc(info.country)}
      WHERE ABS(lat - ${lat}) < 0.001 AND ABS(lng - ${lng}) < 0.001
    `);
  }

  console.log('\n[6/6] Clustering events and rendering HTML...');
  const photoRows = (await conn.runAndReadAll(`
    SELECT p.id, p.ts, p.asset_path, pl.lat, pl.lng, pl.place_name, pl.city
    FROM photos p
    LEFT JOIN places pl ON pl.photo_id = p.id
    ORDER BY p.ts
  `)).getRows().map(r => ({
    id: r[0], ts: Number(r[1]), asset_path: r[2], lat: r[3], lng: r[4], place_name: r[5] || r[6],
  }));

  const events = clusterEvents(photoRows, {
    timeGapHours: parseFloat(process.env.EVENT_TIME_GAP_H || '6'),
    locationKm: parseFloat(process.env.EVENT_LOCATION_KM || '1'),
    minPhotos: parseInt(process.env.EVENT_MIN_PHOTOS || '3', 10),
  });
  console.log(`  ${events.length} events`);

  // Insert events + render pages
  const messagePadH = parseFloat(process.env.EVENT_MESSAGE_PADDING_H || '12');
  const padMs = messagePadH * 3600 * 1000;

  // Identity map for participant labels
  const idLookup = {};
  const idRows = (await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities`)).getRows();
  for (const [cid, name] of idRows) idLookup[cid] = name;

  const eventSummaries = [];
  for (const ev of events) {
    // Find faces present in this event's photos
    const photoIds = ev.photos.map(p => `'${p.id.replace(/'/g, "''")}'`).join(',');
    const faceRows = (await conn.runAndReadAll(`SELECT DISTINCT canonical_id FROM photo_faces WHERE photo_id IN (${photoIds})`)).getRows();
    const participants = faceRows.map(r => r[0]);

    // Find messages within the event's time window
    const startPad = ev.start_ts - padMs;
    const endPad = ev.end_ts + padMs;
    const msgs = (await conn.runAndReadAll(`
      SELECT id, ts, from_me, sender_name, body
      FROM messages
      WHERE meaningful AND ts BETWEEN ${startPad} AND ${endPad}
      ORDER BY ts
      LIMIT 200
    `)).getRows().map(r => ({
      id: r[0], ts: Number(r[1]), from_me: r[2], sender_name: r[3], body: r[4],
    }));

    // Place name from majority of cluster's places
    const places = (await conn.runAndReadAll(`
      SELECT place_name, city, COUNT(*) AS n FROM places WHERE photo_id IN (${photoIds})
      GROUP BY place_name, city ORDER BY n DESC LIMIT 1
    `)).getRows();
    const place_name = places.length ? (places[0][1] || places[0][0] || null) : null;

    // Insert event row
    const partsArr = `[${participants.map(p => `'${p}'`).join(',')}]`;
    await conn.run(`
      INSERT INTO events (event_id, start_ts, end_ts, place_name, participants, n_photos, n_messages)
      VALUES (${esc(ev.event_id)}, ${ev.start_ts}, ${ev.end_ts}, ${esc(place_name)}, ${partsArr}, ${ev.photos.length}, ${msgs.length})
    `);
    for (const p of ev.photos) {
      await conn.run(`INSERT OR IGNORE INTO event_photos VALUES (${esc(ev.event_id)}, ${esc(p.id)})`);
    }
    for (const m of msgs) {
      await conn.run(`INSERT OR IGNORE INTO event_messages VALUES (${esc(ev.event_id)}, ${esc(m.id)})`);
    }

    // Render page
    const html = renderEventPage({
      event: { ...ev, place_name, participants },
      photos: ev.photos,
      messages: msgs,
      idLookup,
    });
    fs.writeFileSync(path.join(EVENTS_DIR, `${ev.event_id}.html`), html);

    eventSummaries.push({
      event_id: ev.event_id,
      start_ts: ev.start_ts,
      end_ts: ev.end_ts,
      place_name,
      participants_names: participants.map(p => idLookup[p] || p),
      n_photos: ev.photos.length,
      n_messages: msgs.length,
      thumb_path: ev.photos[0]?.asset_path || null,
    });
  }

  // Render index
  const indexHtml = renderEventIndex(eventSummaries);
  fs.writeFileSync(path.join(EVENTS_DIR, 'index.html'), indexHtml);

  await conn.disconnectSync();
  console.log(`\nDone. Open pipeline/output/events/index.html in a browser.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
