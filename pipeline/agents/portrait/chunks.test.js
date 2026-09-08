import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkByTimeWindow } from './chunks.js';

const ms = (iso) => new Date(iso).getTime();

test('splits one year into ~four quarter chunks', () => {
  const messages = [];
  for (let i = 0; i < 100; i++) {
    const month = (i % 12) + 1;
    messages.push({ id: `m${i}`, ts: ms(`2024-${String(month).padStart(2, '0')}-15T12:00:00Z`), body: `msg ${i}` });
  }
  messages.sort((a, b) => a.ts - b.ts);
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.ok(chunks.length >= 3 && chunks.length <= 5, `expected ~4 chunks, got ${chunks.length}`);
  const total = chunks.reduce((s, c) => s + c.messages.length, 0);
  assert.equal(total, 100);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startTs >= chunks[i - 1].endTs - 1);
  }
});

test('splits dense window into sub-chunks when over maxPerChunk', () => {
  const messages = [];
  for (let i = 0; i < 1500; i++) {
    messages.push({ id: `m${i}`, ts: ms(`2024-06-15T12:00:00Z`) + i * 1000, body: `msg ${i}` });
  }
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.ok(chunks.length >= 3, `expected at least 3 sub-chunks for 1500 messages, got ${chunks.length}`);
  for (const c of chunks) assert.ok(c.messages.length <= 600, `chunk has ${c.messages.length} > 600`);
});

test('merges sparse periods into one chunk', () => {
  const messages = [];
  for (const m of [3, 6, 9, 12]) {
    messages.push({ id: `m${m}a`, ts: ms(`2024-${String(m).padStart(2, '0')}-15T12:00:00Z`), body: 'a' });
    messages.push({ id: `m${m}b`, ts: ms(`2024-${String(m).padStart(2, '0')}-16T12:00:00Z`), body: 'b' });
  }
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.ok(chunks.length <= 2, `expected merged into 1-2 chunks, got ${chunks.length}`);
});

test('handles empty input', () => {
  const chunks = chunkByTimeWindow([], { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.deepEqual(chunks, []);
});

test('merges a sparse tail after a dense window', () => {
  const messages = [];
  // 800 messages in one quarter (will split into two ~400-msg sub-chunks)
  for (let i = 0; i < 800; i++) {
    messages.push({ id: `m${i}`, ts: ms(`2024-06-15T12:00:00Z`) + i * 1000, body: `dense ${i}` });
  }
  // Then a tiny tail in the next quarter
  for (let i = 0; i < 3; i++) {
    messages.push({ id: `tail${i}`, ts: ms(`2024-10-15T12:00:00Z`) + i * 1000, body: `tail ${i}` });
  }
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  // The 3-message tail should be absorbed into the prior chunk, not orphaned
  for (const c of chunks) {
    assert.ok(c.messages.length >= 5 || chunks.indexOf(c) === 0,
      `chunk ${chunks.indexOf(c)} has ${c.messages.length} messages — expected merge`);
  }
  // Total preserved
  const total = chunks.reduce((s, c) => s + c.messages.length, 0);
  assert.equal(total, 803);
});
