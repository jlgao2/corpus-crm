import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './photo-schema.js';

test('ensurePhotoSchema creates photo_face_dets and face_clusters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceschema-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  const names = (await conn.runAndReadAll(
    `SELECT table_name FROM information_schema.tables`)).getRows().map(r => r[0]);
  assert.ok(names.includes('photo_face_dets'), 'photo_face_dets missing');
  assert.ok(names.includes('face_clusters'), 'face_clusters missing');
  const cols = (await conn.runAndReadAll(
    `SELECT column_name FROM information_schema.columns WHERE table_name='face_clusters'`)).getRows().map(r => r[0]);
  for (const c of ['cluster_id', 'n_faces', 'canonical_id', 'label', 'exemplar_photo_ids'])
    assert.ok(cols.includes(c), `face_clusters.${c} missing`);
  await conn.disconnectSync();
});

test('ensurePhotoSchema adds events.source (also on pre-existing events tables)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceschema-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  // Simulate a DB whose events table predates the source column.
  await conn.run(`CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT NOT NULL, end_ts BIGINT NOT NULL, place_name VARCHAR, participants VARCHAR[], n_photos INTEGER, n_messages INTEGER, summary VARCHAR);`);
  await ensurePhotoSchema(conn);
  const cols = (await conn.runAndReadAll(
    `SELECT column_name FROM information_schema.columns WHERE table_name='events'`)).getRows().map(r => r[0]);
  assert.ok(cols.includes('source'), 'events.source missing');
  assert.ok(cols.includes('lat'), 'events.lat missing');
  assert.ok(cols.includes('lng'), 'events.lng missing');
  await conn.disconnectSync();
});
