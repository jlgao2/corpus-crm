#!/usr/bin/env node
/**
 * Build the relational timeline + check-in list.
 *
 *   npm run build-relations
 *
 * Outputs:
 *   pipeline/output/timeline.json   — single chronological array of dated entries
 *   pipeline/output/checkins.json   — per-person check-in dataset (top N by message volume)
 *
 * Sources:
 *   - messages.duckdb (per-person first/last contact, msg counts, last-from)
 *   - birthdays table
 *   - pipeline/output/portraits/*.md (anchor moments, recent state)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const PORTRAITS_DIR = path.join(__dirname, 'output', 'portraits');
const OUT_DIR = path.join(__dirname, 'output');

const TOP_N = 30;
const TODAY = new Date();

function safeFilename(s) { return s.replace(/[^\w\-]+/g, '_'); }

function readPortraitForName(displayName) {
  // Try: literal safeFilename, then strip leading/trailing underscores (drops emoji prefixes/suffixes).
  const a = safeFilename(displayName);
  const candidates = new Set([
    a,
    a.replace(/^_+/, ''),
    a.replace(/_+$/, ''),
    a.replace(/^_+|_+$/g, ''),
  ]);
  for (const c of candidates) {
    if (!c) continue;
    const p = path.join(PORTRAITS_DIR, c + '.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  }
  return null;
}

// Extract anchor moments from a portrait. Two formats supported:
//   **YYYY-MM-DD** — context...                         (Maya, Robin)
//   **YYYY-MM-DD — context.**                           (Robin variant)
//   ### Title (Mon DD YYYY)                             (Nina variant)
//   ### Title (Mon DD YYYY → Mon DD YYYY)               (Nina multi-day)
//
// Returns: [{ date: 'YYYY-MM-DD', summary }]
function extractAnchorMoments(md) {
  if (!md) return [];
  // Find the ## Anchor moments section. End at the next "## " heading or end-of-string.
  // (Avoid `\Z` here — JS regex doesn't have it, and with /i flag it matches lowercase z.)
  const sectionMatch = md.match(/##\s+Anchor moments?\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const body = sectionMatch ? sectionMatch[1] : md;

  const out = [];

  // Format 1: **YYYY-MM-DD — Title.** [optional trailing prose]
  //   or:    **YYYY-MM-DD** — Title. [optional trailing prose]
  // Title is the bold span between dashes and the closing **; ignore any prose after the close.
  const re1 = /\*\*(\d{4}-\d{2}-\d{2})(?:\*\*)?\s*[—\-–]\s*([^*\n]+?)\.?\*\*/g;
  let m;
  while ((m = re1.exec(body)) !== null) {
    const date = m[1];
    const summary = m[2].trim().replace(/\.$/, '').replace(/^\*+|\*+$/g, '').trim();
    if (summary) out.push({ date, summary });
  }

  // Format 2: ### Title (Mon DD YYYY[ → Mon DD YYYY])
  const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
  const re2 = /###\s+([^\n(]+?)\s+\(([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})/g;
  while ((m = re2.exec(body)) !== null) {
    const title = m[1].trim();
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) continue;
    const day = String(m[3]).padStart(2, '0');
    const year = m[4];
    out.push({ date: `${year}-${mo}-${day}`, summary: title });
  }

  // Dedup on date+summary; keep first occurrence
  const seen = new Set();
  const uniq = [];
  for (const e of out) {
    const k = `${e.date}|${e.summary.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(e);
  }
  uniq.sort((a, b) => a.date.localeCompare(b.date));
  return uniq;
}

function daysBetween(aIso, bIso) {
  const a = new Date(aIso); const b = new Date(bIso);
  return Math.round((b - a) / 86400000);
}

function nextBirthdayDays(month, day) {
  if (!month || !day) return null;
  const t = TODAY;
  let next = new Date(Date.UTC(t.getUTCFullYear(), month - 1, day));
  if (next < t) next = new Date(Date.UTC(t.getUTCFullYear() + 1, month - 1, day));
  return Math.round((next - t) / 86400000);
}

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // Per-canonical_id message stats from 1-on-1 threads (exclude groups so DMs win)
  const stats = (await conn.runAndReadAll(`
    SELECT
      i.canonical_id,
      i.display_name,
      i.sources,
      COUNT(m.id) AS msg_count,
      MIN(m.ts) AS first_ts,
      MAX(m.ts) AS last_ts,
      arg_max(m.from_me, m.ts) AS last_from_me,
      arg_max(m.body, m.ts) AS last_body
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN threads t          ON t.thread_id  = m.thread_id
    JOIN identities i       ON i.canonical_id = ti.canonical_id
    WHERE NOT t.is_group
      AND m.body IS NOT NULL AND m.body <> ''
    GROUP BY i.canonical_id, i.display_name, i.sources
    HAVING msg_count > 50
    ORDER BY msg_count DESC
  `)).getRows();

  const birthdays = (await conn.runAndReadAll(`
    SELECT canonical_id, name, month, day, year, year_known, source FROM birthdays
  `)).getRows();
  const bdMap = new Map();
  for (const [cid, name, month, day, year, yearKnown, source] of birthdays) {
    if (!bdMap.has(cid)) bdMap.set(cid, []);
    bdMap.get(cid).push({ month: Number(month), day: Number(day), year: year ? Number(year) : null, yearKnown: !!yearKnown, source });
  }

  const top = stats.slice(0, TOP_N).map(([cid, name, sources, msgCount, firstTs, lastTs, lastFromMe, lastBody]) => {
    const sourcesArr = Array.isArray(sources) ? sources : (sources?.items || (typeof sources === 'string' ? sources.split(',') : []));
    return {
      canonical_id: cid,
      display_name: name,
      sources: sourcesArr,
      msg_count: Number(msgCount),
      first_ts: Number(firstTs),
      last_ts: Number(lastTs),
      last_from: lastFromMe ? 'me' : 'them',
      last_body_excerpt: (lastBody || '').slice(0, 200).replace(/\s+/g, ' ').trim(),
    };
  });

  // Build timeline entries
  const timeline = [];

  for (const p of top) {
    const firstIso = new Date(p.first_ts).toISOString().slice(0, 10);
    const lastIso = new Date(p.last_ts).toISOString().slice(0, 10);
    timeline.push({
      date: firstIso,
      canonical_id: p.canonical_id,
      person: p.display_name,
      kind: 'first_contact',
      summary: `first message — ${p.display_name}`,
      source: 'messages',
    });
    if (lastIso !== firstIso) {
      timeline.push({
        date: lastIso,
        canonical_id: p.canonical_id,
        person: p.display_name,
        kind: 'last_contact',
        summary: `last message (so far) — ${p.display_name}`,
        source: 'messages',
      });
    }
    // Anchors from portrait (if exists)
    const md = readPortraitForName(p.display_name);
    if (md) {
      const anchors = extractAnchorMoments(md);
      for (const a of anchors) {
        timeline.push({
          date: a.date,
          canonical_id: p.canonical_id,
          person: p.display_name,
          kind: 'anchor',
          summary: a.summary,
          source: 'portrait',
        });
      }
    }
  }

  // Birthdays — emit one entry per person at their birthday MM-DD in TODAY's year
  const yr = TODAY.getUTCFullYear();
  for (const p of top) {
    const bds = bdMap.get(p.canonical_id) || [];
    for (const b of bds) {
      const ageNote = b.year ? ` (turns ${yr - b.year})` : '';
      const date = `${yr}-${String(b.month).padStart(2,'0')}-${String(b.day).padStart(2,'0')}`;
      timeline.push({
        date,
        canonical_id: p.canonical_id,
        person: p.display_name,
        kind: 'birthday',
        summary: `${p.display_name}'s birthday${ageNote}`,
        source: `birthday:${b.source}`,
      });
    }
  }

  timeline.sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));

  // Build check-in dataset
  const todayIso = TODAY.toISOString().slice(0, 10);
  const checkins = top.map(p => {
    const lastIso = new Date(p.last_ts).toISOString().slice(0, 10);
    const daysSince = daysBetween(lastIso, todayIso);
    const bds = bdMap.get(p.canonical_id) || [];
    const firstBd = bds[0];
    const md = readPortraitForName(p.display_name);
    const anchors = extractAnchorMoments(md);
    const lastAnchor = anchors[anchors.length - 1] || null;

    let aboutWhat = null;
    if (md && lastAnchor) {
      aboutWhat = `${lastAnchor.date}: ${lastAnchor.summary}`;
    } else if (md) {
      // Fallback: pull the italic essence line
      const ess = md.match(/^#\s+[^\n]+\n\n\*([^*\n]+)\*/m);
      if (ess) aboutWhat = ess[1].trim();
    }

    return {
      canonical_id: p.canonical_id,
      display_name: p.display_name,
      sources: p.sources,
      msg_count: p.msg_count,
      first_iso: new Date(p.first_ts).toISOString().slice(0, 10),
      last_iso: lastIso,
      days_since_last: daysSince,
      last_msg_from: p.last_from,
      last_msg_excerpt: p.last_body_excerpt,
      birthday: firstBd ? { month: firstBd.month, day: firstBd.day, year: firstBd.year, year_known: firstBd.yearKnown, source: firstBd.source } : null,
      days_until_birthday: firstBd ? nextBirthdayDays(firstBd.month, firstBd.day) : null,
      has_portrait: !!md,
      about_what: aboutWhat,
    };
  });

  // Intimacy score — independent of attention need. Captures how close the relationship has been
  // historically + how active it remains. log(volume) weighted by years_active and recency_decay.
  for (const c of checkins) {
    const yearsActive = Math.max(0.1, (new Date(c.last_iso) - new Date(c.first_iso)) / (365 * 86400000));
    const volume = c.msg_count || 0;
    const daysSince = c.days_since_last || 999;
    const recencyFactor = daysSince <= 60 ? 1.0
                        : daysSince <= 365 ? 0.7
                        : daysSince <= 1095 ? 0.4
                        : 0.15;
    const portraitBoost = c.has_portrait ? 1.15 : 1.0;
    const intimacy = Math.round(Math.log10(Math.max(1, volume)) * 20 * Math.sqrt(yearsActive) * recencyFactor * portraitBoost * 10) / 10;
    c.intimacy_score = intimacy;
    c.years_active = Math.round(yearsActive * 10) / 10;
  }

  // Score: peaks around 30-180 days quiet for active relationships, decays past 2 years.
  // Bonuses for unanswered pings, upcoming birthdays, and having a portrait (= curated context).
  for (const c of checkins) {
    const d = c.days_since_last || 0;
    let recency;
    if (d <= 7) recency = 0;                          // fresh — no nudge needed
    else if (d <= 30) recency = (d - 7) * 1.5;        // warming
    else if (d <= 180) recency = 30 + (d - 30) * 0.7; // sweet spot
    else if (d <= 730) recency = 100 - (d - 180) * 0.05; // cooling
    else recency = 70 - Math.min(d - 730, 1000) * 0.05;  // archive — down-rank
    let score = recency;
    if (c.last_msg_from === 'them') score += 25;      // unanswered ping
    if (c.days_until_birthday != null && c.days_until_birthday <= 14) score += 60;
    else if (c.days_until_birthday != null && c.days_until_birthday <= 30) score += 30;
    c._score = Math.round(score);
  }
  // Two-tier sort: portrait-holders first (curated context = the "real" check-ins),
  // then everyone else by attention score. Within each tier, sort by score desc.
  checkins.sort((a, b) => {
    if (a.has_portrait !== b.has_portrait) return a.has_portrait ? -1 : 1;
    return b._score - a._score;
  });
  for (const c of checkins) { c.attention_score = c._score; delete c._score; }

  fs.writeFileSync(path.join(OUT_DIR, 'timeline.json'), JSON.stringify({
    generated: TODAY.toISOString(),
    count: timeline.length,
    entries: timeline,
  }, null, 2));

  fs.writeFileSync(path.join(OUT_DIR, 'checkins.json'), JSON.stringify({
    generated: TODAY.toISOString(),
    today: todayIso,
    count: checkins.length,
    people: checkins,
  }, null, 2));

  console.log(`timeline.json: ${timeline.length} entries`);
  console.log(`checkins.json: ${checkins.length} people (top ${TOP_N} by message volume)`);
  console.log(`  with portraits: ${checkins.filter(c => c.has_portrait).length}`);
  console.log(`  with birthdays: ${checkins.filter(c => c.birthday).length}`);
  console.log(`  unanswered (last from them): ${checkins.filter(c => c.last_msg_from === 'them').length}`);

  await conn.disconnectSync();
}

main().catch(err => { console.error(err); process.exit(1); });
