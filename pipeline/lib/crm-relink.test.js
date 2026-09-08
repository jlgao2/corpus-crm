import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../crm-server/db.js';
import { relinkCrm, checkTzRules } from './crm-relink.js';

// Post-rebuild world: Maya is id-9242 now, JB is id-9725; Demo unchanged.
const IDENTITIES = [
  { canonical_id: 'id-753', display_name: 'Demo User', aliases: ['Demo User', '+155501001'] },
  { canonical_id: 'id-9242', display_name: 'Maya Torres', aliases: ['Maya', '+155501002'] },
  { canonical_id: 'id-9725', display_name: 'Jordan Blake', aliases: ['Jordan Blake', '🕺🏻'] },
];

let dir, db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relink-test-'));
  db = openDb(path.join(dir, 'crm.sqlite'));
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function addPerson(id, name, anchor) {
  const now = Date.now();
  db.prepare('INSERT INTO people (id, name, anchor, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, anchor ? JSON.stringify(anchor) : null, now, now);
}

test('backfills a missing anchor when the id still resolves', () => {
  addPerson('id-753', 'Demo User', null);
  const report = relinkCrm({ db, identities: IDENTITIES });
  assert.deepEqual(report.backfilled, ['id-753']);
  const anchor = JSON.parse(db.prepare('SELECT anchor FROM people WHERE id = ?').get('id-753').anchor);
  assert.ok(anchor.names.includes('Demo User'));
});

test('rewrites a stale id across all four tables', () => {
  addPerson('id-1242', 'Maya Torres', { names: ['Maya Torres', 'Maya'], handles: ['+155501002'] });
  addPerson('id-753', 'Demo User', null);
  const now = Date.now();
  db.prepare("INSERT INTO interactions (id, person_id, kind, body, occurred_at, created_at, updated_at) VALUES ('i1','id-1242','note','x',?,?,?)").run(now, now, now);
  db.prepare("INSERT INTO person_tags (person_id, tag) VALUES ('id-1242','friend')").run();
  db.prepare("INSERT INTO connections (source_id, target_id, strength, updated_at) VALUES ('id-1242','id-753',2,?)").run(now);

  const report = relinkCrm({ db, identities: IDENTITIES });
  assert.deepEqual(report.rewritten, [{ from: 'id-1242', to: 'id-9242', name: 'Maya Torres' }]);
  assert.ok(db.prepare("SELECT 1 FROM people WHERE id = 'id-9242'").get());
  assert.equal(db.prepare("SELECT person_id FROM interactions WHERE id = 'i1'").get().person_id, 'id-9242');
  assert.equal(db.prepare('SELECT person_id FROM person_tags').get().person_id, 'id-9242');
  assert.equal(db.prepare('SELECT source_id FROM connections').get().source_id, 'id-9242');
});

test('a legacy row without an anchor relinks by its stored name', () => {
  addPerson('id-1706', 'Jordan Blake', null);
  const report = relinkCrm({ db, identities: IDENTITIES });
  assert.deepEqual(report.rewritten, [{ from: 'id-1706', to: 'id-9725', name: 'Jordan Blake' }]);
});

test('collision merges children into the existing row', () => {
  addPerson('id-9242', 'Maya Torres', null);
  addPerson('id-1242', 'Maya Torres', { names: ['Maya Torres'], handles: [] });
  const now = Date.now();
  db.prepare("INSERT INTO interactions (id, person_id, kind, body, occurred_at, created_at, updated_at) VALUES ('i2','id-1242','note','y',?,?,?)").run(now, now, now);
  const report = relinkCrm({ db, identities: IDENTITIES });
  assert.deepEqual(report.merged, [{ from: 'id-1242', to: 'id-9242' }]);
  assert.equal(db.prepare("SELECT person_id FROM interactions WHERE id = 'i2'").get().person_id, 'id-9242');
  assert.equal(db.prepare("SELECT count(*) n FROM people WHERE name = 'Maya Torres'").get().n, 1);
});

test('an id reused by a different person is not trusted', () => {
  // id-1706 exists in the live table — but as a bare phone number, not JB.
  const identities = [...IDENTITIES,
    { canonical_id: 'id-1706', display_name: '+155501003', aliases: ['+155501003'] }];
  addPerson('id-1706', 'Jordan Blake', null);
  const report = relinkCrm({ db, identities });
  assert.deepEqual(report.rewritten, [{ from: 'id-1706', to: 'id-9725', name: 'Jordan Blake' }]);
  assert.deepEqual(report.backfilled, []);
});

test('a bad earlier backfill is corrected, not trusted', () => {
  // Anchor snapshots the wrong identity (the reused id's phone number), but
  // the row name still says who it is — the mismatch forces re-resolution.
  const identities = [...IDENTITIES,
    { canonical_id: 'id-1706', display_name: '+155501003', aliases: ['+155501003'] }];
  addPerson('id-1706', 'Jordan Blake', { names: [], handles: ['+155501003'] });
  const report = relinkCrm({ db, identities });
  assert.deepEqual(report.rewritten, [{ from: 'id-1706', to: 'id-9725', name: 'Jordan Blake' }]);
});

test('unresolved anchors are reported, never guessed', () => {
  addPerson('id-404', 'Vanished Person', { names: ['Vanished Person'], handles: [] });
  const report = relinkCrm({ db, identities: IDENTITIES });
  assert.deepEqual(report.unresolved, [{ id: 'id-404', name: 'Vanished Person' }]);
  assert.ok(db.prepare("SELECT 1 FROM people WHERE id = 'id-404'").get(), 'row left untouched');
});

test('checkTzRules flags rule-table keys that no longer match', () => {
  // In this fixture Maya resolves to id-9242, but the rule table keys id-1242.
  const stale = checkTzRules(IDENTITIES);
  const maya = stale.find((s) => s.name === 'Maya Torres');
  assert.ok(maya, 'Maya should be flagged');
  assert.equal(maya.currentId, 'id-9242');
  const demo = stale.find((s) => s.name === 'Demo User');
  assert.equal(demo, undefined, 'Demo (id-753) still keyed — not flagged');
});
