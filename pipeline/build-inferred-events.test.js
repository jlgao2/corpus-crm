import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { buildInferredEvents } from './build-inferred-events.js';

const H = 3600 * 1000;
const T = 1700000000000;
const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infevt-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  await conn.run(`
    CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, ts_iso VARCHAR, source VARCHAR, thread_id VARCHAR, from_me BOOLEAN, sender_name VARCHAR, body VARCHAR, body_lower VARCHAR, meaningful BOOLEAN, attachment_type VARCHAR);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);
    CREATE TABLE links (canonical_id VARCHAR, link_type VARCHAR, related_canonical_id VARCHAR, related_label VARCHAR, evidence VARCHAR, weight INTEGER);

    INSERT INTO identities (canonical_id, display_name) VALUES
      ('id-1', 'Demo User'), ('id-7', 'Maya Park'), ('id-99', 'Zed Zed');
    INSERT INTO thread_identity VALUES ('th-maya', 'id-7'), ('th-zed', 'id-99');

    -- th-maya day: meetup chatter, but a photo event already covers it.
    -- th-zed day: meetup chatter, no photo event -> the LLM decides.
    INSERT INTO messages (id, ts, thread_id, from_me, sender_name, body, meaningful) VALUES
      ('m1', ${T},           'th-maya', true,  'Demo', 'omw',              true),
      ('m2', ${T + 0.2 * H}, 'th-maya', false, 'Maya',  'door is open',     true),
      ('m3', ${T},           'th-zed',   true,  'Demo', 'be there in 10',   true),
      ('m4', ${T + 0.2 * H}, 'th-zed',   false, 'Zed',    'grabbing a table', true),
      ('m5', ${T + 1 * H},   'th-zed',   false, 'Zed',    'we are at the back', true);

    -- Photo event overlapping th-maya's window, sharing id-7.
    INSERT INTO events (event_id, start_ts, end_ts, place_name, participants, n_photos, n_messages, summary, source)
      VALUES ('evt_x', ${T - 1 * H}, ${T + 2 * H}, 'Melbourne', ['id-7'], 5, 1, NULL, 'photos');
  `);
  return { dir, conn };
}

test('buildInferredEvents: dedupe vs photo events, confirm gate, links, cache', async () => {
  const { dir, conn } = await seed();
  const eventsDir = path.join(dir, 'events');
  const cachePath = path.join(dir, 'verdicts.jsonl');
  const asked = [];
  const confirmFn = async (cand) => {
    asked.push(`${cand.thread_id}|${cand.day}`);
    return { met: true, place: 'Naughtons', gist: 'pub catchup' };
  };
  let geocoded = 0;
  const geocodeFn = async () => { geocoded++; return { lat: -37.79558, lng: 144.95761 }; };

  await buildInferredEvents(conn, { eventsDir, cachePath, confirmFn, geocodeFn, dayKeyFn: utcDay });

  assert.deepEqual(asked, [`th-zed|${utcDay(T)}`],
    'photo-covered candidate is never sent to the LLM');

  const evs = (await conn.runAndReadAll(`
    SELECT event_id, place_name, summary, len(participants), n_photos, n_messages, source, lat, lng
    FROM events WHERE source = 'messages'
  `)).getRows();
  assert.equal(evs.length, 1);
  const [eid, place, gist, nParts, nPhotos, nMsgs, source, lat, lng] = evs[0];
  assert.equal(lat, -37.79558, 'venue forward-geocoded onto the event');
  assert.equal(lng, 144.95761);
  assert.equal(geocoded, 1);
  assert.ok(String(eid).startsWith('mevt_'), 'mevt_ id prefix');
  assert.equal(place, 'Naughtons');
  assert.equal(gist, 'pub catchup');
  assert.equal(Number(nParts), 2, 'Demo + Zed');
  assert.equal(Number(nPhotos), 0);
  assert.equal(Number(nMsgs), 3);
  assert.equal(source, 'messages');

  const em = (await conn.runAndReadAll(
    `SELECT message_id FROM event_messages WHERE event_id = '${eid}' ORDER BY message_id`)).getRows().map(r => r[0]);
  assert.deepEqual(em, ['m3', 'm4', 'm5']);

  const mu = (await conn.runAndReadAll(`
    SELECT canonical_id, related_canonical_id, weight FROM links
    WHERE link_type = 'met_up_inferred' ORDER BY canonical_id
  `)).getRows();
  assert.equal(mu.length, 2, 'both directions');
  assert.deepEqual([mu[0][0], mu[0][1], Number(mu[0][2])], ['id-1', 'id-99', 1]);
  assert.deepEqual([mu[1][0], mu[1][1], Number(mu[1][2])], ['id-99', 'id-1', 1]);

  const page = fs.readFileSync(path.join(eventsDir, `${eid}.html`), 'utf-8');
  assert.ok(page.includes('pub catchup'), 'gist titles the page');
  assert.ok(page.includes('grabbing a table'), 'evidence messages on the page');
  const idx = fs.readFileSync(path.join(eventsDir, 'index.html'), 'utf-8');
  assert.ok(idx.includes('pub catchup'), 'inferred event on the shared index');
  assert.ok(idx.includes('inferred'), 'marked as inferred');

  // Photo events and their pages are untouched.
  const photoEvs = Number((await conn.runAndReadAll(
    `SELECT COUNT(*) FROM events WHERE source = 'photos'`)).getRows()[0][0]);
  assert.equal(photoEvs, 1);

  // Second run: verdict + geocode caches answer, nothing external is re-asked.
  await buildInferredEvents(conn, { eventsDir, cachePath, confirmFn, geocodeFn, dayKeyFn: utcDay });
  assert.equal(asked.length, 1, 'cached verdict reused');
  assert.equal(geocoded, 1, 'cached geocode reused');
  const counts = (await conn.runAndReadAll(`
    SELECT (SELECT COUNT(*) FROM events WHERE source='messages'),
           (SELECT COUNT(*) FROM links WHERE link_type='met_up_inferred')
  `)).getRows()[0].map(Number);
  assert.deepEqual(counts, [1, 2]);

  await conn.disconnectSync();
});

test('buildInferredEvents: an anonymous photo event (no non-Demo faces) suppresses overlapping candidates', async () => {
  const { dir, conn } = await seed();
  // Make the photo event Demo-only: an unlabeled-faces cluster during a
  // texted meetup is the same hangout — no second card, no LLM call.
  await conn.run(`UPDATE events SET participants = ['id-1'] WHERE event_id = 'evt_x'`);
  const asked = [];
  const confirmFn = async (cand) => { asked.push(cand.thread_id); return { met: true }; };
  await buildInferredEvents(conn, {
    eventsDir: path.join(dir, 'events'), cachePath: path.join(dir, 'v.jsonl'), confirmFn, dayKeyFn: utcDay,
  });
  assert.deepEqual(asked, [], 'both thread-days overlap the anonymous photo event');
  const n = Number((await conn.runAndReadAll(
    `SELECT COUNT(*) FROM events WHERE source = 'messages'`)).getRows()[0][0]);
  assert.equal(n, 0);
  await conn.disconnectSync();
});

test('buildInferredEvents: transient confirm failures are retried', async () => {
  const { dir, conn } = await seed();
  await conn.run(`DELETE FROM events`);
  let calls = 0;
  const confirmFn = async () => {
    if (++calls < 3) throw new Error('HTTP 502');
    return { met: calls === 3, place: null, gist: calls === 3 ? 'made it through' : null };
  };
  await buildInferredEvents(conn, {
    eventsDir: path.join(dir, 'events'), cachePath: path.join(dir, 'v.jsonl'), confirmFn, dayKeyFn: utcDay, retryDelayMs: 1,
  });
  const n = Number((await conn.runAndReadAll(
    `SELECT COUNT(*) FROM events WHERE source = 'messages' AND summary = 'made it through'`)).getRows()[0][0]);
  assert.equal(n, 1, 'third attempt succeeded');
  await conn.disconnectSync();
});

test('buildInferredEvents: -haiku sibling cache is merged, main cache wins duplicates', async () => {
  const { dir, conn } = await seed();
  await conn.run(`DELETE FROM events`);
  const cachePath = path.join(dir, 'v.jsonl');
  const zedKey = `th-zed|${utcDay(T)}`, mayaKey = `th-maya|${utcDay(T)}`;
  fs.writeFileSync(cachePath, JSON.stringify({ key: zedKey, met: true, gist: 'from main' }) + '\n');
  fs.writeFileSync(path.join(dir, 'v-haiku.jsonl'),
    JSON.stringify({ key: zedKey, met: true, gist: 'haiku duplicate loses' }) + '\n' +
    JSON.stringify({ key: mayaKey, met: true, gist: 'from haiku' }) + '\n');
  const confirmFn = async () => { throw new Error('LLM must not be asked — everything is cached'); };
  await buildInferredEvents(conn, { eventsDir: path.join(dir, 'events'), cachePath, confirmFn, dayKeyFn: utcDay, retryDelayMs: 1 });
  const rows = (await conn.runAndReadAll(
    `SELECT summary FROM events WHERE source = 'messages' ORDER BY summary`)).getRows().map(r => r[0]);
  assert.deepEqual(rows, ['from haiku', 'from main']);
  await conn.disconnectSync();
});

test('buildInferredEvents: a poison candidate is skipped, the run continues', async () => {
  const { dir, conn } = await seed();
  await conn.run(`DELETE FROM events`); // both thread-days become candidates
  const confirmFn = async (cand) => {
    if (cand.thread_id === 'th-maya') throw new Error('HTTP 502'); // poison, every attempt
    return { met: true, place: null, gist: 'zed hang' };
  };
  await buildInferredEvents(conn, {
    eventsDir: path.join(dir, 'events'), cachePath: path.join(dir, 'v.jsonl'), confirmFn, dayKeyFn: utcDay, retryDelayMs: 1,
  });
  const rows = (await conn.runAndReadAll(
    `SELECT summary FROM events WHERE source = 'messages'`)).getRows().map(r => r[0]);
  assert.deepEqual(rows, ['zed hang'], 'the healthy candidate still landed');
  const cached = fs.readFileSync(path.join(dir, 'v.jsonl'), 'utf-8').trim().split('\n');
  assert.equal(cached.length, 1, 'the poisoned candidate is not cached — retried next run');
  await conn.disconnectSync();
});

test('buildInferredEvents: inferred_place geocodes to lat/lng but never becomes place_name', async () => {
  const { dir, conn } = await seed();
  await conn.run(`DELETE FROM events`);
  const confirmFn = async (cand) => cand.thread_id === 'th-zed'
    ? { met: true, place: null, gist: 'hang', inferred_place: 'Fitzroy, Melbourne' }
    : { met: false };
  const geocodeFn = async (q) => q === 'Fitzroy, Melbourne' ? { lat: -37.7983, lng: 144.9789 } : null;
  await buildInferredEvents(conn, {
    eventsDir: path.join(dir, 'events'), cachePath: path.join(dir, 'v.jsonl'), confirmFn, geocodeFn, dayKeyFn: utcDay,
  });
  const [row] = (await conn.runAndReadAll(
    `SELECT place_name, lat, lng FROM events WHERE source = 'messages'`)).getRows();
  assert.equal(row[0], null, 'no asserted venue');
  assert.equal(row[1], -37.7983, 'coords from the inferred location');
  assert.equal(row[2], 144.9789);
  await conn.disconnectSync();
});

test('buildInferredEvents: a "no" verdict writes nothing', async () => {
  const { dir, conn } = await seed();
  await conn.run(`DELETE FROM events`); // no photo events either
  const eventsDir = path.join(dir, 'events');
  const cachePath = path.join(dir, 'verdicts.jsonl');
  const confirmFn = async () => ({ met: false });

  await buildInferredEvents(conn, { eventsDir, cachePath, confirmFn, dayKeyFn: utcDay });

  const n = Number((await conn.runAndReadAll(
    `SELECT COUNT(*) FROM events WHERE source = 'messages'`)).getRows()[0][0]);
  assert.equal(n, 0);
  await conn.disconnectSync();
});
