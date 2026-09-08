import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { buildCalls, buildResolver } from './build-calls.js';

test('buildResolver maps phone (normalized) + email (case-insensitive) aliases', () => {
  const resolve = buildResolver([
    { canonical_id: 'id-1', aliases: ['+13125550142', 'Demo'] },
    { canonical_id: 'id-2', aliases: ['jb@x.com'] },
  ]);
  assert.equal(resolve('+1 (312) 555-0142'), 'id-1', 'phone normalized match');
  assert.equal(resolve('JB@X.com'), 'id-2', 'email case-insensitive');
  assert.equal(resolve('+99999999'), null, 'unknown -> null');
  assert.equal(resolve(null), null, 'null-safe');
});

test('buildCalls populates calls, resolves canonical_id, flags missed', async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(`CREATE TABLE identities (canonical_id VARCHAR, aliases VARCHAR[]); INSERT INTO identities VALUES ('id-5', ['+15125550188']);`);
  const calls = [
    { call_id: 'c1', ts: 1000, duration_s: 5355, direction: 'out', answered: true, missed: false, service: 'facetime', address: '+15125550188', name: null },
    { call_id: 'c2', ts: 2000, duration_s: 0, direction: 'in', answered: false, missed: true, service: 'phone', address: '+1999', name: null },
  ];
  const r = await buildCalls(c, calls);
  assert.equal(r.n, 2);
  assert.equal(r.resolved, 1, 'only the known number resolves');
  assert.equal((await c.runAndReadAll(`SELECT canonical_id FROM calls WHERE call_id='c1'`)).getRows()[0][0], 'id-5');
  assert.equal((await c.runAndReadAll(`SELECT COUNT(*) FROM calls WHERE missed`)).getRows()[0][0], 1n);
});

test('buildCalls is idempotent (DROP+CREATE)', async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(`CREATE TABLE identities (canonical_id VARCHAR, aliases VARCHAR[]);`);
  const calls = [{ call_id: 'c1', ts: 1, duration_s: 1, direction: 'out', answered: true, missed: false, service: 'phone', address: null, name: null }];
  await buildCalls(c, calls); await buildCalls(c, calls);
  assert.equal((await c.runAndReadAll('SELECT COUNT(*) FROM calls')).getRows()[0][0], 1n);
});
