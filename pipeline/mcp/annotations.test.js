import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../crm-server/db.js';
import { createAnnotations } from './annotations.js';

const IDENTITIES = {
  'id-1242': { canonical_id: 'id-1242', display_name: 'Maya Torres', aliases: ['Maya', '+155501001'] },
};

let dir, db, ann;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mcp-test-'));
  db = openDb(path.join(dir, 'crm.sqlite'));
  ann = createAnnotations({ db, lookupIdentity: async (id) => IDENTITIES[id] || null });
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logInteraction auto-creates the person from identities', async () => {
  const row = await ann.logInteraction({ person_id: 'id-1242', kind: 'note', body: 'saw her at the market' });
  assert.equal(row.person_id, 'id-1242');
  assert.equal(row.kind, 'note');
  assert.equal(row.body, 'saw her at the market');
  assert.ok(typeof row.occurred_at === 'number');

  const person = db.prepare('SELECT * FROM people WHERE id = ?').get('id-1242');
  assert.equal(person.name, 'Maya Torres');
});

test('auto-create snapshots a rebuild-proof anchor', async () => {
  await ann.logInteraction({ person_id: 'id-1242', kind: 'note', body: 'x' });
  const person = db.prepare('SELECT anchor FROM people WHERE id = ?').get('id-1242');
  const anchor = JSON.parse(person.anchor);
  assert.deepEqual(anchor.names, ['Maya Torres', 'Maya']);
  assert.deepEqual(anchor.handles, ['+155501001']);
});

test('openDb adds the anchor column to a pre-anchor database', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-legacy-'));
  const legacyPath = path.join(legacyDir, 'crm.sqlite');
  const Database = (await import('better-sqlite3')).default;
  const legacy = new Database(legacyPath);
  legacy.exec('CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)');
  legacy.close();
  const reopened = openDb(legacyPath);
  const cols = reopened.prepare('PRAGMA table_info(people)').all().map((c) => c.name);
  assert.ok(cols.includes('anchor'));
  reopened.close();
  fs.rmSync(legacyDir, { recursive: true, force: true });
});

test('logInteraction does not clobber an existing person row', async () => {
  const now = Date.now();
  db.prepare(`INSERT INTO people (id, name, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run('id-1242', 'Maya', 'existing notes', now, now);
  await ann.logInteraction({ person_id: 'id-1242', kind: 'call', body: 'caught up' });
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get('id-1242');
  assert.equal(person.name, 'Maya');
  assert.equal(person.notes, 'existing notes');
});

test('logInteraction accepts an ISO occurred_at', async () => {
  const row = await ann.logInteraction({
    person_id: 'id-1242', kind: 'meetup', body: 'dinner', occurred_at: '2026-07-20',
  });
  assert.equal(row.occurred_at, Date.parse('2026-07-20T00:00:00Z'));
});

test('logInteraction rejects an unknown person', async () => {
  await assert.rejects(
    () => ann.logInteraction({ person_id: 'id-9999', kind: 'note', body: 'x' }),
    /unknown person/i,
  );
});

test('logInteraction rejects a bad kind', async () => {
  await assert.rejects(
    () => ann.logInteraction({ person_id: 'id-1242', kind: 'seance', body: 'x' }),
    /kind/i,
  );
});

test('setFollowUp writes people.follow_up and auto-creates too', async () => {
  const person = await ann.setFollowUp({ person_id: 'id-1242', text: 'ask about Taipei trip' });
  assert.equal(person.follow_up, 'ask about Taipei trip');
  assert.equal(person.name, 'Maya Torres');
});
