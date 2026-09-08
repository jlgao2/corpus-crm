import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { createCorpus } from './corpus.js';

// ts anchors — 2024-02-01 sits inside Maya's Taipei window (id-1242 → TPE),
// while Demo (id-753) is in Chicago (CST).
const T0 = Date.parse('2024-02-01T10:00:00Z');
const MIN = 60_000;

let dir, corpus;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-mcp-test-'));
  const dbPath = path.join(dir, 'messages.duckdb');
  const inst = await DuckDBInstance.create(dbPath);
  const con = await inst.connect();
  await con.run(`
    CREATE TABLE identities (canonical_id VARCHAR, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE threads (thread_id VARCHAR, source VARCHAR, is_group BOOLEAN, participants VARCHAR[]);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, ts_iso VARCHAR, source VARCHAR, thread_id VARCHAR,
                           from_me BOOLEAN, sender_name VARCHAR, body VARCHAR, body_lower VARCHAR,
                           meaningful BOOLEAN, attachment_type VARCHAR);
    INSERT INTO identities VALUES
      ('id-753', 'Demo User', ['Demo User'], ['imessage']),
      ('id-1242', 'Maya Torres', ['Maya', 'mayatorres'], ['imessage', 'instagram']),
      ('id-9', 'Nina Okafor', ['Nina'], ['instagram']),
      ('id-77', 'NAB Loans', ['NAB Loans'], ['imessage']),
      ('id-88', '+155501001', ['+155501001'], ['imessage']);
    INSERT INTO threads VALUES
      ('imsg:+614', 'imessage', false, ['Maya Torres']),
      ('ig:nina', 'instagram', false, ['Nina Okafor']);
    INSERT INTO thread_identity VALUES ('imsg:+614', 'id-1242'), ('ig:nina', 'id-9'), ('imsg:nab', 'id-77'), ('imsg:locker', 'id-88');
  `);
  const msgs = [
    ['m1', T0,           false, 'Maya Torres', 'landed in lisbon, hostel at 8', 'imsg:+614'],
    ['m2', T0 + MIN,     true,  'Demo User',  'nice! how is the trip so far', 'imsg:+614'],
    ['m3', T0 + 2 * MIN, false, 'Maya Torres', 'long day. tired. glad I came', 'imsg:+614'],
    ['m4', T0 + 3 * MIN, false, 'Maya Torres', 'a redacted-topic came up again', 'imsg:+614'],
    ['m5', T0 + 4 * MIN, false, 'Nina Okafor',    'you seen the lisbon tram pics?', 'ig:nina'],
    // search-noise thread (no thread_identity mapping on purpose)
    ['n1', T0 + 10 * MIN, true, 'Demo User', 'the climax was unreal', 'imsg:noise'],
    ['n2', T0 + 11 * MIN, true, 'Demo User', 'saw dune in imax last night', 'imsg:noise'],
    ['n3', T0 + 12 * MIN, true, 'Demo User', 'read this https://letterboxd.com/film/imax-era/', 'imsg:noise'],
    ['n4', T0 + 13 * MIN, true, 'Demo User', 'imax rant: ' + 'x'.repeat(600), 'imsg:noise'],
    ['n5', T0 + 14 * MIN, true, 'Demo User', 'lisbon on my mind', 'imsg:noise'],
    // service sender in an unmapped thread — must not surface in samples
    ['s1', T0 + 20 * MIN, false, 'NAB', 'NAB: we need more information to process your application', 'imsg:nab'],
    // a year with ONLY unmapped messages — samples must fall back rather than vanish
    ['p1', Date.parse('2023-02-01T10:00:00Z'), true, 'Demo User', 'last year lone note', 'imsg:noise'],
    // two-way but nameless (package locker) — replied-to broadcast, still not a person
    ['l1', T0 + 21 * MIN, false, '+155501001', 'Package ready for pick-up w/code 414271', 'imsg:locker'],
    ['l2', T0 + 22 * MIN, true,  'Demo User', '414271', 'imsg:locker'],
  ];
  for (const [id, ts, fromMe, sender, body, thread] of msgs) {
    await con.run(
      `INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, true, NULL)`,
      [id, BigInt(ts), new Date(ts).toISOString(), thread.startsWith('ig:') ? 'instagram' : 'imessage',
       thread, fromMe, sender, body, body.toLowerCase()],
    );
  }
  con.closeSync();
  inst.closeSync();

  const portraitsDir = path.join(dir, 'portraits');
  fs.mkdirSync(portraitsDir);
  fs.writeFileSync(path.join(portraitsDir, 'Maya_Torres.md'), '# Maya\nthe portrait body\n');

  // merge pairs are recorded with STALE ids (they renumber on rebuild) but
  // stable names — the corpus must resolve them by name, not id.
  fs.writeFileSync(path.join(dir, 'merges-proposed.json'), JSON.stringify({
    confident: [{ winner_id: 'id-999', loser_id: 'id-998', winner_name: 'Maya Torres', loser_name: 'Nina Okafor' }],
    manual: [],
    ambiguous: [],
  }));
  corpus = createCorpus({ dbPath, portraitsDir });
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('resolvePerson matches display_name case-insensitively with volume', async () => {
  const out = await corpus.resolvePerson({ query: 'maya' });
  assert.equal(out.length, 1);
  assert.equal(out[0].canonical_id, 'id-1242');
  assert.deepEqual(out[0].sources, ['imessage', 'instagram']);
  assert.equal(out[0].message_count, 4);
});

test('resolvePerson matches aliases', async () => {
  const out = await corpus.resolvePerson({ query: 'mayatorres' });
  assert.equal(out[0]?.canonical_id, 'id-1242');
});

test('searchMessages renders sender-local time (Taipei window)', async () => {
  const out = await corpus.searchMessages({ query: 'lisbon' });
  const maya = out.find((m) => m.id === 'm1');
  assert.ok(maya, 'expected the Maya hit');
  // 10:00Z on 2024-02-01 is 18:00 in Taipei; label swaps GMT+8 → TPE
  assert.match(maya.local_time, /2024-02-01 18:00 TPE/);
  assert.equal(maya.thread_id, 'imsg:+614');
});

test('searchMessages filters by person_id', async () => {
  const out = await corpus.searchMessages({ query: 'lisbon', person_id: 'id-1242' });
  assert.deepEqual(out.map((m) => m.id), ['m1']);
});

test('searchMessages respects after/before ISO dates', async () => {
  const none = await corpus.searchMessages({ query: 'lisbon', after: '2025-01-01' });
  assert.equal(none.length, 0);
});

test('searchMessages matches whole words only by default', async () => {
  const out = await corpus.searchMessages({ query: 'imax' });
  // n1 (climax) and n3 (imax only inside a URL) must not match
  assert.deepEqual(out.map((m) => m.id).sort(), ['n2', 'n4']);
});

test('searchMessages match=substring restores raw contains', async () => {
  const out = await corpus.searchMessages({ query: 'imax', match: 'substring' });
  assert.deepEqual(out.map((m) => m.id).sort(), ['n1', 'n2', 'n3', 'n4']);
});

test('searchMessages truncates long bodies and flags it', async () => {
  const out = await corpus.searchMessages({ query: 'imax' });
  const long = out.find((m) => m.id === 'n4');
  assert.ok(long.body.length <= 500);
  assert.equal(long.body_truncated, true);
  const short = out.find((m) => m.id === 'n2');
  assert.ok(!short.body_truncated);
});

test('searchMessages accepts a person_ids array spanning sources', async () => {
  // n5 also mentions lisbon but belongs to neither person — must be excluded
  const out = await corpus.searchMessages({ query: 'lisbon', person_ids: ['id-1242', 'id-9'] });
  assert.deepEqual(out.map((m) => m.id).sort(), ['m1', 'm5']);
});

test('searchMessages never returns redacted bodies', async () => {
  const out = await corpus.searchMessages({ query: 'lab' });
  assert.deepEqual(out, []);
});

test('getConversationWindow returns an ordered bounded window', async () => {
  const out = await corpus.getConversationWindow({ thread_id: 'imsg:+614', around_ts: T0 + MIN, before: 1, after: 5 });
  // m4 is redacted, so: m1 (before), m2 (anchor), m3
  assert.deepEqual(out.messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  const mine = out.messages.find((m) => m.id === 'm2');
  assert.equal(mine.speaker, 'ME');
  // Demo is in Chicago at that ts: 10:01Z → 04:01 CST
  assert.match(mine.local_time, /04:01 CST/);
});

test('personSummary returns stats and the portrait markdown', async () => {
  const out = await corpus.personSummary({ person_id: 'id-1242' });
  assert.equal(out.identity.display_name, 'Maya Torres');
  assert.equal(out.stats.message_count, 4);
  assert.deepEqual(out.stats.threads, ['imsg:+614']);
  assert.match(out.portrait, /the portrait body/);
  assert.match(out.stats.first_local, /TPE/);
});

test('runQuery enforces the read-only guard', async () => {
  await assert.rejects(() => corpus.runQuery({ sql: 'DROP TABLE messages' }), /read-only/i);
});

test('runQuery returns rows and drops redacted ones', async () => {
  const out = await corpus.runQuery({ sql: 'SELECT id, body FROM messages ORDER BY ts' });
  assert.deepEqual(out.rows.map((r) => r.id), ['p1', 'm1', 'm2', 'm3', 'm5', 'n1', 'n2', 'n3', 'n4', 'n5', 's1', 'l1', 'l2']);
});

test('runQuery caps row count and says so', async () => {
  const out = await corpus.runQuery({ sql: 'SELECT id FROM messages ORDER BY ts', limit: 2 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.truncated, true);
});

test('resolvePerson surfaces same_as hints resolved by name, not stale id', async () => {
  const [maya] = await corpus.resolvePerson({ query: 'maya' });
  assert.deepEqual(maya.same_as, ['id-9']);
  const [nina] = await corpus.resolvePerson({ query: 'Nina Okafor' });
  assert.deepEqual(nina.same_as, ['id-1242']);
});

test('resolvePerson reports has_portrait per candidate', async () => {
  const [maya] = await corpus.resolvePerson({ query: 'maya' });
  assert.equal(maya.has_portrait, true);
  const [nina] = await corpus.resolvePerson({ query: 'Nina Okafor' });
  assert.equal(nina.has_portrait, false);
});

test('personSummary includes same_as', async () => {
  const out = await corpus.personSummary({ person_id: 'id-1242' });
  assert.deepEqual(out.same_as, ['id-9']);
});

test('a missing merges file means empty same_as, not an error', async () => {
  const bare = createCorpus({ dbPath: path.join(dir, 'messages.duckdb'), mergesPath: path.join(dir, 'nope.json') });
  const [maya] = await bare.resolvePerson({ query: 'maya' });
  assert.deepEqual(maya.same_as, []);
});

test('onThisDay buckets by year in Demo-local time, redactions out', async () => {
  const out = await corpus.onThisDay({ date: '02-01' });
  const y2024 = out.years.find((y) => y.year === 2024);
  assert.ok(y2024, 'expected a 2024 bucket');
  // m4 (redacted) is excluded from count and samples; n1-n5 are +10min, still 02-01
  assert.equal(y2024.message_count, 12);
  // the unmapped noise thread (5 msgs) outranks Maya (3) — labeled by thread_id
  assert.deepEqual(y2024.top_people[0], { name: 'imsg:noise', person_id: null, count: 5 });
  assert.deepEqual(y2024.top_people[1], { name: 'Maya Torres', person_id: 'id-1242', count: 3 });
  assert.match(y2024.samples[0].local_time, /TPE|CST/);
  assert.ok(!y2024.samples.some((s) => /redacted-topic/.test(s.body)));
});

test('onThisDay samples prefer two-way human threads over broadcasts', async () => {
  const out = await corpus.onThisDay({ date: '02-01' });
  const y2024 = out.years.find((y) => y.year === 2024);
  assert.ok(y2024.samples.length > 0);
  // imsg:nab is MAPPED (NAB Loans is an identity) but Demo never replied
  // there — a broadcast, not a relationship. ig:nina is mapped but one-way;
  // only the Maya thread is a two-way conversation.
  for (const s of y2024.samples) {
    assert.equal(s.thread_id, 'imsg:+614', `sample from non-conversation thread: ${s.thread_id}`);
  }
});

test('onThisDay falls back to unmapped threads when a year has nothing else', async () => {
  const out = await corpus.onThisDay({ date: '02-01' });
  const y2023 = out.years.find((y) => y.year === 2023);
  assert.equal(y2023.samples.length, 1);
  assert.equal(y2023.samples[0].body, 'last year lone note');
});

test('onThisDay returns empty years for a quiet date', async () => {
  const out = await corpus.onThisDay({ date: '11-11' });
  assert.deepEqual(out.years, []);
});

test('getIdentity returns the identity or null', async () => {
  const maya = await corpus.getIdentity('id-1242');
  assert.equal(maya.display_name, 'Maya Torres');
  assert.equal(await corpus.getIdentity('id-nope'), null);
});

test('getSchema lists tables and columns', async () => {
  const out = await corpus.getSchema();
  const messages = out.find((t) => t.table === 'messages');
  assert.ok(messages.columns.some((c) => c.startsWith('ts:')));
});
