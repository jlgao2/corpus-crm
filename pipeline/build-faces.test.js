import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { doExport, doIngest } from './build-faces.js';

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceexp-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  await conn.run(`CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);`);
  await conn.run(`
    INSERT INTO photos (id, ts, ts_iso, source, asset_path, has_named_face) VALUES
      ('gphotos:A.jpg@100', 100000, '1970-01', 'gphotos', '/x/A.jpg', false),
      ('gphotos:B.jpg@200', 200000, '1970-01', 'gphotos', '/x/B.jpg', false),
      ('imsg:1', 300000, '1970-01', 'imessage', '/x/C.jpg', false);
    INSERT INTO places (photo_id, lat, lng, city, country) VALUES ('gphotos:A.jpg@100', 1.0, 2.0, 'Melbourne', 'Australia');
  `);
  return { dir, conn };
}

test('doExport writes only gphotos rows with place join', async () => {
  const { dir, conn } = await seed();
  const facesDir = path.join(dir, 'faces');
  await doExport(conn, facesDir);
  const lines = fs.readFileSync(path.join(facesDir, 'photos.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2, 'should export 2 gphotos rows, not the imessage one');
  const a = lines.find(l => l.photo_id === 'gphotos:A.jpg@100');
  assert.equal(a.asset_path, '/x/A.jpg');
  assert.equal(a.city, 'Melbourne');
  assert.equal(typeof a.ts, 'number');
  await conn.disconnectSync();
});

async function seedForIngest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceing-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  await conn.run(`CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);`);
  await conn.run(`
    INSERT INTO identities (canonical_id, display_name) VALUES ('id-7','Maya Park'), ('id-9','Mum');
    INSERT INTO photos (id, ts, ts_iso, source, asset_path, has_named_face) VALUES
      ('gphotos:A.jpg@100', 100, '70', 'gphotos', '/x/A.jpg', false),
      ('gphotos:B.jpg@200', 200, '70', 'gphotos', '/x/B.jpg', false);
  `);
  const facesDir = path.join(dir, 'faces'); fs.mkdirSync(facesDir, { recursive: true });
  fs.writeFileSync(path.join(facesDir, 'dets_clustered.jsonl'),
    [
      { det_id: 'gphotos:A.jpg@100#0', photo_id: 'gphotos:A.jpg@100', bbox: [0,0,1,1], det_score: 0.9, cluster_id: 0 },
      { det_id: 'gphotos:B.jpg@200#0', photo_id: 'gphotos:B.jpg@200', bbox: [0,0,1,1], det_score: 0.9, cluster_id: 0 },
      { det_id: 'gphotos:B.jpg@200#1', photo_id: 'gphotos:B.jpg@200', bbox: [2,2,3,3], det_score: 0.8, cluster_id: 1 },
    ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(facesDir, 'clusters.json'), JSON.stringify({ clusters: [
    { cluster_id: 0, n_faces: 2, exemplar_photo_ids: ['gphotos:A.jpg@100'] },
    { cluster_id: 1, n_faces: 1, exemplar_photo_ids: ['gphotos:B.jpg@200'] },
  ] }));
  fs.writeFileSync(path.join(facesDir, '..', 'face-labels.json'), JSON.stringify({ clusters: [
    { cluster_id: 0, label: 'Maya Park' },
    { cluster_id: 1, label: 'skip' },
  ] }));
  return { conn, facesDir, labelsPath: path.join(facesDir, '..', 'face-labels.json') };
}

test('doIngest resolves labeled clusters into photo_faces, leaves unlabeled out', async () => {
  const { conn, facesDir, labelsPath } = await seedForIngest();
  await doIngest(conn, facesDir, labelsPath);
  const pf = (await conn.runAndReadAll(`SELECT photo_id, canonical_id FROM photo_faces ORDER BY photo_id`)).getRows();
  assert.equal(pf.length, 2, 'two photos gain Maya');
  assert.deepEqual(pf.map(r => r[1]), ['id-7', 'id-7']);
  const dets = Number((await conn.runAndReadAll(`SELECT COUNT(*) FROM photo_face_dets`)).getRows()[0][0]);
  assert.equal(dets, 3, 'all detections recorded');
  const named = Number((await conn.runAndReadAll(`SELECT COUNT(*) FROM photos WHERE has_named_face`)).getRows()[0][0]);
  assert.equal(named, 2, 'has_named_face flipped for the two photos');
  const fc = (await conn.runAndReadAll(`SELECT cluster_id, canonical_id, label FROM face_clusters ORDER BY cluster_id`)).getRows();
  assert.equal(fc[0][1], 'id-7'); assert.equal(fc[1][1], null);
  await doIngest(conn, facesDir, labelsPath);
  const pf2 = Number((await conn.runAndReadAll(`SELECT COUNT(*) FROM photo_faces`)).getRows()[0][0]);
  assert.equal(pf2, 2, 'idempotent');
  await conn.disconnectSync();
});

test('doIngest re-run with changed labels reflects new state (wipe + has_named_face reset)', async () => {
  const { conn, facesDir, labelsPath } = await seedForIngest();
  await doIngest(conn, facesDir, labelsPath);   // cluster0=Maya Park, cluster1=skip
  // relabel: cluster 0 -> skip, cluster 1 -> Mum (id-9)
  fs.writeFileSync(labelsPath, JSON.stringify({ clusters: [
    { cluster_id: 0, label: 'skip' },
    { cluster_id: 1, label: 'Mum' },
  ] }));
  await doIngest(conn, facesDir, labelsPath);
  const pf = (await conn.runAndReadAll(`SELECT photo_id, canonical_id FROM photo_faces ORDER BY photo_id`)).getRows();
  assert.equal(pf.length, 1, 'only B->Mum remains after relabel (proves the wipe ran)');
  assert.deepEqual(pf[0], ['gphotos:B.jpg@200', 'id-9']);
  const namedCount = Number((await conn.runAndReadAll(`SELECT COUNT(*) FROM photos WHERE source='gphotos' AND has_named_face`)).getRows()[0][0]);
  assert.equal(namedCount, 1, 'A must be reset to has_named_face=false; only B remains true');
  const fcMap = new Map((await conn.runAndReadAll(`SELECT cluster_id, canonical_id FROM face_clusters`)).getRows().map(r => [Number(r[0]), r[1]]));
  assert.equal(fcMap.get(0), null, 'cluster 0 now unlabeled');
  assert.equal(fcMap.get(1), 'id-9', 'cluster 1 now Mum');
  await conn.disconnectSync();
});
