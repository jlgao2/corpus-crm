import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { simpleParser } from 'mailparser';
import { parseGmailExport, addressList, firstAddressObj } from './gmail.js';
import { streamGmail } from './gmail.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

test('parseGmailExport keeps only the human thread from the fixture mbox', async () => {
  const threads = await parseGmailExport(FIXTURE_DIR);
  // newsletter (List-Unsubscribe) and noreply (Stripe) are dropped; only the Maya thread remains
  assert.equal(threads.length, 1);
  const t = threads[0];
  assert.equal(t.threadId, 'gmail:1000');
  assert.equal(t.isGroup, false);
  assert.deepEqual(t.participants, ['maya@example.com']);
  assert.equal(t.otherDisplayName, 'Maya Torres');
  assert.equal(t.messages.length, 2);
  assert.equal(t.messages[0].from, 'me');
  assert.equal(t.messages[0].senderName, 'Demo User');
  assert.equal(t.messages[1].from, 'them');
  assert.equal(t.messages[1].senderName, 'Maya Torres');
  // mailparser decoded the emoji correctly; we did NOT fixMojibake it
  assert.match(t.messages[1].body, /😊/);
});

test('parseGmailExport returns [] when no mbox present', async () => {
  const threads = await parseGmailExport(path.join(__dirname)); // dir has no .mbox
  assert.deepEqual(threads, []);
});

test('addressList normalizes single AddressObject, array of AddressObjects, and missing value', () => {
  assert.deepEqual(addressList(null), []);
  assert.deepEqual(addressList({ value: [{ address: 'A@x.com' }, { address: 'b@Y.com' }] }),
    ['a@x.com', 'b@y.com']);
  // multiple same-type header lines → mailparser returns an ARRAY of AddressObjects
  assert.deepEqual(addressList([
    { value: [{ address: 'a@x.com' }] },
    { value: [{ address: 'b@y.com' }] },
  ]), ['a@x.com', 'b@y.com']);
  assert.deepEqual(addressList({}), []);            // no .value
  assert.deepEqual(addressList({ value: [{}] }), []); // value entry without .address
});

test('firstAddressObj returns the first address+name across single or array shapes', () => {
  assert.equal(firstAddressObj(null), null);
  assert.deepEqual(firstAddressObj({ value: [{ address: 'a@x.com', name: 'A' }] }),
    { address: 'a@x.com', name: 'A' });
  assert.deepEqual(firstAddressObj([{ value: [] }, { value: [{ address: 'b@y.com', name: 'B' }] }]),
    { address: 'b@y.com', name: 'B' });
});

test('regression: real mailparser output with duplicate To headers does not throw', async () => {
  // Two separate `To:` lines make simpleParser return an ARRAY for parsed.to —
  // the shape that crashed the first real-data build (.value was undefined).
  const raw = 'From: A <a@x.com>\nTo: b@y.com\nTo: c@z.com\nSubject: hi\n\nbody';
  const parsed = await simpleParser(Buffer.from(raw));
  assert.deepEqual(addressList(parsed.to).sort(), ['b@y.com', 'c@z.com']);
});

test('streamGmail captures bulk + automated correspondents and meta from the fixture', async () => {
  const r = await streamGmail(FIXTURE_DIR);
  // threads unchanged — still the single human (Maya) thread
  assert.equal(r.threads.length, 1);
  assert.equal(r.counts.human, 2);
  assert.equal(r.counts.bulk, 1);
  assert.equal(r.counts.automated, 1);

  // correspondents: the newsletter (bulk) and Stripe (automated)
  const byAddr = Object.fromEntries(r.correspondents.map(c => [c.addr, c]));
  assert.ok(byAddr['newsletter@brand.com'], 'newsletter captured');
  assert.equal(byAddr['newsletter@brand.com'].kind, 'bulk');
  assert.equal(byAddr['newsletter@brand.com'].domain, 'brand.com');
  assert.equal(byAddr['newsletter@brand.com'].display_name, 'Cool Brand');
  assert.equal(byAddr['newsletter@brand.com'].list_unsubscribe, true);
  assert.equal(byAddr['newsletter@brand.com'].n_messages, 1);

  assert.ok(byAddr['no-reply@stripe.com'], 'stripe captured');
  assert.equal(byAddr['no-reply@stripe.com'].kind, 'automated');
  assert.equal(byAddr['no-reply@stripe.com'].list_unsubscribe, false);

  // email_meta: one row per bulk/automated message, with category from labels
  assert.equal(r.emailMeta.length, 2);
  const promo = r.emailMeta.find(m => m.category === 'promotions');
  assert.ok(promo, 'promotions category derived from X-Gmail-Labels');
  assert.equal(promo.kind, 'bulk');
});

test('parseGmailExport still returns just the threads (Phase-1 contract intact)', async () => {
  const threads = await parseGmailExport(FIXTURE_DIR);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].threadId, 'gmail:1000');
});

test('correspondent kind = bulk if sender EVER sent List-Unsubscribe (not first-seen)', async () => {
  // Same noreply address: automated (no list-unsub) message FIRST, then a bulk (list-unsub) one.
  // First-seen logic would mislabel this 'automated'; correct logic = 'bulk'.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmailkind-'));
  const mbox = [
    'From svc@x.com Mon Jan 01 10:00:00 2024',
    'From: Service <no-reply@svc.com>',
    'To: demo.user@example.com',
    'Subject: receipt',
    'Date: Mon, 1 Jan 2024 10:00:00 +0000',
    'Message-ID: <a1@svc.com>',
    '',
    'your receipt',
    '',
    'From svc@x.com Tue Jan 02 10:00:00 2024',
    'From: Service <no-reply@svc.com>',
    'To: demo.user@example.com',
    'Subject: deals',
    'Date: Tue, 2 Jan 2024 10:00:00 +0000',
    'Message-ID: <a2@svc.com>',
    'List-Unsubscribe: <https://svc.com/unsub>',
    '',
    'big sale',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'mail.mbox'), mbox);
  const r = await streamGmail(dir);
  const c = r.correspondents.find(x => x.addr === 'no-reply@svc.com');
  assert.ok(c, 'correspondent captured');
  assert.equal(c.n_messages, 2);
  assert.equal(c.list_unsubscribe, true);
  assert.equal(c.kind, 'bulk');   // ever-list-unsub wins; would be 'automated' under first-seen
});
