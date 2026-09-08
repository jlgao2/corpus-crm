import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseEventText, isMasked, looksLikePlace } from './partiful-guests.js';

// Verbatim shape of a real rendered page (2026-08-01), where Demo had not
// RSVP'd — Partiful masks guest identities in that case.
const RESTRICTED = `Get the app
Create
Zara/Dani BIRTHDAYs
Saturday, May 3, 2025
1:00pm
ET
Hosted by
Dani Reeves
Zara Ahmed
Long Island City, NY
🚨UPDATE: it will be rainy on saturday
Guest List
38 Went · 12 Maybe
View all
Restricted Access
Only RSVP'd guests can view event activity & see who went
Activity
Xxxxx Xxxx 5/3/25
Xxxx rsvped Maybe ❤️‍🩹 5/3/25
Xxxxxxxx rsvped Going ❤️ 5/3/25`;

test('extracts hosts, venue and counts from a real page', () => {
  const p = parseEventText(RESTRICTED);
  assert.deepEqual(p.hosts, ['Dani Reeves', 'Zara Ahmed']);
  assert.equal(p.venue, 'Long Island City, NY');
  assert.equal(p.went, 38);
  assert.equal(p.maybe, 12);
});

test('respects the access control — masked guests are never recorded', () => {
  const p = parseEventText(RESTRICTED);
  assert.equal(p.restricted, true, 'restriction detected');
  assert.deepEqual(p.guests, [], 'no guest identities harvested from a restricted page');
});

test('records guests only when the page actually shows them', () => {
  const open = `Hosted by
Sam Fletcher
Chicago, IL
Guest List
4 Went
Activity
Maya Torres rsvped Going ❤️ 5/3/25
Riley Park rsvped Maybe ❤️‍🩹 5/3/25`;
  const p = parseEventText(open);
  assert.equal(p.restricted, false);
  assert.deepEqual(p.guests, [
    { name: 'Maya Torres', status: 'going' },
    { name: 'Riley Park', status: 'maybe' },
  ]);
});

test('isMasked recognises the placeholder pattern, not real names', () => {
  assert.ok(isMasked('Xxxxx Xxxx'));
  assert.ok(isMasked('X'));
  assert.ok(!isMasked('Dani Reeves'));
  assert.ok(!isMasked('Xavier Ramos'), 'a real name starting with X is not masked');
});

test('"Private Location" is a venue placeholder, never a host', () => {
  const p = parseEventText(`Hosted by
Claire Maki
Private Location
Guest List
12 Went`);
  assert.deepEqual(p.hosts, ['Claire Maki'], 'stops before the placeholder');
  assert.equal(p.venue, 'Private Location');
});

test('venue detection rejects activity chatter and stray letters', () => {
  assert.ok(looksLikePlace('58 Prospect Park W, Brooklyn, NY'));
  assert.ok(looksLikePlace('Long Island City, NY'));
  assert.ok(looksLikePlace('1041 w grand ave apt 4'));
  assert.ok(!looksLikePlace('Maybe: Demo User'), 'RSVP chatter is not a venue');
  assert.ok(!looksLikePlace('J'), 'a stray letter is not a venue');
  assert.ok(!looksLikePlace('Going'), 'an RSVP bucket is not a venue');
});
