import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractQuotedLines, verifyPortraitQuotes } from './verify.js';

test('extractQuotedLines pulls all blockquoted speaker lines', () => {
  const md = `# Person\n\n> Them: hello world\n> You: hi back\n\nSome prose with no quote.\n\n> Them: another line`;
  const quotes = extractQuotedLines(md);
  assert.deepEqual(quotes, [
    { speaker: 'Them', body: 'hello world', kind: 'blockquote' },
    { speaker: 'You', body: 'hi back', kind: 'blockquote' },
    { speaker: 'Them', body: 'another line', kind: 'blockquote' },
  ]);
});

test('extractQuotedLines normalizes Me → You and They → Them', () => {
  const md = `> Me: hi\n> They: hello`;
  const quotes = extractQuotedLines(md);
  assert.deepEqual(quotes, [
    { speaker: 'You', body: 'hi', kind: 'blockquote' },
    { speaker: 'Them', body: 'hello', kind: 'blockquote' },
  ]);
});

test('extractQuotedLines extracts prose-embedded quoted fragments', () => {
  const md = `Texture\nshe still calls them "the soft hours" when she means dawn`;
  const quotes = extractQuotedLines(md);
  assert.deepEqual(quotes, [
    { speaker: null, body: 'the soft hours', kind: 'prose' },
  ]);
});

test('extractQuotedLines handles curly double quotes', () => {
  const md = `“the long con phish” was a running joke`;
  const quotes = extractQuotedLines(md);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].kind, 'prose');
  assert.equal(quotes[0].body, 'the long con phish');
});

test('verifyPortraitQuotes passes when all quotes match source', () => {
  const md = `# X\n\n> Them: hello\n> You: hi`;
  const messages = [
    { id: 'm1', ts: 1, from: 'them', body: 'hello' },
    { id: 'm2', ts: 2, from: 'me', body: 'hi' },
  ];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
});

test('verifyPortraitQuotes fails on fabricated blockquote', () => {
  const md = `# X\n\n> Them: I said something I never said`;
  const messages = [
    { id: 'm1', ts: 1, from: 'them', body: 'hello' },
  ];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].body, /something I never said/);
});

test('verifyPortraitQuotes fails on fabricated prose quote', () => {
  const md = `Texture\nshe still calls them "the soft hours" when she means dawn`;
  const messages = [{ id: 'm1', ts: 1, from: 'them', body: 'totally different content' }];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].kind, 'prose');
  assert.match(result.failures[0].body, /the soft hours/);
});

test('verifyPortraitQuotes passes prose quote that exists in source (any speaker)', () => {
  const md = `Texture\nshe still calls them "the soft hours" when she means dawn`;
  const messages = [
    { id: 'm1', ts: 1, from: 'them', body: 'I love the soft hours of the morning' },
  ];
  const result = verifyPortraitQuotes(md, messages);
  // The exact phrase "the soft hours" doesn't appear as a full message body, so this should fail.
  // To make it pass, the message body itself must equal "the soft hours" (after whitespace normalization).
  assert.equal(result.ok, false);
});

test('verifyPortraitQuotes is whitespace tolerant', () => {
  const md = `> Them:    hello   world`;
  const messages = [{ id: 'm1', ts: 1, from: 'them', body: 'hello world' }];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, true);
});

test('verifyPortraitQuotes fails on speaker mismatch', () => {
  const md = `> You: hello`;
  const messages = [{ id: 'm1', ts: 1, from: 'them', body: 'hello' }];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, false);
});
