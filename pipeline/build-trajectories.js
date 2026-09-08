#!/usr/bin/env node
/**
 * Per-friend trajectory pre-compute.
 *
 * For top 30 contacts (by 1-on-1 message volume, mirroring gaps.js),
 * write pipeline/output/self/trajectories/<canonical_id>.json with:
 *   - monthly volume (total / from_me / from_them)
 *   - register-shift proxies (hedge density, asking-grammar density per 1k)
 *   - key moments (first / longest gap / peak month / biggest single-day burst)
 *   - current state (days since last, recent_30d vs baseline_30d, last initiator)
 *
 * Usage:
 *   node pipeline/build-trajectories.js
 */

import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'pipeline', 'output', 'raw', 'messages.duckdb');
const OUT_DIR = path.join(ROOT, 'pipeline', 'output', 'self', 'trajectories');

const GEORGE_NAME = 'Demo User';
let GEORGE_ID = 'id-751';  // resolved from GEORGE_NAME at runtime — survives canonical_id renumbers
const TOP_N = 30;
const MS_DAY = 24 * 60 * 60 * 1000;
const RECENT_WINDOW_MS = 30 * MS_DAY;
const SYSTEM_NAME_PATTERNS = /facebook user|instagram user|^unknown$|^null$|^undefined$/i;

// Mirrors pipeline/self/extract.js IMSG_FOOTER_RES so register density isn't
// polluted by quote-block continuations.
const IMSG_FOOTER_RES = [
  /\n+\s*This message responded to an earlier message\.?\s*$/i,
  /\n+\s*Tapbacks?:[\s\S]*$/i,
  /\n+\s*[A-Z][a-z]{2} \d{1,2}, \d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M[\s\S]*$/,
];

function stripFooters(body) {
  let out = body || '';
  for (const re of IMSG_FOOTER_RES) out = out.replace(re, '');
  return out.trim();
}

// Hedge & asking patterns — case-insensitive substring tests.
const HEDGE_NEEDLES = [
  "i feel like",
  "i don't know",
  "i don't think",
  "i'm not sure",
  "maybe i",
];
const ASKING_NEEDLES = [
  "do u ",
  "r u ",
  "are u ",
  "where r u",
  "what r u",
  "do you ",
  "where are you",
];

function containsAny(lc, needles) {
  for (const n of needles) if (lc.includes(n)) return true;
  return false;
}

function ymOf(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
function ymdOf(ts) {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function loadTopThirty(conn) {
  // Mirror gaps.js ranking: 1-on-1 threads, exclude Demo + system aggregator names.
  // Top by total meaningful message volume.
  const reader = await conn.runAndReadAll(`
    SELECT
      ti.canonical_id,
      i.display_name,
      COUNT(*) AS msg_count
    FROM messages m
    JOIN threads t ON t.thread_id = m.thread_id
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN identities i ON i.canonical_id = ti.canonical_id
    WHERE t.is_group = FALSE
      AND m.meaningful = TRUE
      AND ti.canonical_id <> '${GEORGE_ID}'
      AND COALESCE(i.display_name, '') NOT IN ('', 'Facebook user', 'Instagram User')
    GROUP BY ti.canonical_id, i.display_name
    ORDER BY msg_count DESC
  `);
  const rows = reader.getRowObjectsJson();
  const top = [];
  for (const r of rows) {
    if (SYSTEM_NAME_PATTERNS.test(r.display_name || '')) continue;
    top.push({
      canonical_id: r.canonical_id,
      display_name: r.display_name,
      msg_count: Number(r.msg_count),
    });
    if (top.length >= TOP_N) break;
  }
  return top;
}

async function loadMessagesForPerson(conn, canonical_id) {
  // All meaningful 1-on-1 messages between Demo and this person.
  const reader = await conn.runAndReadAll(`
    SELECT m.ts, m.from_me, m.body, m.source
    FROM messages m
    JOIN threads t ON t.thread_id = m.thread_id
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    WHERE t.is_group = FALSE
      AND m.meaningful = TRUE
      AND ti.canonical_id = '${canonical_id.replace(/'/g, "''")}'
    ORDER BY m.ts ASC
  `);
  return reader.getRowObjectsJson().map(r => ({
    ts: Number(r.ts),
    from_me: !!r.from_me,
    body: stripFooters(r.body || ''),
    source: r.source || '',
  }));
}

function buildMonthly(msgs) {
  // Bucket by YYYY-MM. Tracks total / from_me / from_them, hedge & asking
  // counts (over all messages in the month, regardless of who sent them),
  // plus message-length samples for median.
  const by = new Map();
  for (const m of msgs) {
    const key = ymOf(m.ts);
    if (!by.has(key)) by.set(key, {
      month: key, total: 0, from_me: 0, from_them: 0,
      hedge: 0, asking: 0, lens: [],
    });
    const b = by.get(key);
    b.total++;
    if (m.from_me) b.from_me++; else b.from_them++;
    const lc = m.body.toLowerCase();
    if (containsAny(lc, HEDGE_NEEDLES)) b.hedge++;
    if (containsAny(lc, ASKING_NEEDLES)) b.asking++;
    b.lens.push(m.body.length);
  }
  // Order chronologically and decorate.
  const out = [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const b of out) {
    b.hedge_per_1k = b.total > 0 ? +(1000 * b.hedge / b.total).toFixed(2) : 0;
    b.asking_per_1k = b.total > 0 ? +(1000 * b.asking / b.total).toFixed(2) : 0;
    b.median_msg_len = Math.round(median(b.lens));
    delete b.hedge; delete b.asking; delete b.lens;
  }
  return out;
}

function buildKeyMoments(msgs, monthly) {
  if (!msgs.length) return [];
  const moments = [];

  // First message
  const first = msgs[0];
  moments.push({
    kind: 'first_message',
    iso: ymdOf(first.ts),
    excerpt: (first.body || '').slice(0, 160),
  });

  // Longest gap between consecutive meaningful messages.
  let bestGapMs = 0, bestGapStart = null, bestGapEnd = null;
  for (let i = 1; i < msgs.length; i++) {
    const gap = msgs[i].ts - msgs[i - 1].ts;
    if (gap > bestGapMs) {
      bestGapMs = gap;
      bestGapStart = msgs[i - 1].ts;
      bestGapEnd = msgs[i].ts;
    }
  }
  if (bestGapStart != null) {
    moments.push({
      kind: 'longest_gap',
      iso_start: ymdOf(bestGapStart),
      iso_end: ymdOf(bestGapEnd),
      days: Math.round(bestGapMs / MS_DAY),
    });
  }

  // Peak month
  let peakMonth = null, peakTotal = 0;
  for (const m of monthly) {
    if (m.total > peakTotal) { peakTotal = m.total; peakMonth = m.month; }
  }
  if (peakMonth) moments.push({ kind: 'peak_month', month: peakMonth, total: peakTotal });

  // Biggest single-day burst
  const byDay = new Map();
  for (const m of msgs) {
    const k = ymdOf(m.ts);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  let bigDay = null, bigCount = 0;
  for (const [k, v] of byDay) if (v > bigCount) { bigCount = v; bigDay = k; }
  if (bigDay) moments.push({ kind: 'biggest_day', iso: bigDay, total: bigCount });

  // Last message
  const last = msgs[msgs.length - 1];
  moments.push({
    kind: 'last_message',
    iso: ymdOf(last.ts),
    excerpt: (last.body || '').slice(0, 160),
  });

  return moments;
}

function computeBaseline30d(msgs, nowMs) {
  // Rolling 30-day window stepping by 7 days through history; baseline = median
  // count over windows that ended at least 30 days before now. Mirrors gaps.js.
  if (msgs.length < 2) return 0;
  const start = msgs[0].ts;
  const baselineCutoff = nowMs - RECENT_WINDOW_MS;
  if (start >= baselineCutoff) return 0;
  const stepMs = 7 * MS_DAY;
  const ts = msgs.map(m => m.ts);
  const counts = [];
  function lb(val) {
    let lo = 0, hi = ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < val) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  for (let winEnd = start + RECENT_WINDOW_MS; winEnd <= baselineCutoff; winEnd += stepMs) {
    const winStart = winEnd - RECENT_WINDOW_MS;
    counts.push(lb(winEnd) - lb(winStart));
  }
  if (!counts.length) return 0;
  return median(counts);
}

function buildCurrent(msgs, nowMs) {
  if (!msgs.length) return null;
  const lastTs = msgs[msgs.length - 1].ts;
  const days_since_last = Math.round((nowMs - lastTs) / MS_DAY);
  const recentCutoff = nowMs - RECENT_WINDOW_MS;
  let recent_30d = 0;
  for (const m of msgs) if (m.ts >= recentCutoff) recent_30d++;
  const baseline_30d = Math.round(computeBaseline30d(msgs, nowMs));
  const last_initiator = msgs[msgs.length - 1].from_me ? 'me' : 'them';
  return { days_since_last, last_initiator, recent_30d, baseline_30d };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const inst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();

  const gRow = (await conn.runAndReadAll(
    `SELECT canonical_id FROM identities WHERE display_name = '${GEORGE_NAME}' ORDER BY canonical_id LIMIT 1`
  )).getRows()[0];
  if (gRow) GEORGE_ID = gRow[0];
  else { console.warn(`[trajectories] WARNING: no identity named "${GEORGE_NAME}" — Demo not excluded from ranking`); GEORGE_ID = '__no_self__'; }

  const top = await loadTopThirty(conn);
  console.log(`[trajectories] top ${top.length} contacts`);

  const nowMs = Date.now();
  const written = [];
  const sources = new Set();

  for (const person of top) {
    const msgs = await loadMessagesForPerson(conn, person.canonical_id);
    if (!msgs.length) continue;
    for (const m of msgs) if (m.source) sources.add(m.source);
    const monthly = buildMonthly(msgs);
    const key_moments = buildKeyMoments(msgs, monthly);
    const current = buildCurrent(msgs, nowMs);

    let from_me_total = 0, from_them_total = 0;
    const personSources = new Set();
    for (const m of msgs) {
      if (m.from_me) from_me_total++; else from_them_total++;
      if (m.source) personSources.add(m.source);
    }

    const out = {
      canonical_id: person.canonical_id,
      display_name: person.display_name,
      generated_at: new Date(nowMs).toISOString(),
      first_iso: ymdOf(msgs[0].ts),
      last_iso: ymdOf(msgs[msgs.length - 1].ts),
      total_messages: msgs.length,
      from_me_total,
      from_them_total,
      sources: [...personSources].sort(),
      monthly,
      key_moments,
      current,
    };
    const fp = path.join(OUT_DIR, person.canonical_id + '.json');
    fs.writeFileSync(fp, JSON.stringify(out, null, 2));
    written.push({
      canonical_id: person.canonical_id,
      display_name: person.display_name,
      total_messages: msgs.length,
      first_iso: out.first_iso,
      last_iso: out.last_iso,
      file: path.relative(ROOT, fp),
    });
  }

  // Index file so /trajectory/<Name> can resolve canonical_id without a DB hit.
  const indexPath = path.join(OUT_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify({
    generated_at: new Date(nowMs).toISOString(),
    count: written.length,
    people: written,
  }, null, 2));

  conn.disconnectSync();
  console.log(`[trajectories] wrote ${written.length} trajectories + index.json to ${path.relative(ROOT, OUT_DIR)}`);
}

main().catch(err => { console.error('[trajectories] fatal:', err); process.exit(1); });
