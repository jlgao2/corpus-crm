import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { renderEventPage } from './event-page.js';
import { renderEventIndex } from './event-index.js';

// Real Google Photos paths contain spaces — the case that broke the old
// file:// rewrite (its regex stopped at the first whitespace).
const SPACY = '/Users/g/Projects/social-media-archive/google/Takeout-4/Google Photos/Photos from 2013/IMG_0568.JPG';
const b64 = (s) => Buffer.from(String(s)).toString('base64url');

test('event page emits served photo URLs, never raw file://', () => {
  const html = renderEventPage({
    event: { event_id: 'evt_x', start_ts: 0, end_ts: 1000, place_name: 'Melbourne', participants: [] },
    photos: [{ id: 'p1', ts: 0, asset_path: SPACY }],
    messages: [],
  });
  assert.ok(!html.includes('file://'), 'no raw file:// left in the page');
  assert.ok(html.includes(`/thumb/${b64(SPACY)}`), 'thumb URL present and encoded');
  assert.ok(html.includes(`/photo/${b64(SPACY)}`), 'full-res link present');
  // The encoded URL must survive inside the attribute — no spaces to break it.
  const m = html.match(/<img[^>]*src="([^"]+)"/);
  assert.ok(m && !/\s/.test(m[1]), 'src has no whitespace');
});

test('index links encode ids — a raw "partiful:x" href parses as a URI scheme', () => {
  const html = renderEventIndex([{
    event_id: 'partiful:abc123', start_ts: 0, end_ts: 1, place_name: null,
    participants_names: [], n_photos: 0, n_messages: 0, thumb_path: null,
  }]);
  assert.ok(html.includes('encodeURIComponent(e.id)'), 'href is encoded at render time');
  assert.ok(!/href="\\?\$\{e\.id\}/.test(html), 'no raw-id href left');
});

test('event index emits served thumb URLs in its data payload', () => {
  const html = renderEventIndex([{
    event_id: 'evt_x', start_ts: 0, end_ts: 1000, place_name: 'Melbourne',
    participants_names: [], n_photos: 3, n_messages: 0, thumb_path: SPACY,
  }]);
  assert.ok(!html.includes('file://'), 'no raw file:// in the index');
  assert.ok(html.includes(b64(SPACY)), 'encoded thumb path in the data');
});

test('videos render as a link, never a thumbnail that cannot exist', () => {
  const mov = '/x/Google Photos/Photos from 2013/IMG_0569.MOV';
  const html = renderEventPage({
    event: { event_id: 'evt_v', start_ts: 0, end_ts: 1, participants: [] },
    photos: [{ id: 'p1', ts: 0, asset_path: mov }],
    messages: [],
  });
  assert.ok(!html.includes(`/thumb/${b64(mov)}`), 'no thumb URL for a video');
  assert.ok(html.includes(`/photo/${b64(mov)}`), 'still linked to the file');
  assert.ok(html.includes('IMG_0569.MOV'), 'names the file');
});

test('detail lines and an external link render for photoless events', () => {
  const html = renderEventPage({
    event: { event_id: 'partiful:abc', start_ts: 0, end_ts: 1, summary: 'Birthday',
             participants: [], details: ['host: Someone', '38 going'], url: 'https://partiful.com/e/abc' },
    photos: [], messages: [],
  });
  assert.ok(html.includes('host: Someone') && html.includes('38 going'), 'details rendered');
  assert.ok(html.includes('https://partiful.com/e/abc'), 'external link rendered');
  assert.ok(!html.includes('0 photos'), 'no empty photo/message count on a photoless event');
});

test('photos without an asset path degrade without emitting a broken URL', () => {
  const html = renderEventPage({
    event: { event_id: 'evt_y', start_ts: 0, end_ts: 1, participants: [] },
    photos: [{ id: 'p1', ts: 0, asset_path: null }],
    messages: [],
  });
  assert.ok(!html.includes('/thumb/'), 'no thumb URL for a pathless photo');
});
