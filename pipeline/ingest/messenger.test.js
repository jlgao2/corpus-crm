import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAllMessengerExports } from './messenger.js';

function writeThread(root, bucket, folder, messages, participants = ['Demo User', 'Alice']) {
  const dir = path.join(
    root,
    'your_facebook_activity',
    'messages',
    bucket,
    folder,
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'message_1.json'), JSON.stringify({
    participants: participants.map((name) => ({ name })),
    messages,
  }));
}

const message = (timestamp, content, sender = 'Alice') => ({
  sender_name: sender,
  timestamp_ms: timestamp,
  content,
});

test('merges overlapping incremental exports without replacing thread history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-merge-'));
  try {
    const inputs = path.join(root, 'inputs');
    const base = path.join(inputs, 'messenger', 'all-time');
    const incremental = path.join(inputs, 'messenger', 'incremental');

    writeThread(base, 'inbox', 'alice_1', [
      message(1, 'old history'),
      message(2, 'overlap'),
    ]);
    writeThread(incremental, 'inbox', 'alice_1', [
      message(2, 'overlap'),
      message(3, 'new tail'),
    ]);
    writeThread(incremental, 'inbox', 'bob_2', [
      message(4, 'new thread', 'Bob'),
    ], ['Demo User', 'Bob']);

    const threads = parseAllMessengerExports(inputs, root);
    const alice = threads.find((thread) => thread.threadId === 'fb:alice_1');
    const bob = threads.find((thread) => thread.threadId === 'fb:bob_2');

    assert.ok(alice);
    assert.deepEqual(alice.messages.map((item) => item.body), [
      'old history',
      'overlap',
      'new tail',
    ]);
    assert.deepEqual(alice.messages.map((item) => item.id), [
      'fb:alice_1#0',
      'fb:alice_1#1',
      'fb:alice_1#2',
    ]);
    assert.ok(bob);
    assert.equal(bob.messages[0].body, 'new thread');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deduplicates roots that resolve to the same export directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-realpath-'));
  try {
    const inputs = path.join(root, 'inputs');
    const exportRoot = path.join(inputs, 'messenger', 'base');
    writeThread(exportRoot, 'inbox', 'alice_1', [message(1, 'once')]);
    fs.symlinkSync(exportRoot, path.join(inputs, 'facebook-duplicate'));

    const threads = parseAllMessengerExports(inputs, root);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].messages.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses multiset union so genuine identical messages in one export survive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-multiset-'));
  try {
    const inputs = path.join(root, 'inputs');
    const base = path.join(inputs, 'messenger', 'all-time');
    const incremental = path.join(inputs, 'messenger', 'incremental');
    const repeated = message(1, 'same millisecond and body');

    writeThread(base, 'inbox', 'alice_1', [repeated, repeated]);
    writeThread(incremental, 'inbox', 'alice_1', [repeated, message(2, 'fresh')]);

    const [thread] = parseAllMessengerExports(inputs, root);
    assert.deepEqual(thread.messages.map((item) => item.body), [
      'same millisecond and body',
      'same millisecond and body',
      'fresh',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers exports that contain only a non-inbox bucket', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-filtered-'));
  try {
    const inputs = path.join(root, 'inputs');
    writeThread(
      path.join(inputs, 'facebook-filtered'),
      'filtered_threads',
      'request_1',
      [message(1, 'filtered but retained')],
    );

    const threads = parseAllMessengerExports(inputs, root);
    assert.equal(threads.length, 1);
    assert.equal(threads[0].messages[0].body, 'filtered but retained');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
