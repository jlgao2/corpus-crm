import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { computeField } from './field.js';

const Y = (y, m = 6) => Date.UTC(y, m, 15, 12);
const MEL = [-37.81, 144.96], TOKYO = [35.68, 139.69];

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR);
    CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT, place_name VARCHAR, participants VARCHAR[],
                         n_photos INTEGER, n_messages INTEGER, summary VARCHAR, source VARCHAR, lat DOUBLE, lng DOUBLE);
    CREATE TABLE event_photos (event_id VARCHAR, photo_id VARCHAR, PRIMARY KEY (event_id, photo_id));
    CREATE TABLE photos (id VARCHAR PRIMARY KEY, ts BIGINT, asset_path VARCHAR);
    CREATE TABLE photo_faces (photo_id VARCHAR, canonical_id VARCHAR, face_cluster VARCHAR, PRIMARY KEY (photo_id, canonical_id));

    INSERT INTO identities VALUES ('id-1','Demo User'), ('id-7','Maya Park'), ('id-9','Sam Fletcher');
    INSERT INTO events VALUES
      ('evt_home',  ${Y(2015)}, 'Melbourne', ['id-1','id-7','id-9'], 4, 2, NULL, 'photos', ${MEL[0]}, ${MEL[1]}),
      ('evt_trip',  ${Y(2015, 11)}, 'Tokyo', ['id-1','id-7'], 9, 0, 'Ginza night', 'photos', ${TOKYO[0]}, ${TOKYO[1]}),
      ('mevt_2016-03-01_x', ${Y(2016, 2)}, NULL, ['id-1','id-9'], 0, 12, 'coffee', 'messages', NULL, NULL);
    INSERT INTO photos VALUES ('p1', ${Y(2015)}, '/x/a.jpg'), ('p2', ${Y(2015)}, '/x/b.jpg'), ('p3', ${Y(2015, 11)}, '/x/t.jpg');
    INSERT INTO event_photos VALUES ('evt_home','p1'), ('evt_home','p2'), ('evt_trip','p3');
    -- Sam in 2 photos at evt_home, Maya in 1 -> Sam dominates despite array order.
    INSERT INTO photo_faces VALUES ('p1','id-9','c'), ('p2','id-9','c'), ('p1','id-7','c');
  `);
  return { conn };
}

test('computeField: deterministic layout with depth, bearing, and home-distance radius', async () => {
  const { conn } = await seed();
  const f = await computeField(conn);

  assert.deepEqual(f.years, [2015, 2016]);
  assert.equal(f.items.length, 3);
  const by = Object.fromEntries(f.items.map(i => [i.event_id, i]));

  const home = by['evt_home'], trip = by['evt_trip'], meet = by['mevt_2016-03-01_x'];
  assert.equal(home.yi, 0);
  assert.equal(meet.yi, 1);
  assert.equal(home.thumb, '/x/a.jpg', 'earliest photo is the face of the event');
  assert.equal(meet.thumb, null, 'inferred meetups have no thumb');

  assert.equal(home.person, 'id-9', 'dominant companion by face count, not array order');
  assert.equal(meet.person, 'id-9', 'inferred: first non-Demo participant');
  assert.equal(home.personName, 'Sam Fletcher');

  for (const i of f.items) {
    assert.ok(i.x >= -1 && i.x <= 1 && i.y >= -1 && i.y <= 1, 'unit-square coords');
  }
  assert.ok(trip.r > home.r, 'Tokyo sits farther out than home Melbourne');

  const again = await computeField(conn);
  assert.deepEqual(again.items, f.items, 'fully deterministic');
  await conn.disconnectSync();
});
