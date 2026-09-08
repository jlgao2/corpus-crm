import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentities } from './identity.js';

const NO_CONTACTS = { phones: {}, emails: {}, birthdays: [] };

function gmailThread(over) {
  return {
    threadId: 'gmail:1', isGroup: false, participants: ['maya@example.com'],
    sources: ['gmail'], otherDisplayName: 'Maya Torres', messages: [], ...over,
  };
}

test('gmail email becomes an email alias on its identity', () => {
  const { identities } = resolveIdentities([gmailThread()], NO_CONTACTS);
  const maya = identities.find(i => i.aliases.includes('maya@example.com'));
  assert.ok(maya, 'identity with the gmail email alias exists');
  assert.ok(maya.sources.includes('gmail'));
});

test('gmail display name is added as an alias (enables cross-channel name merge)', () => {
  const { identities } = resolveIdentities([gmailThread()], NO_CONTACTS);
  const maya = identities.find(i => i.aliases.includes('maya@example.com'));
  assert.ok(maya.aliases.includes('Maya Torres'), 'display name aliased');
});

test('gmail email resolves to a vCard name when present', () => {
  const contacts = { phones: {}, emails: { 'maya@example.com': 'Maya Torres' }, birthdays: [] };
  const { identities } = resolveIdentities([gmailThread({ otherDisplayName: null })], contacts);
  const maya = identities.find(i => i.aliases.includes('maya@example.com'));
  assert.ok(maya.aliases.includes('Maya Torres'), 'vCard name added as alias');
});

test('a gmail person merges with an iMessage person sharing the same name', () => {
  const imsg = {
    threadId: 'imsg:+155501001', isGroup: false, participants: ['+155501001'],
    sources: ['imessage'], messages: [],
  };
  const contacts = { phones: { '+155501001': 'Maya Torres' }, emails: {}, birthdays: [] };
  const { identities } = resolveIdentities([imsg, gmailThread()], contacts);
  const maya = identities.filter(i => i.aliases.includes('Maya Torres'));
  assert.equal(maya.length, 1, 'one merged Maya across imessage + gmail');
  assert.deepEqual([...maya[0].sources].sort(), ['gmail', 'imessage']);
});

test('name-variant identities merge case-insensitively (Marcus Chen == Marcus Chen)', () => {
  const ig = { threadId: 'ig:1', isGroup: false, participants: ['Marcus Chen'], sources: ['instagram'], messages: [] };
  const msgr = { threadId: 'msgr:1', isGroup: false, participants: ['Marcus Chen'], sources: ['messenger'], messages: [] };
  const { identities } = resolveIdentities([ig, msgr], NO_CONTACTS);
  const edwins = identities.filter(i => i.aliases.some(a => a.toLowerCase() === 'marcus chen'));
  assert.equal(edwins.length, 1, 'one merged Marcus across instagram + messenger');
  assert.deepEqual([...edwins[0].sources].sort(), ['instagram', 'messenger']);
});

test('merged name-variant prefers the properly-cased display name even when lowercase seen first', () => {
  const ig = { threadId: 'ig:1', isGroup: false, participants: ['Marcus Chen'], sources: ['instagram'], messages: [] };
  const msgr = { threadId: 'msgr:1', isGroup: false, participants: ['Marcus Chen'], sources: ['messenger'], messages: [] };
  const { identities } = resolveIdentities([ig, msgr], NO_CONTACTS);
  const marcus = identities.find(i => i.aliases.some(a => a.toLowerCase() === 'marcus chen'));
  assert.equal(marcus.displayName, 'Marcus Chen', 'prefers the Title-cased variant');
});

test('distinct phone identities are unaffected by case-insensitive name keys', () => {
  const a = { threadId: 'imsg:+155501002', isGroup: false, participants: ['+155501002'], sources: ['imessage'], messages: [] };
  const b = { threadId: 'imsg:+155501003', isGroup: false, participants: ['+155501003'], sources: ['imessage'], messages: [] };
  const { identities } = resolveIdentities([a, b], NO_CONTACTS);
  assert.equal(identities.length, 2, 'two distinct phone identities stay separate');
});
