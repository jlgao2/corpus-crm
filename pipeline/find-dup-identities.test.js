import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { findDupIdentities } from './find-dup-identities.js';

async function db() {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(`CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);
    CREATE TABLE messages (id VARCHAR, thread_id VARCHAR);
    INSERT INTO identities VALUES
      ('id-1','Leo Reeves',['leo.p@x.com'],['messenger']),
      ('id-2','Leo',['leo.p@x.com'],['instagram']),
      ('id-3','Sam Fletcher',['+155501001'],['imessage']),
      ('id-4','Sam Flet',['+155501001'],['messenger']),
      ('id-5','Alice Smith',['alice@y.com'],['gmail']),
      ('id-6','Demo User',['+155501002'],['imessage']);`);
  return c;
}

test('shared email/phone produce high-score candidates; self excluded', async () => {
  const c = await db();
  const cands = await findDupIdentities(c);
  const has = (n1, n2) => cands.some(x => [x.a.name, x.b.name].sort().join('|') === [n1, n2].sort().join('|'));
  assert.ok(has('Leo Reeves', 'Leo'), 'Leo pair via shared email');
  assert.ok(has('Sam Fletcher', 'Sam Flet'), 'Sam pair via shared phone');
  assert.ok(!cands.some(x => x.a.name === 'Demo User' || x.b.name === 'Demo User'), 'self excluded');
  assert.ok(!cands.some(x => x.a.name === 'Alice Smith' || x.b.name === 'Alice Smith'), 'singleton not flagged');
});
