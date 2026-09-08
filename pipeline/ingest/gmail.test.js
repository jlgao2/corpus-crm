import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGeorge, isNoreply, parseHeaderBlock, headerValue,
  allAddresses, firstAddress, labelsFromHeaders, classifyMessage, threadKeyFromHeaders,
} from './gmail.js';

test('isGeorge matches Demo addresses case-insensitively', () => {
  assert.equal(isGeorge('demo.user@example.com'), true);
  assert.equal(isGeorge('demo.user@example.com'), true);
  assert.equal(isGeorge('maya@example.com'), false);
  assert.equal(isGeorge(null), false);
  assert.equal(isGeorge('jordan.kim@example.com'), false); // Jordan is NOT Demo
});

test('isNoreply detects automated senders', () => {
  assert.equal(isNoreply('no-reply@stripe.com'), true);
  assert.equal(isNoreply('noreply@github.com'), true);
  assert.equal(isNoreply('notifications@example.com'), true);
  assert.equal(isNoreply('maya@example.com'), false);
});

test('parseHeaderBlock unfolds continuation lines and lowercases keys', () => {
  const raw = 'From: Maya <maya@example.com>\nSubject: hi\n there\nX-GM-THRID: 12345';
  const m = parseHeaderBlock(raw);
  assert.equal(headerValue(m, 'from'), 'Maya <maya@example.com>');
  assert.equal(headerValue(m, 'subject'), 'hi there');     // folded line joined
  assert.equal(headerValue(m, 'x-gm-thrid'), '12345');
  assert.equal(headerValue(m, 'missing'), null);
});

test('address extraction', () => {
  assert.equal(firstAddress('Maya <Maya@example.com>'), 'maya@example.com');
  assert.deepEqual(
    allAddresses('A <a@x.com>, b@y.com, "C" <c@z.com>'),
    ['a@x.com', 'b@y.com', 'c@z.com']
  );
  assert.deepEqual(allAddresses(null), []);
});

test('labelsFromHeaders splits the comma-separated X-Gmail-Labels', () => {
  const m = parseHeaderBlock('X-Gmail-Labels: Important,Category updates,Unread');
  assert.deepEqual(labelsFromHeaders(m), ['Important', 'Category updates', 'Unread']);
});

test('classifyMessage: bulk wins, then automated, else human', () => {
  assert.equal(classifyMessage({ listUnsubscribe: true, fromAddr: 'x@y.com' }), 'bulk');
  assert.equal(classifyMessage({ listUnsubscribe: false, fromAddr: 'no-reply@y.com' }), 'automated');
  assert.equal(classifyMessage({ listUnsubscribe: false, fromAddr: 'maya@example.com' }), 'human');
  assert.equal(classifyMessage({ listUnsubscribe: true, fromAddr: 'no-reply@y.com' }), 'bulk');
});

test('threadKeyFromHeaders prefers X-GM-THRID, then references root, then message-id', () => {
  assert.equal(threadKeyFromHeaders(parseHeaderBlock('X-GM-THRID: 999')), '999');
  assert.equal(
    threadKeyFromHeaders(parseHeaderBlock('References: <a@x> <b@y>\nMessage-ID: <c@z>')),
    '<a@x>'
  );
  assert.equal(threadKeyFromHeaders(parseHeaderBlock('Message-ID: <only@z>')), '<only@z>');
});

import { buildThreads } from './gmail.js';

function rec(over) {
  return {
    thrid: 't1', ts: 1000, fromAddr: 'maya@example.com', fromName: 'Maya Torres',
    fromIsGeorge: false, toAddrs: ['demo.user@example.com'], ccAddrs: [],
    text: 'hello', hasRefs: false, ...over,
  };
}

test('buildThreads makes a 1-on-1 thread with correct direction and otherDisplayName', () => {
  const records = [
    rec({ ts: 1000, fromIsGeorge: true, fromAddr: 'demo.user@example.com', fromName: 'Demo User',
          toAddrs: ['maya@example.com'], text: 'hi maya' }),
    rec({ ts: 2000, fromIsGeorge: false, fromAddr: 'maya@example.com', fromName: 'Maya Torres',
          toAddrs: ['demo.user@example.com'], hasRefs: true, text: 'hi demo' }),
  ];
  const threads = buildThreads(records);
  assert.equal(threads.length, 1);
  const t = threads[0];
  assert.equal(t.threadId, 'gmail:t1');
  assert.equal(t.isGroup, false);
  assert.deepEqual(t.participants, ['maya@example.com']);
  assert.deepEqual(t.sources, ['gmail']);
  assert.equal(t.otherDisplayName, 'Maya Torres');
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0].from, 'me');
  assert.equal(t.messages[0].senderName, 'Demo User');
  assert.equal(t.messages[0].id, 'gmail:t1#0');
  assert.equal(t.messages[1].from, 'them');
  assert.equal(t.messages[1].senderName, 'Maya Torres');
  assert.equal(t.messages[1].source, 'gmail');
  assert.equal(t.messages[1].attachmentType, null);
});

test('buildThreads drops cold inbound (no Demo, no refs)', () => {
  const records = [rec({ thrid: 'cold', fromIsGeorge: false, hasRefs: false,
                         toAddrs: ['demo.user@example.com'] })];
  assert.equal(buildThreads(records).length, 0);
});

test('buildThreads keeps inbound that is part of a reply chain', () => {
  const records = [rec({ thrid: 'chain', fromIsGeorge: false, hasRefs: true })];
  const threads = buildThreads(records);
  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].participants, ['maya@example.com']);
});

test('buildThreads marks multi-party threads as groups', () => {
  const records = [
    rec({ thrid: 'g', ts: 1, fromIsGeorge: true, fromAddr: 'demo.user@example.com',
          toAddrs: ['maya@example.com', 'dav@example.com'] }),
    rec({ thrid: 'g', ts: 2, fromAddr: 'dav@example.com', fromName: 'Dav', hasRefs: true,
          toAddrs: ['demo.user@example.com', 'maya@example.com'] }),
  ];
  const t = buildThreads(records)[0];
  assert.equal(t.isGroup, true);
  assert.deepEqual([...t.participants].sort(), ['dav@example.com', 'maya@example.com']);
  assert.equal(t.otherDisplayName, undefined); // groups carry no single otherDisplayName
});

test('buildThreads caps body length and sorts by ts', () => {
  const long = 'x'.repeat(50000);
  const records = [
    rec({ thrid: 's', ts: 5000, text: 'second', hasRefs: true }),
    rec({ thrid: 's', ts: 1000, fromIsGeorge: true, fromAddr: 'demo.user@example.com',
          toAddrs: ['maya@example.com'], text: long }),
  ];
  const t = buildThreads(records)[0];
  assert.equal(t.messages[0].ts, 1000);
  assert.equal(t.messages[0].body.length, 20000);
  assert.equal(t.messages[1].body, 'second');
});

test('threadKeyFromHeaders falls through to nothrid when no thread headers present', () => {
  assert.equal(threadKeyFromHeaders(parseHeaderBlock('Subject: x')), 'nothrid');
});

test('classifyMessage defaults to human when fromAddr is null', () => {
  assert.equal(classifyMessage({ listUnsubscribe: false, fromAddr: null }), 'human');
});

import { domainOf, displayNameFromHeader, categoryFromLabels } from './gmail.js';

test('domainOf extracts the lowercased domain', () => {
  assert.equal(domainOf('Newsletter@Brand.com'), 'brand.com');
  assert.equal(domainOf('a@b.co.uk'), 'b.co.uk');
  assert.equal(domainOf(null), null);
  assert.equal(domainOf('no-at-sign'), null);
});

test('displayNameFromHeader pulls the name part, stripping quotes', () => {
  assert.equal(displayNameFromHeader('Cool Brand <newsletter@brand.com>'), 'Cool Brand');
  assert.equal(displayNameFromHeader('"Stripe, Inc." <no-reply@stripe.com>'), 'Stripe, Inc.');
  assert.equal(displayNameFromHeader('plain@example.com'), null);   // bare address, no name
  assert.equal(displayNameFromHeader(null), null);
});

test('categoryFromLabels returns the first Gmail Category label, lowercased word', () => {
  assert.equal(categoryFromLabels(['Important', 'Category promotions', 'Unread']), 'promotions');
  assert.equal(categoryFromLabels(['Category Updates']), 'updates');
  assert.equal(categoryFromLabels(['Inbox', 'Opened']), null);
  assert.equal(categoryFromLabels([]), null);
});
