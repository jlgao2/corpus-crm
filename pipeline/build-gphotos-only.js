#!/usr/bin/env node
/**
 * Standalone Google Photos ingester — loads ONLY gphotos sidecars and inserts
 * them into photos + places, then reverse-geocodes. Does NOT touch other photo
 * sources (additive; deletes only WHERE source='gphotos' for idempotency).
 *
 *   node pipeline/build-gphotos-only.js            # uses inputs/gphotos or social-media-archive/google
 *   GPHOTOS_BASE=/path node pipeline/build-gphotos-only.js
 *
 * This exists so Phase 4a can be verified on real data without the Apple
 * Photos / osxphotos dependency that the full build-photos.js requires.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { hashFile } from './normalize/photo-dedup.js';
import { loadGooglePhotos, findGooglePhotosRoots } from './ingest/google-photos.js';
import { reverseGeocodeAll } from './ingest/reverse-geocode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function resolveRoots() {
  const explicit = process.env.GPHOTOS_BASE;
  if (explicit) return findGooglePhotosRoots(explicit);
  const linked = path.join(ROOT, 'inputs', 'gphotos');
  if (fs.existsSync(linked)) {
    // inputs/gphotos may itself be a base dir of Takeout-* OR a dir of "Google Photos" roots
    const direct = findGooglePhotosRoots(linked);
    if (direct.length) return direct;
    if (fs.existsSync(path.join(linked, 'Google Photos'))) return [path.join(linked, 'Google Photos')];
  }
  return findGooglePhotosRoots(path.join(ROOT, '..', 'social-media-archive', 'google'));
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  const roots = resolveRoots();
  if (!roots.length) { console.error('No Google Photos roots found.'); process.exit(1); }
  console.log(`Roots: ${roots.length}`);

  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);

  const records = loadGooglePhotos(roots);

  // Idempotent for gphotos only: remove prior gphotos rows + their places.
  await conn.run(`DELETE FROM places WHERE photo_id IN (SELECT id FROM photos WHERE source='gphotos')`);
  await conn.run(`DELETE FROM photos WHERE source='gphotos'`);

  const HASH = process.env.GPHOTOS_HASH === '1'; // hashing 30k files is slow; off by default
  let withGps = 0;
  await conn.run('BEGIN TRANSACTION');
  for (const { photo, place } of records) {
    if (HASH && photo.asset_path && fs.existsSync(photo.asset_path)) {
      try { photo.hash_sha256 = await hashFile(photo.asset_path); } catch {}
    }
    await conn.run(`
      INSERT INTO photos (id, ts, ts_iso, source, source_ref, message_id, asset_path, width, height, hash_sha256, has_named_face)
      VALUES (${esc(photo.id)}, ${photo.ts}, ${esc(photo.ts_iso)}, ${esc(photo.source)}, ${esc(photo.source_ref)},
              ${esc(photo.message_id)}, ${esc(photo.asset_path)}, ${esc(photo.width)}, ${esc(photo.height)},
              ${esc(photo.hash_sha256)}, ${photo.has_named_face})
      ON CONFLICT DO NOTHING
    `);
    if (place && place.lat != null && place.lng != null) {
      withGps++;
      await conn.run(`INSERT OR IGNORE INTO places (photo_id, lat, lng) VALUES (${esc(photo.id)}, ${place.lat}, ${place.lng})`);
    }
  }
  await conn.run('COMMIT');
  console.log(`Inserted ${records.length} gphotos (${withGps} with GPS).`);

  // Reverse-geocode only the gphotos place coords.
  const coords = (await conn.runAndReadAll(`
    SELECT pl.lat, pl.lng FROM places pl JOIN photos p ON p.id = pl.photo_id WHERE p.source='gphotos'
  `)).getRows().map(r => ({ lat: r[0], lng: r[1] }));
  const geocoded = await reverseGeocodeAll(coords, conn);
  for (const [key, info] of geocoded.entries()) {
    const [lat, lng] = key.split(',').map(Number);
    await conn.run(`
      UPDATE places SET place_name = ${esc(info.place_name)}, city = ${esc(info.city)}, region = ${esc(info.region)}, country = ${esc(info.country)}
      WHERE ABS(lat - ${lat}) < 0.001 AND ABS(lng - ${lng}) < 0.001
    `);
  }
  console.log(`Reverse-geocoded ${geocoded.size} distinct gphotos coordinates.`);

  await conn.disconnectSync();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
