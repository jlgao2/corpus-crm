import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { bucketRhythm } from './build-rhythm.js';

const MON = Date.UTC(2015, 5, 15, 12); // Mon 2015-06-15 12:00 UTC

test('bucketRhythm buckets by week and injected local hour, counting from_me separately', () => {
  const localHourFn = (ts) => new Date(ts).getUTCHours(); // tests use UTC as "local"
  const rows = [
    { ts: MON, from_me: true },
    { ts: MON + 60000, from_me: false },
    { ts: MON + 3600000, from_me: false },        // next hour, same week
    { ts: MON + 7 * 86400000, from_me: true },    // next week
  ];
  const { cells } = bucketRhythm(rows, { localHourFn });
  assert.equal(cells.length, 3);
  const [a, b, c] = cells;
  assert.deepEqual(a.slice(2), [12, 2, 1], 'hour 12: two messages, one from me');
  assert.deepEqual(b.slice(2), [13, 1, 0]);
  assert.equal(c[3], 1);
  assert.ok(c[1] !== a[1] || c[0] !== a[0], 'next week is a different cell');
});
