import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSteps, computeFreshness } from './refresh-runner.js';

test('runs steps in order and reports each', async () => {
  const order = [];
  const report = await runSteps([
    { name: 'a', run: async () => order.push('a') },
    { name: 'b', run: async () => order.push('b') },
  ], { log: () => {} });
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(report.map((r) => [r.name, r.ok]), [['a', true], ['b', true]]);
});

test('a non-critical failure is reported and the run continues', async () => {
  const order = [];
  const report = await runSteps([
    { name: 'a', run: async () => { throw new Error('boom'); } },
    { name: 'b', run: async () => order.push('b') },
  ], { log: () => {} });
  assert.deepEqual(order, ['b']);
  assert.equal(report[0].ok, false);
  assert.match(report[0].error, /boom/);
  assert.equal(report[1].ok, true);
});

test('a critical failure aborts the remaining steps', async () => {
  const order = [];
  const report = await runSteps([
    { name: 'build', critical: true, run: async () => { throw new Error('db locked'); } },
    { name: 'publish', run: async () => order.push('publish') },
  ], { log: () => {} });
  assert.deepEqual(order, []);
  assert.equal(report[0].ok, false);
  assert.equal(report[1].skipped, true);
});

test('computeFreshness flags sources past their threshold', () => {
  const now = Date.parse('2026-07-30T00:00:00Z');
  const day = 86_400_000;
  const out = computeFreshness(
    [
      { source: 'imessage', newest_ts: now - 2 * day },
      { source: 'whatsapp', newest_ts: now - 40 * day },
      { source: 'messenger', newest_ts: now - 89 * day },
    ],
    { imessage: 7, whatsapp: 30, messenger: 90 },
    now,
  );
  assert.equal(out.find((s) => s.source === 'imessage').stale, false);
  assert.equal(out.find((s) => s.source === 'whatsapp').stale, true);
  assert.equal(out.find((s) => s.source === 'messenger').stale, false);
  assert.equal(out.find((s) => s.source === 'whatsapp').days_behind, 40);
});
