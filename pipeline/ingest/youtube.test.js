import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './youtube.js';

test('parseCsv handles simple rows', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3'), [['a','b','c'],['1','2','3']]);
});

test('parseCsv handles quoted fields with commas and escaped quotes', () => {
  assert.deepEqual(
    parseCsv('id,title\n1,"Wingfoil, Kitefoil & College"\n2,"She said ""hi"""'),
    [['id','title'],['1','Wingfoil, Kitefoil & College'],['2','She said "hi"']]
  );
});

test('parseCsv handles CRLF and a trailing newline', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a','b'],['1','2']]);
});

test('parseCsv handles newlines inside quoted fields', () => {
  assert.deepEqual(parseCsv('a,b\n"line1\nline2",x'), [['a','b'],['line1\nline2','x']]);
});

test('parseCsv returns [] for empty input', () => {
  assert.deepEqual(parseCsv(''), []);
});

import {
  parseYtDate, parseSubscriptions, parseChannel, parseVideos,
  parseMusicLibrary, parsePlaylists, parsePlaylistItems, parseComments,
} from './youtube.js';

test('parseYtDate parses YouTube ISO timestamps and returns null on junk', () => {
  assert.equal(parseYtDate('2026-03-01T21:47:52+00:00'), Date.parse('2026-03-01T21:47:52+00:00'));
  assert.equal(parseYtDate(''), null);
  assert.equal(parseYtDate('not a date'), null);
});

test('parseYtDate parses the Takeout history format (day-first, GMT offset)', () => {
  // "13 Jan 2019, 19:37:22 GMT-05:00" — normalized to a Date.parse-able form
  const t = parseYtDate('13 Jan 2019, 19:37:22 GMT-05:00');
  assert.equal(typeof t, 'number');
  assert.equal(t, Date.parse('13 Jan 2019 19:37:22 GMT-0500'));
});

test('parseSubscriptions maps header columns', () => {
  const csv = 'Channel ID,Channel URL,Channel title\nUC1,http://x/UC1,"Wingfoil, College"\nUC2,http://x/UC2,3Blue1Brown';
  assert.deepEqual(parseSubscriptions(csv), [
    { channel_id: 'UC1', channel_url: 'http://x/UC1', title: 'Wingfoil, College' },
    { channel_id: 'UC2', channel_url: 'http://x/UC2', title: '3Blue1Brown' },
  ]);
});

test('parseChannel returns the first data row', () => {
  const csv = 'Channel ID,Channel title (Original),Channel visibility\nUCself,Demo User,Public';
  assert.deepEqual(parseChannel(csv), { channel_id: 'UCself', title: 'Demo User', visibility: 'Public' });
});

test('parseChannel returns null with no data rows', () => {
  assert.equal(parseChannel('Channel ID,Channel title (Original),Channel visibility'), null);
});

test('parseVideos maps by header name and converts timestamps', () => {
  const csv = 'Video ID,Approx duration (ms),Video audio language,Video category,Video description (original),Channel ID,Tag 1,Tag 2,Video title (original),Privacy,Video state,Video create timestamp,Video publish timestamp\n'
    + 'vid1,581000,en,Comedy,desc here,UCself,,,Cooking Ep 1,Public,Processed,2022-07-03T09:41:17+00:00,2022-07-03T10:00:00+00:00';
  const v = parseVideos(csv);
  assert.equal(v.length, 1);
  assert.equal(v[0].video_id, 'vid1');
  assert.equal(v[0].duration_ms, 581000);
  assert.equal(v[0].category, 'Comedy');
  assert.equal(v[0].title, 'Cooking Ep 1');
  assert.equal(v[0].created_ts, Date.parse('2022-07-03T09:41:17+00:00'));
});

test('parseMusicLibrary collects non-empty artists into an array', () => {
  const csv = 'Video ID,Song Title,Album Title,Artist Name 1,Artist Name 2,Artist Name 3\n'
    + 'mv1,Something Goes Right,SBTRKT,SBTRKT,Sampha,';
  assert.deepEqual(parseMusicLibrary(csv), [
    { video_id: 'mv1', title: 'Something Goes Right', album: 'SBTRKT', artists: ['SBTRKT', 'Sampha'] },
  ]);
});

test('parsePlaylists maps wide header by name', () => {
  const csv = 'Playlist ID,Add new videos to top,Playlist description (original),Playlist title (original),Playlist create timestamp,Playlist update timestamp,Playlist visibility\n'
    + 'PL1,false,my desc,Lul,2011-06-13T00:00:00+00:00,2011-06-14T00:00:00+00:00,Public';
  assert.deepEqual(parsePlaylists(csv), [{
    playlist_id: 'PL1', title: 'Lul', description: 'my desc', visibility: 'Public',
    created_ts: Date.parse('2011-06-13T00:00:00+00:00'), updated_ts: Date.parse('2011-06-14T00:00:00+00:00'),
  }]);
});

test('parsePlaylistItems maps video id + added timestamp', () => {
  const csv = 'Video ID,Playlist video creation timestamp\nysJ82L,2026-03-01T21:47:52+00:00';
  assert.deepEqual(parsePlaylistItems(csv), [{ video_id: 'ysJ82L', added_ts: Date.parse('2026-03-01T21:47:52+00:00') }]);
});

test('parseComments maps by header name', () => {
  const csv = 'Comment ID,Channel ID,Comment create timestamp,Price,Parent comment ID,Video ID,Comment text,Top-level comment ID\n'
    + 'c1,UCself,2022-07-03T09:41:17+00:00,0,,vid1,nice video,';
  const c = parseComments(csv);
  assert.equal(c.length, 1);
  assert.equal(c[0].comment_id, 'c1');
  assert.equal(c[0].video_id, 'vid1');
  assert.equal(c[0].text, 'nice video');
  assert.equal(c[0].ts, Date.parse('2022-07-03T09:41:17+00:00'));
});

test('parseVideos coerces a non-numeric duration to null (no NaN)', () => {
  const csv = 'Video ID,Approx duration (ms),Video category,Video title (original)\nv1,notnum,Comedy,T';
  assert.equal(parseVideos(csv)[0].duration_ms, null);
});

test('rowsToObjects drops all-empty rows (stray commas / blank lines)', () => {
  const csv = 'Video ID,Playlist video creation timestamp\nv1,2026-03-01T21:47:52+00:00\n,,\n';
  assert.deepEqual(parsePlaylistItems(csv), [
    { video_id: 'v1', added_ts: Date.parse('2026-03-01T21:47:52+00:00') },
  ]);
});

import { parseWatchHistory, parseSearchHistory } from './youtube.js';

// Entry 1: available video — human title + channel link. Entry 2: removed video — URL as link text, no channel.
const WATCH_HTML = `
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid"><div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube<br></p></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched <a href="https://www.youtube.com/watch?v=apHMpr5miQc">cooking is for everyone</a><br><a href="https://www.youtube.com/channel/UC123abc">Some Channel</a><br>5 Jan 2024, 18:12:03 GMT-06:00<br></div><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div><div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;YouTube<br><b>Why is this here?</b><br>&emsp;This activity was saved&nbsp;<a href="https://myaccount.google.com/activitycontrols">here</a>.</div></div></div>
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid"><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched <a href="https://www.youtube.com/watch?v=chMWAh5Crqw">https://www.youtube.com/watch?v=chMWAh5Crqw</a><br>13 Jan 2019, 19:37:22 GMT-05:00<br></div></div></div>`;

test('parseWatchHistory: human title + channel when present; URL-title nulled + channel null when absent', () => {
  const w = parseWatchHistory(WATCH_HTML);
  assert.equal(w.length, 2);
  assert.equal(w[0].video_id, 'apHMpr5miQc');
  assert.equal(w[0].title, 'cooking is for everyone');
  assert.equal(w[0].channel_id, 'UC123abc');
  assert.equal(w[0].channel_name, 'Some Channel');
  assert.equal(typeof w[0].ts, 'number');
  assert.equal(w[1].video_id, 'chMWAh5Crqw');
  assert.equal(w[1].title, null);
  assert.equal(w[1].channel_id, null);
  assert.equal(w[1].channel_name, null);
  assert.equal(typeof w[1].ts, 'number');
});

const SEARCH_HTML = `
<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid"><div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Searched for <a href="https://www.youtube.com/results?search_query=21st+century+schizoid+man">21st century schizoid man</a><br>17 Dec 2018, 00:41:23 GMT-05:00<br></div><div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Why is this here?</b><br>&emsp;<a href="https://myaccount.google.com/activitycontrols">here</a></div></div></div>`;

test('parseSearchHistory extracts decoded query + timestamp, ignoring the caption cell', () => {
  const s = parseSearchHistory(SEARCH_HTML);
  assert.equal(s.length, 1);
  assert.equal(s[0].query, '21st century schizoid man');
  assert.equal(typeof s[0].ts, 'number');
});
