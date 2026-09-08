import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhatsappLive } from './whatsapp-live.js';

let dir;
const J = (o) => JSON.stringify(o) + '\n';
const msg = (over) => ({
  recordedAt: 1778292547686,
  kind: 'upsert',
  type: 'notify',
  message: {
    key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: false, id: 'MSG1' },
    messageTimestamp: 1778292547, // seconds
    pushName: 'Maya',
    message: { conversation: 'hello from live' },
    ...over,
  },
});

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-live-test-'));
  fs.writeFileSync(path.join(dir, 'contacts.jsonl'),
    J({ id: '15551000001@s.whatsapp.net', name: 'Maya Torres' })
    + J({ id: '15551000002@s.whatsapp.net', name: 'New Friend' }));
  fs.writeFileSync(path.join(dir, 'messages-20260508.jsonl'), [
    msg({}),
    msg({ key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: true, id: 'MSG2' }, messageTimestamp: 1778292600, message: { extendedTextMessage: { text: 'extended reply' } } }),
    // protocol noise — must be skipped
    msg({ key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: true, id: 'NOISE' }, message: { protocolMessage: { type: 'APP_STATE_SYNC_KEY_SHARE' } } }),
    // ephemeral wrapper — must unwrap
    msg({ key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: false, id: 'MSG3' }, messageTimestamp: 1778292700, message: { ephemeralMessage: { message: { conversation: 'disappearing but captured' } } } }),
    // image with caption
    msg({ key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: false, id: 'MSG4' }, messageTimestamp: 1778292800, message: { imageMessage: { caption: 'look at this' } } }),
    // older than the ios backup floor for this thread — must dedupe away
    msg({ key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: false, id: 'OLD' }, messageTimestamp: 1700000000, message: { conversation: 'already in backup' } }),
    // a thread the ios backup has never seen
    msg({ key: { remoteJid: '15551000002@s.whatsapp.net', fromMe: false, id: 'MSG5' }, messageTimestamp: 1778292900, message: { conversation: 'first contact' } }),
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function iosThreads() {
  return [{
    threadId: 'wai:15551000001@s.whatsapp.net',
    isGroup: false,
    participants: ['Maya Torres'],
    sources: ['whatsapp'],
    messages: [{ id: 'wai:15551000001@s.whatsapp.net#0', ts: 1750000000000, from: 'them', senderName: 'Maya Torres', body: 'old backup msg', threadId: 'wai:15551000001@s.whatsapp.net', source: 'whatsapp', isGroup: false, participants: ['Maya Torres'], attachmentType: null }],
  }];
}

test('merges live tail into the existing ios thread, floor-deduped', () => {
  const threads = parseWhatsappLive(dir, iosThreads());
  const maya = threads.find((t) => t.threadId === 'wai:15551000001@s.whatsapp.net');
  const bodies = maya.messages.map((m) => m.body);
  assert.ok(bodies.includes('old backup msg'), 'backup message kept');
  assert.ok(bodies.includes('hello from live'));
  assert.ok(bodies.includes('extended reply'));
  assert.ok(bodies.includes('disappearing but captured'));
  assert.ok(bodies.includes('look at this'));
  assert.ok(!bodies.includes('already in backup'), 'pre-floor live message deduped');
  const live = maya.messages.find((m) => m.body === 'hello from live');
  assert.equal(live.ts, 1778292547000, 'seconds converted to ms');
  assert.equal(live.from, 'them');
  assert.equal(live.senderName, 'Maya Torres', 'contact name preferred over pushName');
  assert.equal(live.source, 'whatsapp');
});

test('skips protocol noise entirely', () => {
  const threads = parseWhatsappLive(dir, iosThreads());
  const all = threads.flatMap((t) => t.messages);
  assert.ok(!all.some((m) => m.id.endsWith('#NOISE')));
});

test('creates threads the backup has never seen, named from contacts', () => {
  const threads = parseWhatsappLive(dir, iosThreads());
  const fresh = threads.find((t) => t.threadId === 'wai:15551000002@s.whatsapp.net');
  assert.ok(fresh);
  assert.deepEqual(fresh.participants, ['New Friend']);
  assert.equal(fresh.messages[0].body, 'first contact');
});

test('is idempotent — reparsing yields no duplicate message ids', () => {
  const threads = parseWhatsappLive(dir, iosThreads());
  const ids = threads.flatMap((t) => t.messages.map((m) => m.id));
  assert.equal(ids.length, new Set(ids).size);
});

test('recurses through per-machine spool directories and deduplicates overlap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-live-hosts-'));
  try {
    const laptop = path.join(root, 'laptop');
    const homelab = path.join(root, 'homelab');
    fs.mkdirSync(laptop, { recursive: true });
    fs.mkdirSync(homelab, { recursive: true });
    fs.writeFileSync(path.join(laptop, 'contacts.jsonl'),
      J({ id: '15551000001@s.whatsapp.net', name: 'Maya Torres' }));
    fs.writeFileSync(path.join(laptop, 'messages-20260508-laptop.jsonl'),
      J(msg({})));
    fs.writeFileSync(path.join(homelab, 'messages-20260508-homelab.jsonl'), [
      msg({}),
      msg({
        key: { remoteJid: '15551000001@s.whatsapp.net', fromMe: true, id: 'MSG6' },
        messageTimestamp: 1778293000,
        message: { conversation: 'captured on homelab' },
      }),
    ].map((item) => JSON.stringify(item)).join('\n') + '\n');

    const threads = parseWhatsappLive(root);
    const messages = threads.flatMap((thread) => thread.messages);
    assert.equal(messages.filter((item) => item.id.endsWith('#MSG1')).length, 1);
    assert.ok(messages.some((item) => item.body === 'captured on homelab'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails loudly on a malformed non-empty spool record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-live-invalid-'));
  try {
    fs.writeFileSync(path.join(root, 'messages-20260508.jsonl'), '{not json}\n');
    assert.throws(() => parseWhatsappLive(root), /invalid JSONL.*:1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
