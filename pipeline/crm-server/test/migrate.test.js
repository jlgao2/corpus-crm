import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { migrate } from '../../migrate-localstorage-to-sqlite.js';

test('migrate inserts people, tags, connections, interactions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mig-'));
  const dbPath = path.join(tmp, 'm.sqlite');
  const dump = {
    people: [
      { id: 'p1', name: 'Maya', relationship: 'friend', tags: ['hiking'], notes: 'NYC',
        interactions: [{ type:'note', notes:'coffee', date:'2026-05-09' }] },
      { id: 'p2', name: 'Leo', tags: [] },
    ],
    connections: [{ source: 'p1', target: 'p2', strength: 2 }],
  };
  migrate({ dump, dbPath });
  const db = openDb(dbPath);
  const people = db.prepare('SELECT id, name FROM people ORDER BY name').all();
  assert.deepEqual(people, [{ id:'p2', name:'Leo' }, { id:'p1', name:'Maya' }]);
  const tags = db.prepare('SELECT tag FROM person_tags WHERE person_id = ?').all('p1').map(r=>r.tag);
  assert.deepEqual(tags, ['hiking']);
  const ints = db.prepare('SELECT body, kind FROM interactions WHERE person_id = ?').all('p1');
  assert.equal(ints.length, 1);
  assert.equal(ints[0].body, 'coffee');
  const conns = db.prepare('SELECT * FROM connections').all();
  assert.equal(conns.length, 1);
  assert.equal(conns[0].strength, 2);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
