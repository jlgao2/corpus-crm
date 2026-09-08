import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { yearAtlas, FRAMES } from './atlas.js';

const Y = (y, m = 6) => Date.UTC(y, m, 15, 12);
const MEL = [-37.81, 144.96], SYD = [-33.87, 151.21], CHI = [41.88, -87.63], TOKYO = [35.68, 139.69];

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await conn.run(`
    CREATE TABLE events (event_id VARCHAR PRIMARY KEY, start_ts BIGINT, place_name VARCHAR,
                         n_photos INTEGER, summary VARCHAR, source VARCHAR, lat DOUBLE, lng DOUBLE);
    INSERT INTO events VALUES
      ('e1', ${Y(2015)}, 'Melbourne', 10, NULL, 'photos', ${MEL[0]}, ${MEL[1]}),
      ('e2', ${Y(2015, 7)}, 'Melbourne', 5, NULL, 'photos', ${MEL[0] + 0.01}, ${MEL[1] + 0.01}),
      ('e3', ${Y(2015, 11)}, 'Tokyo', 8, NULL, 'photos', ${TOKYO[0]}, ${TOKYO[1]}),
      ('e4', ${Y(2019)}, 'Sydney', 6, NULL, 'photos', ${SYD[0]}, ${SYD[1]}),
      ('e5', ${Y(2024)}, 'Chicago', 7, 'Party', 'photos', ${CHI[0]}, ${CHI[1]}),
      ('e6', ${Y(2024, 8)}, NULL, 0, 'coffee', 'messages', NULL, NULL);
  `);
  return { conn };
}

test('yearAtlas: dominant frame per year, in-frame points, beyond-frame tallies', async () => {
  const { conn } = await seed();
  const a = await yearAtlas(conn);

  assert.deepEqual(a.years.map(y => y.year), [2015, 2019, 2024]);
  const y15 = a.years[0];
  assert.equal(y15.frame, 'MEL', 'Melbourne dominates 2015');
  assert.equal(y15.points.length, 2, 'Tokyo is out of frame');
  assert.deepEqual(y15.beyond, [{ place: 'Tokyo', n: 1 }]);

  assert.equal(a.years[1].frame, 'SYD', 'Sydney year picks the Sydney frame');
  const y24 = a.years[2];
  assert.equal(y24.frame, 'CHI');
  assert.equal(y24.points.length, 1, 'coordless inferred meetup is not a point');
  assert.equal(y24.nNoCoords, 1, 'but it is counted');

  // Substrate: all-time points per frame.
  assert.equal(a.substrate.MEL.length, 2);
  assert.equal(a.substrate.CHI.length, 1);
  assert.ok(FRAMES.MEL && FRAMES.SYD && FRAMES.CHI);
  await conn.disconnectSync();
});
