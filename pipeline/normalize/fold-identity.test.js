import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { foldIdentity } from './fold-identity.js';

async function db() {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(`CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR, PRIMARY KEY (thread_id, canonical_id));
    CREATE TABLE photo_faces (photo_id VARCHAR, canonical_id VARCHAR, face_cluster VARCHAR, PRIMARY KEY (photo_id, canonical_id));
    CREATE TABLE face_clusters (cluster_id INTEGER PRIMARY KEY, canonical_id VARCHAR);
    CREATE TABLE birthdays (canonical_id VARCHAR, day VARCHAR);
    CREATE TABLE group_membership (thread_id VARCHAR, participant_name VARCHAR, canonical_id VARCHAR, PRIMARY KEY (thread_id, participant_name));
    CREATE TABLE mentions (mentioned_canonical_id VARCHAR, mentioned_form VARCHAR, thread_id VARCHAR);
    CREATE TABLE links (canonical_id VARCHAR, link_type VARCHAR, related_canonical_id VARCHAR);
    INSERT INTO identities VALUES ('id-1','Leo Reeves',['leo.p@x.com'],['messenger']), ('id-2','Leo',['owen_ig'],['instagram']);
    INSERT INTO thread_identity VALUES ('t1','id-1'), ('t2','id-2');
    INSERT INTO photo_faces VALUES ('p1','id-2','c'); INSERT INTO face_clusters VALUES (5,'id-2');
    INSERT INTO group_membership VALUES ('g1','owen_ig','id-2');
    INSERT INTO mentions VALUES ('id-2','leo','t1');
    INSERT INTO links VALUES ('id-2','friend','id-9'), ('id-1','friend','id-2');`);
  return c;
}

test('foldIdentity moves FK rows, unions aliases/sources, deletes loser', async () => {
  const c = await db();
  await foldIdentity(c, 'id-1', 'id-2');
  const ids = (await c.runAndReadAll(`SELECT canonical_id FROM identities ORDER BY 1`)).getRows().map(r => r[0]);
  assert.deepEqual(ids, ['id-1'], 'loser deleted');
  const al = (await c.runAndReadAll(`SELECT aliases FROM identities WHERE canonical_id='id-1'`)).getRows()[0][0];
  assert.ok((Array.isArray(al)?al:al.items).includes('owen_ig'), 'loser alias unioned');
  const ti = (await c.runAndReadAll(`SELECT canonical_id FROM thread_identity WHERE thread_id='t2'`)).getRows()[0][0];
  assert.equal(ti, 'id-1', 'thread_identity moved');
  assert.equal((await c.runAndReadAll(`SELECT canonical_id FROM photo_faces WHERE photo_id='p1'`)).getRows()[0][0], 'id-1');
  assert.equal((await c.runAndReadAll(`SELECT canonical_id FROM face_clusters WHERE cluster_id=5`)).getRows()[0][0], 'id-1');
});

test('foldIdentity rewrites group_membership, mentions, and links (dropping self-loops)', async () => {
  const c = await db();
  await foldIdentity(c, 'id-1', 'id-2');
  assert.equal((await c.runAndReadAll(`SELECT canonical_id FROM group_membership WHERE thread_id='g1'`)).getRows()[0][0], 'id-1');
  assert.equal((await c.runAndReadAll(`SELECT mentioned_canonical_id FROM mentions`)).getRows()[0][0], 'id-1');
  const links = (await c.runAndReadAll(`SELECT canonical_id, related_canonical_id FROM links ORDER BY 2`)).getRows();
  assert.deepEqual(links, [['id-1', 'id-9']], 'link moved to winner; id-1→id-2 became a self-loop and was dropped');
});

test('foldIdentity is a no-op when winner==loser', async () => {
  const c = await db();
  await foldIdentity(c, 'id-1', 'id-1');
  assert.equal((await c.runAndReadAll(`SELECT COUNT(*) FROM identities`)).getRows()[0][0], 2n);
});

test('foldIdentity renames the winner when renameTo is given', async () => {
  const c = await db();
  await foldIdentity(c, 'id-1', 'id-2', { renameTo: 'Leo Reeves' });
  assert.equal((await c.runAndReadAll(`SELECT display_name FROM identities WHERE canonical_id='id-1'`)).getRows()[0][0], 'Leo Reeves');
});
