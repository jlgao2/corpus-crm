import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { computeWeeks, weekIndex } from './weeks.js';

const MON = Date.UTC(2015, 5, 15, 12); // Mon 2015-06-15

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weeks-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR);
    CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT, participants VARCHAR[], source VARCHAR);
    INSERT INTO identities VALUES ('id-1','Demo User'), ('id-7','Maya Park'), ('id-9','Sam Fletcher');
    INSERT INTO events VALUES
      ('e1', ${MON}, ['id-1','id-7'], 'photos'),
      ('e2', ${MON + 2 * 86400000}, ['id-1','id-7'], 'photos'),
      ('e3', ${MON + 3 * 86400000}, ['id-1','id-9'], 'messages'),
      ('e4', ${MON + 21 * 86400000}, ['id-1','id-9'], 'photos');
  `);
  return { conn };
}

test('weekIndex maps a ts to (year, week) with Monday weeks', () => {
  const { year, week } = weekIndex(MON);
  assert.equal(year, 2015);
  assert.ok(week >= 0 && week < 53);
  assert.deepEqual(weekIndex(MON + 6 * 86400000), { year, week }, 'Sunday stays in the same week');
  assert.notDeepEqual(weekIndex(MON + 7 * 86400000), { year, week }, 'next Monday rolls over');
});

test('computeWeeks: per-week event counts + dominant companion, Demo excluded', async () => {
  const { conn } = await seed();
  const w = await computeWeeks(conn);
  assert.equal(w.years[0], 2015);
  const cells = w.cells.filter(c => c.events > 0);
  assert.equal(cells.length, 2, 'two active weeks');
  const [w1, w2] = cells;
  assert.equal(w1.events, 3);
  assert.equal(w1.top.name, 'Maya Park', 'Maya 2 events beats Sam 1');
  assert.equal(w2.events, 1);
  assert.equal(w2.top.name, 'Sam Fletcher');
  await conn.disconnectSync();
});
