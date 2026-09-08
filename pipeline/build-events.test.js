import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { buildEvents } from './build-events.js';

const T = 1700000000000;
const H = 3600 * 1000;
const MIN = 60 * 1000;

async function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bldevt-'));
  const inst = await DuckDBInstance.create(path.join(dir, 't.duckdb'));
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);
  await conn.run(`
    CREATE TABLE identities (canonical_id VARCHAR PRIMARY KEY, display_name VARCHAR, aliases VARCHAR[], sources VARCHAR[]);
    CREATE TABLE messages (id VARCHAR, ts BIGINT, ts_iso VARCHAR, source VARCHAR, thread_id VARCHAR, from_me BOOLEAN, sender_name VARCHAR, body VARCHAR, body_lower VARCHAR, meaningful BOOLEAN, attachment_type VARCHAR);
    CREATE TABLE thread_identity (thread_id VARCHAR, canonical_id VARCHAR);
    CREATE TABLE group_membership (thread_id VARCHAR NOT NULL, participant_name VARCHAR NOT NULL, canonical_id VARCHAR, PRIMARY KEY (thread_id, participant_name));
    CREATE TABLE links (canonical_id VARCHAR, link_type VARCHAR, related_canonical_id VARCHAR, related_label VARCHAR, evidence VARCHAR, weight INTEGER);
    CREATE TABLE fb_events (event_key VARCHAR, fbid VARCHAR, name VARCHAR, start_ts BIGINT, end_ts BIGINT, place_name VARCHAR, lat DOUBLE, lng DOUBLE, address VARCHAR, description VARCHAR, response VARCHAR, response_time BIGINT);

    INSERT INTO identities (canonical_id, display_name) VALUES
      ('id-1', 'Demo User'), ('id-7', 'Maya Park'), ('id-99', 'Zed Zed');

    -- Event A: 3 photos, GPS, faces (Demo + Maya). Event B: 3 photos, no GPS,
    -- no faces. C: only 2 photos (< minPhotos) -> never an event.
    INSERT INTO photos (id, ts, ts_iso, source, asset_path, has_named_face) VALUES
      ('gp:A1@1', ${T},                 '2023', 'gphotos', '/x/A1.jpg', true),
      ('gp:A2@2', ${T + 10 * MIN},      '2023', 'gphotos', '/x/A2.jpg', true),
      ('gp:A3@3', ${T + 20 * MIN},      '2023', 'gphotos', '/x/A3.jpg', false),
      ('gp:B1@4', ${T + 50 * H},            '2023', 'gphotos', '/x/B1.jpg', false),
      ('gp:B2@5', ${T + 50 * H + 10 * MIN}, '2023', 'gphotos', '/x/B2.jpg', false),
      ('gp:B3@6', ${T + 50 * H + 20 * MIN}, '2023', 'gphotos', '/x/B3.jpg', false),
      ('gp:C1@7', ${T + 200 * H},           '2023', 'gphotos', '/x/C1.jpg', false),
      ('gp:C2@8', ${T + 200 * H + 5 * MIN}, '2023', 'gphotos', '/x/C2.jpg', false);

    INSERT INTO places (photo_id, lat, lng, place_name, city) VALUES
      ('gp:A1@1', -37.8, 144.96, 'St Kilda Beach', 'Melbourne'),
      ('gp:A2@2', -37.8, 144.96, 'St Kilda Beach', 'Melbourne'),
      ('gp:A3@3', -37.8001, 144.9601, 'St Kilda Beach', 'Melbourne');

    INSERT INTO photo_faces VALUES
      ('gp:A1@1', 'id-1', 'gphotos:cluster:0'),
      ('gp:A1@1', 'id-7', 'gphotos:cluster:1'),
      ('gp:A2@2', 'id-7', 'gphotos:cluster:1');

    INSERT INTO thread_identity VALUES ('th-maya', 'id-7'), ('th-zed', 'id-99');
    INSERT INTO group_membership VALUES ('th-group', 'Maya Park', 'id-7');

    -- m1 in a participant DM inside A's window -> linked to A.
    -- m2 same window but non-participant thread -> NOT linked to A.
    -- m3 participant thread, outside every window -> never linked.
    -- m4 participant thread in window but not meaningful -> never linked.
    -- m5 in B's window, but B has no participants -> NOT linked (no fallback).
    -- m6 in a group chat Maya is in, inside A's window -> linked to A.
    INSERT INTO messages (id, ts, thread_id, from_me, sender_name, body, meaningful) VALUES
      ('m1', ${T + 1 * H},   'th-maya', false, 'Maya', 'omw to the beach', true),
      ('m2', ${T + 1 * H},   'th-zed',   false, 'Zed',   'unrelated chatter', true),
      ('m3', ${T + 100 * H}, 'th-maya', false, 'Maya', 'way later', true),
      ('m4', ${T + 1 * H},   'th-maya', false, 'Maya', 'laughed at an image', false),
      ('m5', ${T + 51 * H},  'th-zed',   false, 'Zed',   'during event B', true),
      ('m6', ${T + 2 * H},   'th-group', true,  'Demo', 'group pics incoming', true);

    -- fb-1 attended + near + in window -> names event A (geo-verified).
    -- fb-2 declined -> excluded. fb-3 attended + in window but ~16,000 km away -> rejected.
    -- fb-4 coordless, 5h off B's start -> outside the 3h time-only gate.
    -- fb-5 coordless, 2h off B's start -> names event B as a time-only match.
    INSERT INTO fb_events (event_key, name, start_ts, lat, lng, response) VALUES
      ('fb-1', 'Beach Day',      ${T + 1 * H},        -37.8, 144.96, 'joined'),
      ('fb-2', 'Declined Party', ${T},                -37.8, 144.96, 'declined'),
      ('fb-3', 'Far Away Gig',   ${T + 30 * MIN},      40.7, -74.0,  'joined'),
      ('fb-4', 'Too Late Show',  ${T + 55 * H},        NULL, NULL,   'joined'),
      ('fb-5', 'Zed Birthday',   ${T + 52 * H},        NULL, NULL,   'joined');
  `);
  return { dir, conn };
}

test('buildEvents links photos, faces, places, fb_events, and messages', async () => {
  const { dir, conn } = await seed();
  const eventsDir = path.join(dir, 'events');
  await buildEvents(conn, { eventsDir });

  const rows = (await conn.runAndReadAll(`
    SELECT event_id, start_ts, place_name, len(participants), n_photos, n_messages, summary, lat, lng
    FROM events ORDER BY start_ts
  `)).getRows();
  assert.equal(rows.length, 2, 'A and B are events; C is under minPhotos');
  const sources = (await conn.runAndReadAll(`SELECT DISTINCT source FROM events`)).getRows().map(r => r[0]);
  assert.deepEqual(sources, ['photos'], 'photo builder marks its rows');

  const [evA, evB] = rows;
  assert.equal(Number(evA[1]), T);
  assert.equal(evA[2], 'Melbourne', 'majority place: city preferred');
  assert.equal(Number(evA[3]), 2, 'participants = Demo + Maya');
  assert.equal(Number(evA[4]), 3);
  assert.equal(evA[6], 'Beach Day', 'attended nearby fb event names the cluster');
  assert.equal(evB[6], 'Zed Birthday', 'coordless fb event within 3h names B (time-only)');
  assert.ok(Math.abs(Number(evA[7]) - (-37.8)) < 0.001 && Math.abs(Number(evA[8]) - 144.96) < 0.001, 'A geotagged from its GPS cluster center');
  assert.equal(evB[7], null, 'B has no GPS photos, no geotag');

  const msgsA = (await conn.runAndReadAll(`
    SELECT message_id FROM event_messages WHERE event_id = '${evA[0]}' ORDER BY message_id
  `)).getRows().map(r => r[0]);
  assert.deepEqual(msgsA, ['m1', 'm6'], 'participant DM + participant group chat');
  const msgsB = (await conn.runAndReadAll(`
    SELECT message_id FROM event_messages WHERE event_id = '${evB[0]}'
  `)).getRows().map(r => r[0]);
  assert.deepEqual(msgsB, [], 'no participants -> no messages (window fallback is opt-in)');

  const cPhotos = Number((await conn.runAndReadAll(
    `SELECT COUNT(*) FROM event_photos WHERE photo_id LIKE 'gp:C%'`)).getRows()[0][0]);
  assert.equal(cPhotos, 0);

  const pe = (await conn.runAndReadAll(`
    SELECT canonical_id, related_label, weight FROM links
    WHERE link_type = 'person_event' ORDER BY canonical_id
  `)).getRows();
  assert.equal(pe.length, 2);
  assert.equal(pe[0][0], 'id-1'); assert.equal(pe[0][1], evA[0]); assert.equal(Number(pe[0][2]), 1);
  assert.equal(pe[1][0], 'id-7'); assert.equal(Number(pe[1][2]), 2, 'Maya in 2 photos');

  const cp = (await conn.runAndReadAll(`
    SELECT canonical_id, related_canonical_id, related_label, weight FROM links
    WHERE link_type = 'co_present_event' ORDER BY canonical_id
  `)).getRows();
  assert.equal(cp.length, 2, 'both directions, like shared_group');
  assert.deepEqual([cp[0][0], cp[0][1], cp[0][2], Number(cp[0][3])], ['id-1', 'id-7', 'Maya Park', 1]);
  assert.deepEqual([cp[1][0], cp[1][1], cp[1][2], Number(cp[1][3])], ['id-7', 'id-1', 'Demo User', 1]);

  assert.ok(fs.existsSync(path.join(eventsDir, 'index.html')), 'index rendered');
  const pageA = fs.readFileSync(path.join(eventsDir, `${evA[0]}.html`), 'utf-8');
  assert.ok(pageA.includes('Beach Day'), 'fb name on the event page');
  assert.ok(pageA.includes('omw to the beach'), 'linked message on the event page');
  assert.ok(!pageA.includes('matched by start time only'), 'geo-verified match carries no warning');
  const pageB = fs.readFileSync(path.join(eventsDir, `${evB[0]}.html`), 'utf-8');
  assert.ok(pageB.includes('matched by start time only'), 'time-only fb match is marked unverified');
  const indexHtml = fs.readFileSync(path.join(eventsDir, 'index.html'), 'utf-8');
  assert.ok(indexHtml.includes('Beach Day'), 'fb name on the index');

  // Idempotent: second run yields identical counts.
  await buildEvents(conn, { eventsDir });
  const counts = (await conn.runAndReadAll(`
    SELECT (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM event_photos),
           (SELECT COUNT(*) FROM event_messages),
           (SELECT COUNT(*) FROM links WHERE link_type IN ('person_event', 'co_present_event'))
  `)).getRows()[0].map(Number);
  assert.deepEqual(counts, [2, 6, 2, 4], 'second run is a clean rebuild');

  await conn.disconnectSync();
});
