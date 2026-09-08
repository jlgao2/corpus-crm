import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { computeBraid } from './braid.js';

const Y = (y, m = 6) => Date.UTC(y, m, 15, 12);

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'braid-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR);
    CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT, participants VARCHAR[], source VARCHAR);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, thread_id VARCHAR, meaningful BOOLEAN);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);

    INSERT INTO identities VALUES ('id-1','Demo User'), ('id-7','Maya Park'), ('id-9','Sam Fletcher'), ('id-11','Quiet Quinn');

    -- Maya: events in 2014+2016, absent 2015. Sam: 2015 only. Quinn: messages only, never met.
    INSERT INTO events VALUES
      ('e1', ${Y(2014)}, ['id-1','id-7'], 'photos'),
      ('e2', ${Y(2016)}, ['id-1','id-7'], 'photos'),
      ('e3', ${Y(2016, 8)}, ['id-1','id-7'], 'messages'),
      ('e4', ${Y(2015)}, ['id-1','id-9'], 'photos');

    INSERT INTO thread_identity VALUES ('th-b','id-7'), ('th-d','id-9'), ('th-q','id-11');
    INSERT INTO messages VALUES
      ('m1', ${Y(2015)}, 'th-b', true),
      ('m2', ${Y(2015)}, 'th-b', true),
      ('m3', ${Y(2015)}, 'th-d', true),
      ('m4', ${Y(2015)}, 'th-q', true),
      ('m5', ${Y(2015)}, 'th-q', false);
  `);
  return { conn };
}

test('computeBraid: per-person per-year strength series, Demo excluded, met people only', async () => {
  const { conn } = await seed();
  const b = await computeBraid(conn, { topN: 10 });

  assert.deepEqual(b.years, [2014, 2015, 2016]);
  const names = b.people.map(p => p.name);
  assert.ok(!names.includes('Demo User'), 'Demo is the ego, not a line');
  assert.ok(!names.includes('Quiet Quinn'), 'messages-only people are not in the physical braid');
  assert.deepEqual(names, ['Maya Park', 'Sam Fletcher'], 'ordered by total strength');

  const maya = b.people[0];
  assert.equal(maya.firstYear, 2014);
  const by = Object.fromEntries(maya.series.map(s => [s.year, s]));
  assert.equal(by[2014].events, 1);
  assert.equal(by[2015].events, 0, 'absent year present in series with zero events');
  assert.ok(by[2015].strength > 0, 'messages alone keep a thread alive');
  assert.equal(by[2016].events, 2, 'photo event + inferred meetup both count');
  assert.ok(by[2016].strength > by[2015].strength, 'meeting beats messaging');

  const sam = b.people[1];
  const dy = Object.fromEntries(sam.series.map(s => [s.year, s]));
  assert.equal(dy[2014].strength, 0, 'years before first contact are zero');
  assert.equal(dy[2015].events, 1);
  await conn.disconnectSync();
});

test('computeBraid: topN caps the cast', async () => {
  const { conn } = await seed();
  const b = await computeBraid(conn, { topN: 1 });
  assert.equal(b.people.length, 1);
  assert.equal(b.people[0].name, 'Maya Park');
  await conn.disconnectSync();
});
