import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePartifulEmail, parsePartifulEventPage } from './partiful.js';

const INVITE = {
  from: 'Partiful <invites@mail.partiful.com>',
  subject: "You're invited to Rooftop Solstice 🌅",
  date: 'Mon, 20 Jul 2026 15:04:11 +0000',
  text: `Jess invited you to Rooftop Solstice 🌅
Saturday, August 8 · 6:00pm CDT
RSVP: https://partiful.com/e/AbC123xYz?guest=1
`,
};

const UPDATE = {
  from: 'Partiful <hello@mail.partiful.com>',
  subject: 'Update for Rooftop Solstice 🌅',
  date: 'Tue, 28 Jul 2026 09:00:00 +0000',
  text: 'The venue changed. Details: https://partiful.com/e/AbC123xYz',
};

const UNRELATED = {
  from: 'NAB <no-reply@nab.com.au>',
  subject: 'Your statement is ready',
  date: 'Mon, 20 Jul 2026 15:04:11 +0000',
  text: 'https://nab.com.au',
};

test('parses an invite: event id from the URL, name, host, kind', () => {
  const e = parsePartifulEmail(INVITE);
  assert.equal(e.event_id, 'partiful:AbC123xYz');
  assert.equal(e.name, 'Rooftop Solstice 🌅');
  assert.equal(e.url, 'https://partiful.com/e/AbC123xYz');
  assert.equal(e.host, 'Jess');
  assert.equal(e.kind, 'invite');
  assert.equal(typeof e.email_ts, 'number');
});

test('parses an update to the same event id', () => {
  const e = parsePartifulEmail(UPDATE);
  assert.equal(e.event_id, 'partiful:AbC123xYz');
  assert.equal(e.kind, 'update');
  assert.equal(e.name, 'Rooftop Solstice 🌅');
});

test('parsePartifulEventPage extracts the embedded event object', () => {
  const nextData = {
    props: { pageProps: {
      event: {
        id: 'AbC123xYz', title: 'Rooftop Solstice 🌅',
        startDate: '2026-08-08T23:00:00.000Z', endDate: '2026-08-09T03:00:00.000Z',
        timezone: 'America/Chicago', description: 'bring a jacket',
        guestStatusCounts: { GOING: 24, MAYBE: 6 }, status: 'PUBLISHED',
      },
      hosts: [{ name: 'Jess' }],
    } },
  };
  const html = `<html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
  const e = parsePartifulEventPage(html, 'AbC123xYz');
  assert.equal(e.event_id, 'partiful:AbC123xYz');
  assert.equal(e.name, 'Rooftop Solstice 🌅');
  assert.equal(e.start_ts, Date.parse('2026-08-08T23:00:00.000Z'));
  assert.equal(e.end_ts, Date.parse('2026-08-09T03:00:00.000Z'));
  assert.equal(e.host, 'Jess');
  assert.equal(e.going, 24);
  assert.equal(e.kind, 'page');
});

test('parsePartifulEventPage returns null for a page without event data', () => {
  assert.equal(parsePartifulEventPage('<html><body>404</body></html>', 'x'), null);
});

test('returns null for non-partiful mail', () => {
  assert.equal(parsePartifulEmail(UNRELATED), null);
});

test('returns null for partiful mail without an event link', () => {
  assert.equal(parsePartifulEmail({ ...INVITE, text: 'Welcome to Partiful!' }), null);
});

// Real public-page shape (observed 2026-08-01): hosts is null for logged-out
// fetches, but ownerIds, the full status breakdown, and guest-list visibility
// flags are all present.
test('parsePartifulEventPage extracts owner ids, full counts, and visibility', () => {
  const payload = {
    props: { pageProps: {
      hosts: null,
      event: {
        title: 'no July 4th plans Plan',
        startDate: '2024-07-04T18:00:00.000Z',
        timezone: 'America/Chicago',
        ownerIds: ['MqBMxdEWoRQl1LOOLmdcaYdpJYm1'],
        guestStatusCounts: { GOING: 28, MAYBE: 8, DECLINED: 0, WAITLIST: 0, INTERESTED: 0 },
        attendedGuestCount: 28,
        hasGuests: true, showGuestList: true, visibility: 'public', status: 'PUBLISHED',
      },
    } },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  const e = parsePartifulEventPage(html, 'abc123');
  assert.equal(e.name, 'no July 4th plans Plan');
  assert.equal(e.host, null, 'host is not exposed to logged-out fetches');
  assert.deepEqual(e.owner_ids, ['MqBMxdEWoRQl1LOOLmdcaYdpJYm1'], 'owner id still identifies the host');
  assert.equal(e.going, 28);
  assert.equal(e.maybe, 8);
  assert.equal(e.attended, 28);
  assert.equal(e.show_guest_list, true);
  assert.equal(e.timezone, 'America/Chicago');
});
