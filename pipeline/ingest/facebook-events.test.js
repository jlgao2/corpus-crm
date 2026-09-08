import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadFacebookEvents } from './facebook-events.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbev-'));
  const dir = path.join(root, 'chunk-x', 'your_facebook_activity', 'events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'your_event_responses.json'), JSON.stringify({ event_responses_v2: {
    events_joined: [{ name: 'Party with Demo', start_timestamp: 1737790200, end_timestamp: 0, place: { name: 'Naughtons Hotel', coordinate: { latitude: -37.79, longitude: 144.95 }, address: '43 Royal Parade' }, description: 'fun' }],
    events_interested: [{ name: 'Bloc Party Live', start_timestamp: 1700290800, end_timestamp: 0, response_time: 1688177784 }],
    events_declined: [{ name: 'Reptile Party', start_timestamp: 1766894400, end_timestamp: 1766934000 }],
  } }));
  fs.writeFileSync(path.join(dir, 'event_invitations.json'), JSON.stringify({ events_invited_v2: [{ name: 'Party with Demo', start_timestamp: 1737790200, end_timestamp: 0 }] }));
  fs.writeFileSync(path.join(dir, 'your_events.json'), JSON.stringify({ your_events_v2: [] }));
  return root;
}

test('parses all response buckets, converts to ms, end 0 -> null, dedups to strongest response', () => {
  const evs = loadFacebookEvents(fixture());
  const party = evs.find(e => e.name === 'Party with Demo');
  assert.equal(party.response, 'joined', 'strongest response wins over invited');
  assert.equal(party.start_ts, 1737790200000, 'seconds -> ms');
  assert.equal(party.end_ts, null, 'end 0 -> null');
  assert.equal(party.place_name, 'Naughtons Hotel');
  assert.equal(party.lat, -37.79);
  assert.equal(evs.filter(e => e.name === 'Party with Demo').length, 1, 'deduped invited+joined');
  assert.ok(evs.some(e => e.response === 'interested'));
  assert.ok(evs.some(e => e.response === 'declined'));
});

test('missing events dir returns [] (no throw)', () => {
  assert.deepEqual(loadFacebookEvents('/nonexistent/path'), []);
});

test('events_you_hosted.json parsed with response=hosted, name from title, ms start_ts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbev-'));
  const dir = path.join(root, 'chunk-x', 'your_facebook_activity', 'events');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events_you_hosted.json'), JSON.stringify([
    { title: 'My Hosted Event', timestamp: 1700000000, fbid: 'h1' }
  ]));
  const evs = loadFacebookEvents(root);
  const ev = evs.find(e => e.fbid === 'h1');
  assert.ok(ev, 'hosted event found');
  assert.equal(ev.response, 'hosted');
  assert.equal(ev.name, 'My Hosted Event');
  assert.equal(ev.start_ts, 1700000000000);
});

test('tickets_purchased.json with real nested shape extracts name and start_ts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbev-'));
  const dir = path.join(root, 'chunk-x', 'your_facebook_activity', 'events');
  fs.mkdirSync(dir, { recursive: true });
  // Real structure: single object, event Name/Start time at label_values[].dict[].dict[]
  const ticket = {
    timestamp: 1556982115,
    fbid: 'tk1',
    label_values: [
      { label: 'Status', value: 'Confirmed' },
      {
        title: 'Event',
        dict: [
          {
            title: '',
            dict: [
              { label: 'Name', value: 'Town Hall in Detroit!' },
              { label: 'Start time', timestamp_value: 1557007200 }
            ]
          }
        ]
      }
    ]
  };
  fs.writeFileSync(path.join(dir, 'tickets_purchased.json'), JSON.stringify(ticket));
  const evs = loadFacebookEvents(root);
  const ev = evs.find(e => e.response === 'ticket');
  assert.ok(ev, 'ticket event found');
  assert.equal(ev.name, 'Town Hall in Detroit!');
  assert.equal(ev.start_ts, 1557007200000);
});

test('fixMojibake cleans latin1-mangled names in event title', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbev-'));
  const dir = path.join(root, 'chunk-x', 'your_facebook_activity', 'events');
  fs.mkdirSync(dir, { recursive: true });
  // latin1-mangled UTF-8: curly quote U+2019 = 0xE2 0x80 0x99
  // written as latin1 string \xe2\x80\x99 which appears as three garbage chars
  const mangled = 'â'; // latin1-interpreted bytes of the UTF-8 curly apostrophe
  fs.writeFileSync(path.join(dir, 'your_event_responses.json'), JSON.stringify({
    event_responses_v2: {
      events_joined: [{ name: `Demo${mangled}s Party`, start_timestamp: 1700000001 }]
    }
  }));
  const evs = loadFacebookEvents(root);
  const ev = evs.find(e => e.response === 'joined');
  assert.ok(ev, 'event found');
  assert.equal(ev.name, 'Demo’s Party', 'mojibake curly apostrophe fixed');
});
