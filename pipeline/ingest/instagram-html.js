import fs from 'fs';
import path from 'path';

/**
 * Parse Instagram's *HTML*-format message export (a stopgap for when the JSON
 * export isn't available). Same on-disk layout as the JSON export, but each
 * thread holds `message_<n>.html` instead of `message_<n>.json`:
 *
 *   <root>/your_instagram_activity/messages/inbox/<thread>/message_1.html
 *
 * Returns raw (un-normalized) messages so the caller can merge them with the
 * JSON export per-thread and run a single normalization pass. See instagram.js.
 */

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8,
  oct: 9, nov: 10, dec: 11,
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'", '#39': "'" };
function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

// HTML export is already valid UTF-8 (raw multibyte + entities for some ASCII),
// so — unlike the JSON export — it must NOT be run through fixMojibake.
const clean = s => decodeEntities(s).replace(/\s+/g, ' ').trim();

// Parse a human timestamp like "May 31, 2026 7:57 am" (or "...at 8:36 PM") as a
// naive wall-clock instant, returned as if it were UTC. Caller shifts by offset.
export function parseHumanNaive(text) {
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (mo == null) return null;
  const day = +m[2], year = +m[3];
  let hour = +m[4]; const min = +m[5];
  const ap = (m[6] || '').toLowerCase();
  if (ap === 'pm' && hour !== 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  return Date.UTC(year, mo, day, hour, min, 0);
}

// Offset (ms) = naiveLocal(asUTC) - actualUTC, derived from the header's
// "Contains data you requested from <time datetime=...Z>HUMAN</time>" pair.
// For UTC-7 this is -7h. true_utc = naiveLocal(asUTC) - offset.
export function deriveOffsetMs(html) {
  const m = html.match(/Contains data you requested from\s*<time datetime="([^"]+)">([^<]+)<\/time>/i);
  if (!m) return null;
  const actualUtc = Date.parse(m[1]);
  const naive = parseHumanNaive(m[2]);
  if (!Number.isFinite(actualUtc) || naive == null) return null;
  return naive - actualUtc;
}

function detectAttachment(bodyHtml) {
  if (/<video|\.mp4|sent a video/i.test(bodyHtml)) return 'video';
  if (/<img|\.jpe?g|\.png|\.webp|\.heic|\.gif|sent an attachment|sent a photo|photos\//i.test(bodyHtml)) return 'image';
  return null;
}

// Split a thread HTML into per-message inner fragments.
const MSG_SPLIT = '<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">';

export function parseInstagramHtmlThread(threadDir) {
  let files;
  try {
    files = fs.readdirSync(threadDir).filter(f => /^message_\d+\.html$/.test(f)).sort();
  } catch { return null; }
  if (files.length === 0) return null;

  let offsetMs = null;
  let title = null;
  const senders = new Set();
  const messages = [];

  for (const file of files) {
    const html = fs.readFileSync(path.join(threadDir, file), 'utf-8');
    if (offsetMs == null) offsetMs = deriveOffsetMs(html);
    if (!title) {
      const t = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
      if (t) title = clean(t[1]);
    }
    const off = offsetMs || 0;
    const parts = html.split(MSG_SPLIT).slice(1);
    for (const part of parts) {
      const sm = part.match(/<h2[^>]*>([^<]*)<\/h2>/);
      const tm = part.match(/<div class="_3-94 _a6-o">([^<]+)<\/div>/);
      if (!tm) continue;
      const naive = parseHumanNaive(tm[1]);
      if (naive == null) continue;
      const bm = part.match(/<div class="_3-95 _a6-p">([\s\S]*?)<div class="_3-94 _a6-o">/);
      const bodyHtml = bm ? bm[1] : '';
      const bodyText = clean(bodyHtml.replace(/<[^>]+>/g, ' '));
      const senderName = sm ? clean(sm[1]) : '';
      if (senderName) senders.add(senderName);
      messages.push({
        ts: naive - off,
        senderName,
        body: bodyText,
        attachmentType: detectAttachment(bodyHtml),
      });
    }
  }

  const others = [...senders].filter(s => s && s !== 'Demo User');
  const named = others.length ? others : (title ? [title] : []);
  const participants = ['Demo User', ...named];

  return { folder: path.basename(threadDir), participants, messages, offsetMs: offsetMs || 0 };
}
