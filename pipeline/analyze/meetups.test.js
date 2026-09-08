import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { findMeetupCandidates, confirmWindow, MEETUP_MARKERS } from './meetups.js';

const H = 3600 * 1000;
const T = 1700000000000; // 2023-11-14 22:13 UTC

const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10);

function msg(id, ts, thread_id, from_me, body) {
  return { id, ts, thread_id, from_me, body };
}

test('marker + both sides active in a thread-day -> one candidate', () => {
  const msgs = [
    msg('a1', T, 'th-1', true, 'omw now'),
    msg('a2', T + 0.2 * H, 'th-1', false, 'great, table at the back'),
    msg('a3', T + 1.5 * H, 'th-1', true, 'that was lovely'),
  ];
  const cands = findMeetupCandidates(msgs, { dayKeyFn: utcDay });
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.thread_id, 'th-1');
  assert.equal(c.day, utcDay(T));
  assert.equal(c.start_ts, T, 'starts at the first marker');
  assert.equal(c.end_ts, T + 1.5 * H, 'ends at the last message of the day');
  assert.deepEqual(c.message_ids, ['a1', 'a2', 'a3']);
  assert.deepEqual(c.marker_ids, ['a1']);
});

test('one-sided chatter never becomes a candidate', () => {
  const msgs = [
    msg('b1', T, 'th-1', true, 'omw'),
    msg('b2', T + 0.5 * H, 'th-1', true, 'here now'),
  ];
  assert.deepEqual(findMeetupCandidates(msgs, { dayKeyFn: utcDay }), []);
});

test('no marker -> no candidate, even with lively two-way chat', () => {
  const msgs = [
    msg('c1', T, 'th-1', true, 'how are you'),
    msg('c2', T + 0.1 * H, 'th-1', false, 'good! you?'),
  ];
  assert.deepEqual(findMeetupCandidates(msgs, { dayKeyFn: utcDay }), []);
});

test('markers are word-bounded — "homework" is not "omw"', () => {
  const low = 'homework was brutal';
  assert.ok(!MEETUP_MARKERS.some(re => re.test(low)));
  assert.ok(MEETUP_MARKERS.some(re => re.test('omw to yours')));
  assert.ok(MEETUP_MARKERS.some(re => re.test("i'm outside")));
  assert.ok(MEETUP_MARKERS.some(re => re.test('see you at 7')));
  assert.ok(MEETUP_MARKERS.some(re => re.test('be there in 10')));
});

test('separate threads and separate local days stay separate candidates', () => {
  const msgs = [
    msg('d1', T, 'th-1', true, 'omw'),
    msg('d2', T + 0.1 * H, 'th-1', false, 'yay'),
    msg('d3', T + 48 * H, 'th-1', true, 'on my way again'),
    msg('d4', T + 48.1 * H, 'th-1', false, 'door is open'),
    msg('d5', T, 'th-2', false, 'see you there'),
    msg('d6', T + 0.1 * H, 'th-2', true, 'yes!'),
  ];
  const cands = findMeetupCandidates(msgs, { dayKeyFn: utcDay });
  assert.equal(cands.length, 3);
  const keys = cands.map(c => `${c.thread_id}|${c.day}`).sort();
  assert.deepEqual(keys, [`th-1|${utcDay(T)}`, `th-1|${utcDay(T + 48 * H)}`, `th-2|${utcDay(T)}`]);
});

test('iOS curly apostrophes match the apostrophe markers', () => {
  const msgs = [
    msg('f1', T, 'th-1', true, 'i’m outside'),
    msg('f2', T + 0.1 * H, 'th-1', false, 'coming down'),
  ];
  assert.equal(findMeetupCandidates(msgs, { dayKeyFn: utcDay }).length, 1);
});

test('confirmWindow keeps the first marker inside a bounded slice', () => {
  const msgs = [];
  for (let i = 0; i < 300; i++) msgs.push(msg(`g${i}`, T + i * 60000, 'th-1', i % 2 === 0, 'chatter'));
  msgs[250] = msg('g250', T + 250 * 60000, 'th-1', true, 'omw');
  const win = confirmWindow(msgs, ['g250'], 60);
  assert.equal(win.length, 60);
  assert.ok(win.some(m => m.id === 'g250'), 'marker inside the window');
  assert.equal(win[0].id, 'g230', 'window starts 20 messages of context before the marker');
});

test('dayKeyFn buckets by the caller-supplied local day, not UTC', () => {
  // 22:13 UTC and 03:13 UTC next day are the same Melbourne evening+night.
  const melDay = () => '2023-11-15';
  const msgs = [
    msg('e1', T, 'th-1', true, 'omw'),
    msg('e2', T + 5 * H, 'th-1', false, 'that was fun'),
  ];
  const cands = findMeetupCandidates(msgs, { dayKeyFn: melDay });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].day, '2023-11-15');
});
