import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { applyMerges } from './apply-merges.js';

async function db() {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(`CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR, PRIMARY KEY (thread_id, canonical_id));
    CREATE TABLE photo_faces (photo_id VARCHAR, canonical_id VARCHAR, face_cluster VARCHAR, PRIMARY KEY (photo_id, canonical_id));
    CREATE TABLE face_clusters (cluster_id INTEGER PRIMARY KEY, canonical_id VARCHAR);
    CREATE TABLE birthdays (canonical_id VARCHAR, day VARCHAR);
    INSERT INTO identities VALUES
      ('id-1','Leo Reeves',['leo.p@x.com'],['messenger']),
      ('id-2','Leo',['owen_ig'],['instagram']),
      ('id-9','Demo User',['+155501001'],['imessage']);`);
  return c;
}
const mk = () => [{ winner: { name: 'Leo Reeves', alias: 'leo.p@x.com' }, loser: { name: 'Leo', alias: 'owen_ig' } }];

test('apply folds resolved merge; idempotent on re-run', async () => {
  const c = await db();
  let r = await applyMerges(c, mk(), { apply: true });
  assert.equal(r.applied.length, 1);
  assert.equal((await c.runAndReadAll(`SELECT COUNT(*) FROM identities`)).getRows()[0][0], 2n);
  r = await applyMerges(c, mk(), { apply: true });
  assert.equal(r.applied.length, 0, 're-apply is a no-op');
  assert.equal(r.unresolved.length + r.skipped.length, 1);
});

test('self-guard: never merge Demo User', async () => {
  const c = await db();
  const r = await applyMerges(c, [{ winner: { name: 'Leo Reeves', alias: 'leo.p@x.com' }, loser: { name: 'Demo User', alias: '+155501001' } }], { apply: true });
  assert.equal(r.applied.length, 0);
  assert.equal(r.skipped[0].why, 'self-guard');
});

test('unresolved when signature matches nothing', async () => {
  const c = await db();
  const r = await applyMerges(c, [{ winner: { name: 'Nobody', alias: 'no@x.com' }, loser: { name: 'Ghost', alias: 'ghost' } }], { apply: true });
  assert.equal(r.unresolved.length, 1);
});
