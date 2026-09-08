#!/usr/bin/env node
/**
 * Build the YouTube interest/content layer on top of messages.duckdb.
 *
 *   node pipeline/build-youtube.js
 *
 * Idempotent: DROPs + recreates all yt_* tables each run (like build-connections).
 * Must run AFTER build-db (needs the DB file + Demo's identity for is_self link).
 * Reads the Takeout YouTube dir from inputs/youtube (symlink).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  parseSubscriptions, parseChannel, parseVideos, parseMusicLibrary,
  parsePlaylists, parsePlaylistItems, parseComments,
  parseWatchHistory, parseSearchHistory,
} from './ingest/youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(__dirname, 'output');
const DB_PATH = path.join(OUTPUT, 'raw', 'messages.duckdb');
const YT_DIR = path.join(ROOT, 'inputs', 'youtube');
const OUT_JSON = path.join(OUTPUT, 'youtube.json');

function escSql(s) { if (s == null) return 'NULL'; return "'" + String(s).replace(/'/g, "''") + "'"; }
function readIf(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }

const YT_STOP = new Set(('the a an and or of to in on at for with i you your we my is are be it this that'
  + ' how what why de la el ft feat official video lyrics audio music live full hd vs from new').split(/\s+/));
const ytTokens = s => (String(s || '').toLowerCase().match(/[a-z][a-z'+&-]{2,}/g) || []);

// ── pure: derive a multi-facet interest rollup from YouTube signals ──
// kinds: category (video metadata), topic (keywords from watch titles),
// channel (most-watched channels), artist (top music artists).
export function deriveTopics({ videos = [], watch = [], songs = [] } = {}) {
  const out = [];
  const rollup = (kind, map, { min = 1, top }) => {
    const pairs = [...map.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1]).slice(0, top);
    const total = pairs.reduce((a, [, n]) => a + n, 0) || 1;
    for (const [topic, count] of pairs) out.push({ kind, topic, count, weight: count / total });
  };
  const tally = (items, keyFn) => { const m = new Map(); for (const it of items) { const k = keyFn(it); if (k) m.set(k, (m.get(k) || 0) + 1); } return m; };
  // category — from video metadata
  rollup('category', tally(videos, v => String(v.category || '').trim().toLowerCase()), { top: 25 });
  // topic — keywords from watch-history titles
  const kw = new Map();
  for (const w of watch) for (const t of new Set(ytTokens(w.title))) if (!YT_STOP.has(t)) kw.set(t, (kw.get(t) || 0) + 1);
  rollup('topic', kw, { min: 5, top: 40 });
  // channel — most-watched channels
  rollup('channel', tally(watch, w => String(w.channel_name || '').trim()), { min: 3, top: 30 });
  // artist — top music artists
  const ar = new Map();
  for (const s of songs) for (const a of (s.artists || [])) { const k = String(a || '').trim(); if (k) ar.set(k, (ar.get(k) || 0) + 1); }
  rollup('artist', ar, { min: 2, top: 30 });
  return out;
}

// ── pure: roll up the parsed collections into the youtube.json shape ──
export function summarizeYoutube(d) {
  return {
    channels: d.channels.length,
    self_channel: (d.channels.find(c => c.is_self) || {}).title || null,
    subscriptions: d.subscriptions.length,
    videos: d.videos.length,
    songs: d.songs.length,
    playlists: d.playlists.length,
    comments: d.comments.length,
    watch_entries: d.watch.length,
    search_entries: d.search.length,
    top_topics: d.topics.filter(t => t.kind === 'topic' || t.kind === 'category').slice(0, 25),
    top_channels: d.topics.filter(t => t.kind === 'channel').slice(0, 15),
    top_artists: d.topics.filter(t => t.kind === 'artist').slice(0, 15),
    top_subscriptions: d.subscriptions.slice(0, 50).map(s => ({ channel_id: s.channel_id, title: s.title })),
  };
}

function listPlaylistItemFiles(playlistsDir) {
  if (!fs.existsSync(playlistsDir)) return [];
  return fs.readdirSync(playlistsDir)
    .filter(f => / videos\.csv$/.test(f))   // "<name> videos.csv"
    .map(f => ({ name: f.replace(/ videos\.csv$/, ''), file: path.join(playlistsDir, f) }));
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  if (!fs.existsSync(YT_DIR)) {
    console.error(`No inputs/youtube dir. Symlink the Takeout YouTube folder there first.`);
    process.exit(1);
  }

  // Locate files (tolerate missing ones).
  const subsCsv = readIf(path.join(YT_DIR, 'subscriptions', 'subscriptions.csv'));
  const chanCsv = readIf(path.join(YT_DIR, 'channels', 'channel.csv'));
  const vidsCsv = readIf(path.join(YT_DIR, 'Video metadata', 'videos.csv'));
  const musicCsv = readIf(path.join(YT_DIR, 'music (library and uploads)', 'music library songs.csv'));
  const playlistsCsv = readIf(path.join(YT_DIR, 'playlists', 'playlists.csv'));
  const commentsCsv = readIf(path.join(YT_DIR, 'comments', 'comments.csv'));
  const watchHtml = readIf(path.join(YT_DIR, 'history', 'watch-history.html'));
  const searchHtml = readIf(path.join(YT_DIR, 'history', 'search-history.html'));

  const subscriptions = subsCsv ? parseSubscriptions(subsCsv) : [];
  const channelSelf = chanCsv ? parseChannel(chanCsv) : null;
  const videos = vidsCsv ? parseVideos(vidsCsv) : [];
  const songs = musicCsv ? parseMusicLibrary(musicCsv) : [];
  const playlists = playlistsCsv ? parsePlaylists(playlistsCsv) : [];
  const comments = commentsCsv ? parseComments(commentsCsv) : [];
  const watch = watchHtml ? parseWatchHistory(watchHtml) : [];
  const search = searchHtml ? parseSearchHistory(searchHtml) : [];

  const playlistItems = [];
  for (const { name, file } of listPlaylistItemFiles(path.join(YT_DIR, 'playlists'))) {
    for (const it of parsePlaylistItems(fs.readFileSync(file, 'utf-8'))) {
      playlistItems.push({ playlist_name: name, ...it });
    }
  }

  // is_song flag: a video id present in the music library.
  const songIds = new Set(songs.map(s => s.video_id));
  for (const v of videos) v.is_song = songIds.has(v.video_id);

  const channels = [];
  if (channelSelf) channels.push({ ...channelSelf, is_self: true });

  const topics = deriveTopics({ videos, watch, songs });

  const inst = await DuckDBInstance.create(DB_PATH); // read-write
  const conn = await inst.connect();

  await conn.run(`
    DROP TABLE IF EXISTS yt_channels; DROP TABLE IF EXISTS yt_subscriptions;
    DROP TABLE IF EXISTS yt_videos; DROP TABLE IF EXISTS yt_songs;
    DROP TABLE IF EXISTS yt_playlists; DROP TABLE IF EXISTS yt_playlist_items;
    DROP TABLE IF EXISTS yt_comments; DROP TABLE IF EXISTS yt_activity;
    DROP TABLE IF EXISTS yt_topics;
    CREATE TABLE yt_channels (channel_id VARCHAR PRIMARY KEY, title VARCHAR, visibility VARCHAR, is_self BOOLEAN, canonical_id VARCHAR);
    CREATE TABLE yt_subscriptions (channel_id VARCHAR, channel_url VARCHAR, title VARCHAR);
    CREATE TABLE yt_videos (video_id VARCHAR PRIMARY KEY, title VARCHAR, description VARCHAR, channel_id VARCHAR, duration_ms BIGINT, category VARCHAR, language VARCHAR, privacy VARCHAR, state VARCHAR, created_ts BIGINT, published_ts BIGINT, is_song BOOLEAN);
    CREATE TABLE yt_songs (video_id VARCHAR PRIMARY KEY, title VARCHAR, album VARCHAR, artists VARCHAR[], added_ts BIGINT);
    CREATE TABLE yt_playlists (playlist_id VARCHAR PRIMARY KEY, title VARCHAR, description VARCHAR, visibility VARCHAR, created_ts BIGINT, updated_ts BIGINT);
    CREATE TABLE yt_playlist_items (playlist_name VARCHAR, video_id VARCHAR, added_ts BIGINT);
    CREATE TABLE yt_comments (comment_id VARCHAR PRIMARY KEY, channel_id VARCHAR, video_id VARCHAR, text VARCHAR, parent_comment_id VARCHAR, ts BIGINT);
    CREATE TABLE yt_activity (kind VARCHAR, video_id VARCHAR, title VARCHAR, channel_id VARCHAR, channel_name VARCHAR, query VARCHAR, ts BIGINT);
    CREATE TABLE yt_topics (kind VARCHAR, topic VARCHAR, count INTEGER, weight DOUBLE);
    CREATE INDEX idx_yt_activity_kind ON yt_activity(kind);
    CREATE INDEX idx_yt_videos_channel ON yt_videos(channel_id);
  `);

  // Demo's canonical_id (best-effort) so the self channel links to the person graph.
  let selfCanon = null;
  try {
    const r = await conn.runAndReadAll(
      `SELECT canonical_id FROM identities WHERE lower(display_name) IN ('Demo User','demo') LIMIT 1`);
    if (r.getRows().length) selfCanon = r.getRows()[0][0];
  } catch { /* identities table absent — leave null */ }

  // Wrap all inserts in one transaction — DuckDB autocommits every statement
  // otherwise, which dominates the cost across the ~12k+ activity/song rows.
  await conn.run('BEGIN TRANSACTION');

  for (const c of channels) {
    await conn.run(`INSERT INTO yt_channels VALUES (${escSql(c.channel_id)}, ${escSql(c.title)}, ${escSql(c.visibility)}, ${c.is_self === true}, ${escSql(c.is_self ? selfCanon : null)}) ON CONFLICT DO NOTHING`);
  }
  for (const s of subscriptions) {
    await conn.run(`INSERT INTO yt_subscriptions VALUES (${escSql(s.channel_id)}, ${escSql(s.channel_url)}, ${escSql(s.title)})`);
  }
  for (const v of videos) {
    await conn.run(`INSERT INTO yt_videos VALUES (${escSql(v.video_id)}, ${escSql(v.title)}, ${escSql(v.description)}, ${escSql(v.channel_id)}, ${v.duration_ms ?? 'NULL'}, ${escSql(v.category)}, ${escSql(v.language)}, ${escSql(v.privacy)}, ${escSql(v.state)}, ${v.created_ts ?? 'NULL'}, ${v.published_ts ?? 'NULL'}, ${v.is_song === true}) ON CONFLICT DO NOTHING`);
  }
  for (const s of songs) {
    const arts = `[${(s.artists || []).map(escSql).join(',')}]`;
    await conn.run(`INSERT INTO yt_songs VALUES (${escSql(s.video_id)}, ${escSql(s.title)}, ${escSql(s.album)}, ${arts}, ${s.added_ts ?? 'NULL'}) ON CONFLICT DO NOTHING`);
  }
  for (const p of playlists) {
    await conn.run(`INSERT INTO yt_playlists VALUES (${escSql(p.playlist_id)}, ${escSql(p.title)}, ${escSql(p.description)}, ${escSql(p.visibility)}, ${p.created_ts ?? 'NULL'}, ${p.updated_ts ?? 'NULL'}) ON CONFLICT DO NOTHING`);
  }
  for (const it of playlistItems) {
    await conn.run(`INSERT INTO yt_playlist_items VALUES (${escSql(it.playlist_name)}, ${escSql(it.video_id)}, ${it.added_ts ?? 'NULL'})`);
  }
  for (const c of comments) {
    await conn.run(`INSERT INTO yt_comments VALUES (${escSql(c.comment_id)}, ${escSql(c.channel_id)}, ${escSql(c.video_id)}, ${escSql(c.text)}, ${escSql(c.parent_comment_id)}, ${c.ts ?? 'NULL'}) ON CONFLICT DO NOTHING`);
  }
  for (const w of watch) {
    await conn.run(`INSERT INTO yt_activity VALUES ('watch', ${escSql(w.video_id)}, ${escSql(w.title)}, ${escSql(w.channel_id)}, ${escSql(w.channel_name)}, NULL, ${w.ts ?? 'NULL'})`);
  }
  for (const s of search) {
    await conn.run(`INSERT INTO yt_activity VALUES ('search', NULL, NULL, NULL, NULL, ${escSql(s.query)}, ${s.ts ?? 'NULL'})`);
  }
  for (const t of topics) {
    await conn.run(`INSERT INTO yt_topics VALUES (${escSql(t.kind)}, ${escSql(t.topic)}, ${t.count}, ${t.weight})`);
  }

  await conn.run('COMMIT');

  await conn.disconnectSync();

  const summary = { generated: new Date().toISOString(), ...summarizeYoutube({ channels, subscriptions, videos, songs, playlists, comments, watch, search, topics }) };
  fs.writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));
  console.log(`YouTube: ${subscriptions.length} subs, ${videos.length} videos, ${songs.length} songs, `
    + `${playlists.length} playlists (${playlistItems.length} items), ${comments.length} comments, `
    + `${watch.length} watched, ${search.length} searches, ${topics.length} topics → wrote youtube.json`);
}

if (process.argv[1] && process.argv[1].endsWith('build-youtube.js')) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
