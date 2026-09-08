import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DuckDBInstance } from '@duckdb/node-api';
import { buildFbEvents, deriveTopics } from './build-fb-events.js';

const EV = [
  { fbid: null, name: 'Bloc Party Live', start_ts: 1, end_ts: null, place_name: null, lat: null, lng: null, address: null, description: 'rock concert', response: 'joined', response_time: null },
  { fbid: null, name: 'Interpol concert', start_ts: 2, end_ts: null, place_name: 'Hordern', lat: -33.8, lng: 151.2, address: null, description: 'rock concert', response: 'interested', response_time: null },
  { fbid: null, name: 'Indie concert', start_ts: 3, end_ts: null, place_name: null, lat: null, lng: null, address: null, description: 'rock', response: 'declined', response_time: null },
];

test('deriveTopics counts positive responses, excludes declined + stopwords', () => {
  const t = deriveTopics(EV, 1);
  const concert = t.find(x => x.topic === 'concert');
  assert.ok(concert && concert.n === 2, 'concert in 2 positive events (declined excluded)');
  assert.ok(!t.some(x => x.topic === 'the'), 'stopword excluded');
});

test('buildFbEvents populates fb_events + fb_event_topics', async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  const r = await buildFbEvents(c, EV);
  assert.equal(r.events, 3);
  assert.equal((await c.runAndReadAll('SELECT COUNT(*) FROM fb_events')).getRows()[0][0], 3n);
  assert.equal((await c.runAndReadAll(`SELECT COUNT(*) FROM fb_events WHERE response='joined'`)).getRows()[0][0], 1n);
});

test('buildFbEvents is idempotent (DROP+CREATE)', async () => {
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await buildFbEvents(c, EV);
  await buildFbEvents(c, EV);
  assert.equal((await c.runAndReadAll('SELECT COUNT(*) FROM fb_events')).getRows()[0][0], 3n);
});
