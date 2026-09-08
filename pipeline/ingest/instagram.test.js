import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInstagramExport } from './instagram.js';

// offset 0: header datetime == header human, so HTML naive times are UTC.
const HEADER0 = `<div>Contains data you requested from <time datetime="2026-03-09T20:36Z">March 9, 2026 at 8:36 PM</time> to <time datetime="2026-06-09T20:36Z">June 9, 2026 at 8:36 PM</time></div>`;
const hblock = (sender, body, when) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${sender}</h2><div class="_3-95 _a6-p"><div>${body}</div></div><div class="_3-94 _a6-o">${when}</div></div>`;

function mk(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

test('parseInstagramExport merges HTML tail past each thread JSON cutoff; includes HTML-only threads', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-merge-'));
  const jsonRoot = path.join(base, 'json');
  const htmlRoot = path.join(base, 'html');
  const inbox = 'your_instagram_activity/messages/inbox';

  // JSON thread A: two messages, cutoff = May 15 2026
  mk(jsonRoot, `${inbox}/alice_1/message_1.json`, JSON.stringify({
    participants: [{ name: 'Demo User' }, { name: 'Alice' }],
    messages: [
      { sender_name: 'Alice', timestamp_ms: Date.UTC(2026, 4, 1), content: 'json-early' },
      { sender_name: 'Demo User', timestamp_ms: Date.UTC(2026, 4, 15), content: 'json-cutoff' },
    ],
  }));

  // HTML thread A (same folder): one before cutoff (drop), one after (keep)
  mk(htmlRoot, `${inbox}/alice_1/message_1.html`, `<html><body><h1>Alice</h1>${HEADER0}<main>
${hblock('Alice', 'html-DROP-before-cutoff', 'May 10, 2026 12:00 pm')}
${hblock('Alice', 'html-KEEP-after-cutoff', 'June 1, 2026 12:00 pm')}
</main></body></html>`);

  // HTML-only thread B
  mk(htmlRoot, `${inbox}/bob_2/message_1.html`, `<html><body><h1>Bob</h1>${HEADER0}<main>
${hblock('Bob', 'html-only-msg', 'May 20, 2026 9:00 am')}
</main></body></html>`);

  const threads = parseInstagramExport(jsonRoot, htmlRoot);
  const byId = Object.fromEntries(threads.map(t => [t.threadId, t]));

  const a = byId['ig:alice_1'];
  assert.ok(a, 'thread A present');
  const bodies = a.messages.map(m => m.body);
  assert.deepEqual(bodies, ['json-early', 'json-cutoff', 'html-KEEP-after-cutoff'], 'json kept + only post-cutoff html appended, in ts order');
  assert.ok(!bodies.includes('html-DROP-before-cutoff'), 'pre-cutoff html dropped (dedup)');
  // ids unique + sequential
  assert.deepEqual(a.messages.map(m => m.id), ['ig:alice_1#0', 'ig:alice_1#1', 'ig:alice_1#2']);

  const b = byId['ig:bob_2'];
  assert.ok(b, 'HTML-only thread B included');
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].body, 'html-only-msg');
  assert.equal(b.participants[0], 'Bob');
});

test('parseInstagramExport without htmlRoot is unchanged (JSON only)', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-jsononly-'));
  const inbox = 'your_instagram_activity/messages/inbox';
  mk(base, `${inbox}/carol_3/message_1.json`, JSON.stringify({
    participants: [{ name: 'Demo User' }, { name: 'Carol' }],
    messages: [{ sender_name: 'Carol', timestamp_ms: Date.UTC(2026, 0, 1), content: 'hi' }],
  }));
  const threads = parseInstagramExport(base);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].messages[0].body, 'hi');
});
