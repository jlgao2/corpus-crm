import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { personSeries } from './person-series.js';

const Y = (y, m = 6) => Date.UTC(y, m, 15, 12);

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pseries-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT, participants VARCHAR[], source VARCHAR);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, thread_id VARCHAR, meaningful BOOLEAN);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);

    -- Met 2012, quiet 2013-2015 (messages only in 2014), resurfaced 2016.
    INSERT INTO events VALUES
      ('e1', ${Y(2012)}, ['id-1','id-7'], 'photos'),
      ('e2', ${Y(2016)}, ['id-1','id-7'], 'messages'),
      ('e3', ${Y(2016, 9)}, ['id-1','id-7'], 'photos'),
      ('e4', ${Y(2014)}, ['id-1','id-9'], 'photos');
    INSERT INTO thread_identity VALUES ('th-b', 'id-7');
    INSERT INTO messages VALUES
      ('m1', ${Y(2012)}, 'th-b', true),
      ('m2', ${Y(2014)}, 'th-b', true),
      ('m3', ${Y(2014, 8)}, 'th-b', true),
      ('m4', ${Y(2016)}, 'th-b', false);
  `);
  return { conn };
}

test('personSeries: continuous year series with events, messages, and the gap story', async () => {
  const { conn } = await seed();
  const s = await personSeries(conn, 'id-7');

  assert.equal(s.firstYear, 2012);
  assert.deepEqual(s.series.map(r => r.year), [2012, 2013, 2014, 2015, 2016], 'first event year through latest corpus year');
  const by = Object.fromEntries(s.series.map(r => [r.year, r]));
  assert.deepEqual([by[2012].events, by[2012].messages], [1, 1]);
  assert.deepEqual([by[2013].events, by[2013].messages], [0, 0]);
  assert.deepEqual([by[2014].events, by[2014].messages], [0, 2], 'messages without meeting');
  assert.deepEqual([by[2016].events, by[2016].messages], [2, 0], 'meaningful filter drops m4');

  assert.equal(s.gap.from, 2013, 'longest event-less stretch starts after the first met year');
  assert.equal(s.gap.to, 2015);
  assert.equal(s.resurfacedYear, 2016, 'first event year after the longest gap');
  await conn.disconnectSync();
});

test('personSeries: person with no events returns null', async () => {
  const { conn } = await seed();
  assert.equal(await personSeries(conn, 'id-999'), null);
  await conn.disconnectSync();
});
