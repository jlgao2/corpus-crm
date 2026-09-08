/**
 * YouTube Takeout parsers (pure). CSV is hand-parsed (RFC-4180-ish) to avoid a
 * dependency; the only real complication is quoted fields containing commas,
 * quotes, or newlines. The watch/search history HTML is small enough (≤10 MB)
 * to read into memory and regex-scan.
 */

// Minimal RFC-4180 CSV parser. Returns an array of rows; each row an array of
// string cells. Handles "quoted" cells with embedded commas, newlines, and ""
// escaped quotes. Skips a single trailing newline.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  const s = String(text);
  let i = 0;
  let started = false; // whether the current record has any content
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; started = true; i++; continue; }
    if (ch === ',') { row.push(cell); cell = ''; started = true; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(cell); rows.push(row);
      row = []; cell = ''; started = false; i++; continue;
    }
    cell += ch; started = true; i++;
  }
  // flush last cell/row if the file didn't end with a newline
  if (started || cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseYtDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  if (!str) return null;
  // ISO (CSV timestamps) parse directly.
  let t = Date.parse(str);
  if (!Number.isNaN(t)) return t;
  // Takeout history format: "13 Jan 2019, 19:37:22 GMT-05:00".
  // Drop the comma and de-colon the offset so V8 Date.parse accepts it.
  const norm = str.replace(',', '').replace(/(GMT[+-]\d{2}):(\d{2})/, '$1$2');
  t = Date.parse(norm);
  return Number.isNaN(t) ? null : t;
}

// Turn parseCsv output into an array of objects keyed by header name.
function rowsToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter(r => r.some(c => c !== '')) // drop blank/all-empty rows (trailing newline, stray commas)
    .map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; });
      return o;
    });
}

export function parseSubscriptions(text) {
  return rowsToObjects(text).map(o => ({
    channel_id: o['Channel ID'] || null, channel_url: o['Channel URL'] || null, title: o['Channel title'] || null,
  }));
}

export function parseChannel(text) {
  const o = rowsToObjects(text)[0];
  if (!o) return null;
  return { channel_id: o['Channel ID'], title: o['Channel title (Original)'], visibility: o['Channel visibility'] };
}

function toInt(s) {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseVideos(text) {
  return rowsToObjects(text).map(o => ({
    video_id: o['Video ID'] || null,
    duration_ms: toInt(o['Approx duration (ms)']),
    language: o['Video audio language'] || null,
    category: o['Video category'] || null,
    description: o['Video description (original)'] || null,
    channel_id: o['Channel ID'] || null,
    title: o['Video title (original)'] || null,
    privacy: o['Privacy'] || null,
    state: o['Video state'] || null,
    created_ts: parseYtDate(o['Video create timestamp']),
    published_ts: parseYtDate(o['Video publish timestamp']),
  }));
}

export function parseMusicLibrary(text) {
  return rowsToObjects(text).map(o => {
    const artists = [];
    for (let n = 1; n <= 9; n++) {
      const a = o[`Artist Name ${n}`];
      if (a && a.trim()) artists.push(a.trim());
    }
    return { video_id: o['Video ID'] || null, title: o['Song Title'] || null, album: o['Album Title'] || null, artists };
  });
}

export function parsePlaylists(text) {
  return rowsToObjects(text).map(o => ({
    playlist_id: o['Playlist ID'],
    title: o['Playlist title (original)'] || null,
    description: o['Playlist description (original)'] || null,
    visibility: o['Playlist visibility'] || null,
    created_ts: parseYtDate(o['Playlist create timestamp']),
    updated_ts: parseYtDate(o['Playlist update timestamp']),
  }));
}

export function parsePlaylistItems(text) {
  return rowsToObjects(text).map(o => ({
    video_id: o['Video ID'] || null, added_ts: parseYtDate(o['Playlist video creation timestamp']),
  }));
}

export function parseComments(text) {
  return rowsToObjects(text).map(o => ({
    comment_id: o['Comment ID'] || null,
    channel_id: o['Channel ID'] || null,
    video_id: o['Video ID'] || null,
    text: o['Comment text'] || null,
    parent_comment_id: o['Parent comment ID'] || null,
    ts: parseYtDate(o['Comment create timestamp']),
  }));
}

// Decode the handful of HTML entities that appear in Takeout activity text.
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#8239;/g, ' ').replace(/&nbsp;/g, ' ').replace(/&emsp;/g, ' ');
}

// Takeout history date, e.g. "13 Jan 2019, 19:37:22 GMT-05:00" (also tolerates a
// trailing TZ abbreviation form). Pulled by regex from the cell text — NOT by
// position relative to <br> (the real cells end with a trailing <br>).
const HIST_DATE_RE = /(\d{1,2} [A-Za-z]{3,9} \d{4}, \d{1,2}:\d{2}:\d{2}\s*(?:GMT[+-]\d{2}:?\d{2}|UTC|[A-Z]{2,5}))/;

function dateFromCell(cell) {
  const m = cell.match(HIST_DATE_RE);
  return m ? parseYtDate(m[1]) : null;
}

// Split the activity HTML into per-activity chunks by the outer-cell opening
// marker. Each chunk = one user activity (followed by its own caption/text-right
// noise, which is harmless: the parsers only pull the FIRST watch?v=/search_query=
// and date, all of which live in the leading body-1 cell, before the caption).
// Splitting (vs. a balanced-</div> regex) avoids any nesting-depth assumption.
function outerCells(html) {
  return String(html).split(/<div class="outer-cell/).slice(1);
}

export function parseWatchHistory(html) {
  const out = [];
  for (const cell of outerCells(html)) {
    const vid = cell.match(/watch\?v=([\w-]+)/);
    if (!vid) continue; // not a watch entry (or removed with no id) — skip
    const titleM = cell.match(/watch\?v=[\w-]+">([\s\S]*?)<\/a>/);
    let title = titleM ? decodeEntities(titleM[1].replace(/<[^>]+>/g, '')).trim() : null;
    if (title && /^https?:\/\//i.test(title)) title = null; // URL-as-title = removed/old video → no real title
    const chM = cell.match(/\/channel\/([\w-]+)">([\s\S]*?)<\/a>/);
    out.push({
      video_id: vid[1],
      title,
      channel_id: chM ? chM[1] : null,
      channel_name: chM ? decodeEntities(chM[2].replace(/<[^>]+>/g, '')).trim() : null,
      ts: dateFromCell(cell),
    });
  }
  return out;
}

export function parseSearchHistory(html) {
  const out = [];
  for (const cell of outerCells(html)) {
    const qM = cell.match(/search_query=[^"]*">([\s\S]*?)<\/a>/);
    if (!qM) continue;
    out.push({
      query: decodeEntities(qM[1].replace(/<[^>]+>/g, '')).trim(),
      ts: dateFromCell(cell),
    });
  }
  return out;
}
