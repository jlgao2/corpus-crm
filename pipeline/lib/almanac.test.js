import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { compileYear } from './almanac.js';

// 2015 in UTC ms.
const Y = (y, m = 6) => Date.UTC(y, m, 15, 12);

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR);
    CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT, end_ts BIGINT, place_name VARCHAR,
                         participants VARCHAR[], n_photos INTEGER, n_messages INTEGER, summary VARCHAR,
                         source VARCHAR, lat DOUBLE, lng DOUBLE);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, thread_id VARCHAR, from_me BOOLEAN, meaningful BOOLEAN);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);
    CREATE TABLE photos (id VARCHAR PRIMARY KEY, ts BIGINT, source VARCHAR);

    INSERT INTO identities VALUES
      ('id-1', 'Demo User'), ('id-7', 'Maya Park'), ('id-9', 'Sam Fletcher'), ('id-11', 'New Nina'), ('id-13', 'Lapsed Lou');

    -- 2014: Lou present (so he can lapse in 2015). 2015: Maya 2x, Sam 1x, Nina 1x (first ever).
    INSERT INTO events VALUES
      ('evt_2014_lou', ${Y(2014)}, ${Y(2014) + 3600000}, 'Melbourne', ['id-1','id-13'], 5, 0, NULL, 'photos', -37.8, 144.96),
      ('evt_2014_bec', ${Y(2014, 8)}, ${Y(2014, 8) + 3600000}, 'Melbourne', ['id-1','id-7','id-9'], 3, 0, NULL, 'photos', -37.8, 144.96),
      ('evt_2015_a',   ${Y(2015, 2)}, ${Y(2015, 2) + 3600000}, 'Melbourne', ['id-1','id-7','id-9'], 12, 3, 'Beach Day', 'photos', -37.8, 144.96),
      ('evt_2015_b',   ${Y(2015, 5)}, ${Y(2015, 5) + 3600000}, 'Melbourne', ['id-1','id-7'], 4, 1, NULL, 'photos', -37.9, 145.1),
      ('mevt_2015-08-15_x', ${Y(2015, 7)}, ${Y(2015, 7) + 3600000}, NULL, ['id-1','id-11'], 0, 9, 'first hang', 'messages', NULL, NULL);

    INSERT INTO thread_identity VALUES ('th-b', 'id-7'), ('th-d', 'id-9');
    INSERT INTO messages VALUES
      ('m1', ${Y(2015, 1)}, 'th-b', true,  true),
      ('m2', ${Y(2015, 1)}, 'th-b', false, true),
      ('m3', ${Y(2015, 3)}, 'th-b', true,  true),
      ('m4', ${Y(2015, 3)}, 'th-d', false, true),
      ('m5', ${Y(2015, 3)}, 'th-d', false, false),
      ('m6', ${Y(2014, 3)}, 'th-b', true,  true);

    INSERT INTO photos VALUES ('p1', ${Y(2015, 2)}, 'gphotos'), ('p2', ${Y(2015, 2)}, 'gphotos'), ('p3', ${Y(2014)}, 'gphotos');
  `);
  return { conn };
}

test('compileYear assembles the almanac for one year', async () => {
  const { conn } = await seed();
  const a = await compileYear(conn, 2015);

  assert.equal(a.year, 2015);
  assert.equal(a.counts.events, 3, 'two photo events + one inferred meetup');
  assert.equal(a.counts.inferred, 1);
  assert.equal(a.counts.messages, 4, 'meaningful 2015 messages only');
  assert.equal(a.counts.photos, 2);
  assert.equal(a.counts.people, 3, 'Maya, Sam, Nina — Demo excluded');

  assert.deepEqual(a.mostSeen[0], { canonical_id: 'id-7', name: 'Maya Park', events: 2 });
  assert.equal(a.mostSeen.length, 3);

  assert.deepEqual(a.newFaces.map(p => p.name), ['New Nina'], 'first-ever presence in 2015');
  assert.deepEqual(a.lapsed.map(p => p.name), ['Lapsed Lou'], 'present 2014, absent 2015');

  assert.equal(a.topPlaces[0].place, 'Melbourne');

  // Concentration: 3 msgs with Maya, 1 with Sam -> top-1 person covers 75%.
  assert.equal(a.concentration.totalPeople, 2);
  assert.equal(a.concentration.top1Share, 0.75);

  assert.equal(a.months.length, 12);
  assert.equal(a.months.reduce((s, m) => s + m, 0), 3, 'events by month');

  assert.equal(a.biggestEvent.event_id, 'evt_2015_a');
  await conn.disconnectSync();
});

test('compileYear on an empty year returns zeroes, not errors', async () => {
  const { conn } = await seed();
  const a = await compileYear(conn, 2011);
  assert.equal(a.counts.events, 0);
  assert.deepEqual(a.mostSeen, []);
  assert.deepEqual(a.newFaces, []);
  assert.equal(a.biggestEvent, null);
  await conn.disconnectSync();
});
