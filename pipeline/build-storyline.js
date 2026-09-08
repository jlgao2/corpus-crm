#!/usr/bin/env node
/**
 * Build the social storyline dataset.
 *
 *   npm run build-storyline
 *
 * For each (year-month, person) bucket, compute:
 *   - msgs: messages exchanged in that DM thread that month
 *   - mentions: how often this person came up in OTHER threads that month
 *   - co_active_with: list of [other_canonical_id, weight] (co-mention or co-active)
 *
 * Output: pipeline/output/storyline.json
 *   {
 *     generated, months: ['2014-01', ...],
 *     people: [{canonical_id, display_name, has_portrait, sources, total_msgs}, ...],
 *     activity: { '<canonical_id>': { '<ym>': {msgs, mentions} } },
 *     co_active: { '<ym>': [[a, b, weight], ...] }
 *   }
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const PORTRAITS_DIR = path.join(__dirname, 'output', 'portraits');
const OUT = path.join(__dirname, 'output', 'storyline.json');
const TOP_N = 30;

function safeFilename(s) { return s.replace(/[^\w\-]+/g, '_'); }
function hasPortrait(displayName) {
  const a = safeFilename(displayName);
  for (const c of new Set([a, a.replace(/^_+/, ''), a.replace(/_+$/, ''), a.replace(/^_+|_+$/g, '')])) {
    if (c && fs.existsSync(path.join(PORTRAITS_DIR, c + '.md'))) return true;
  }
  return false;
}

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // Top N people by 1-on-1 message count
  const topRows = (await conn.runAndReadAll(`
    SELECT i.canonical_id, i.display_name, i.sources::VARCHAR AS s, COUNT(m.id) AS n,
           MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN threads t ON t.thread_id = m.thread_id
    JOIN identities i ON i.canonical_id = ti.canonical_id
    WHERE NOT t.is_group AND m.body IS NOT NULL AND m.body <> ''
    GROUP BY i.canonical_id, i.display_name, i.sources
    HAVING n > 50
    ORDER BY n DESC LIMIT ${TOP_N}
  `)).getRows();

  const people = topRows.map(([cid, name, src, n, first, last]) => ({
    canonical_id: cid,
    display_name: name,
    sources: src.replace(/[\[\]'"]/g, '').split(',').map(s => s.trim()).filter(Boolean),
    total_msgs: Number(n),
    has_portrait: hasPortrait(name),
    first_ts: Number(first),
    last_ts: Number(last),
  }));
  const cidSet = new Set(people.map(p => p.canonical_id));
  const idToName = new Map(people.map(p => [p.canonical_id, p.display_name]));

  // Per-month per-person 1-on-1 message count (= "ribbon thickness")
  const rangeStart = Math.min(...people.map(p => p.first_ts));
  const rangeEnd = Math.max(...people.map(p => p.last_ts));
  const startDate = new Date(rangeStart);
  const endDate = new Date(rangeEnd);
  const months = [];
  {
    const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
    const last = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
    while (d <= last) {
      months.push(d.toISOString().slice(0, 7));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }

  console.log(`Top ${people.length} people; ${months.length} months from ${months[0]} to ${months[months.length-1]}`);

  // Activity: msgs per (cid, ym) in their 1-on-1 thread
  const activity = {};
  for (const p of people) activity[p.canonical_id] = {};
  const activityRows = (await conn.runAndReadAll(`
    SELECT ti.canonical_id,
           strftime(make_timestamp(m.ts*1000), '%Y-%m') AS ym,
           COUNT(*) AS n
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN threads t ON t.thread_id = m.thread_id
    WHERE NOT t.is_group
      AND ti.canonical_id IN (${[...cidSet].map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
      AND m.body IS NOT NULL AND m.body <> ''
    GROUP BY ti.canonical_id, ym
  `)).getRows();
  for (const [cid, ym, n] of activityRows) {
    if (!activity[cid]) continue;
    activity[cid][ym] = activity[cid][ym] || { msgs: 0, mentions: 0 };
    activity[cid][ym].msgs = Number(n);
  }

  // Mentions: when this person was mentioned in OTHER threads, per month
  // (mentions table: mentioned_canonical_id, thread_id, ts)
  const mentionRows = (await conn.runAndReadAll(`
    SELECT mn.mentioned_canonical_id,
           strftime(make_timestamp(mn.ts*1000), '%Y-%m') AS ym,
           COUNT(*) AS n
    FROM mentions mn
    WHERE mn.mentioned_canonical_id IN (${[...cidSet].map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
    GROUP BY mn.mentioned_canonical_id, ym
  `)).getRows();
  for (const [cid, ym, n] of mentionRows) {
    if (!activity[cid]) continue;
    activity[cid][ym] = activity[cid][ym] || { msgs: 0, mentions: 0 };
    activity[cid][ym].mentions = Number(n);
  }

  // Co-mentions: how often person A is mentioned in person B's DM thread, per month.
  // Edge weight per month: count of times person A is mentioned in person B's 1-on-1 thread (and A != B).
  // We'll aggregate symmetrically: A↔B = mentions of A in B's thread + mentions of B in A's thread.
  const coRows = (await conn.runAndReadAll(`
    SELECT mn.mentioned_canonical_id AS a,
           ti.canonical_id AS b,
           strftime(make_timestamp(mn.ts*1000), '%Y-%m') AS ym,
           COUNT(*) AS n
    FROM mentions mn
    JOIN threads t ON t.thread_id = mn.thread_id
    JOIN thread_identity ti ON ti.thread_id = mn.thread_id
    WHERE NOT t.is_group
      AND mn.mentioned_canonical_id IN (${[...cidSet].map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
      AND ti.canonical_id IN (${[...cidSet].map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
      AND mn.mentioned_canonical_id <> ti.canonical_id
    GROUP BY a, b, ym
  `)).getRows();

  // Build co_active: per-month, list of [a, b, weight] with a < b (sorted by canonical_id)
  const coByMonth = new Map();
  for (const [a, b, ym, n] of coRows) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!coByMonth.has(ym)) coByMonth.set(ym, new Map());
    const m = coByMonth.get(ym);
    m.set(key, (m.get(key) || 0) + Number(n));
  }
  const co_active = {};
  for (const [ym, edges] of coByMonth) {
    const arr = [];
    for (const [k, w] of edges) {
      const [a, b] = k.split('|');
      arr.push([a, b, w]);
    }
    arr.sort((x, y) => y[2] - x[2]);
    co_active[ym] = arr;
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    months,
    people,
    activity,
    co_active,
  }));

  // Quick sanity stats
  const peopleWithActivity = people.filter(p => Object.values(activity[p.canonical_id]).some(v => v.msgs > 0)).length;
  const totalCoEdges = Object.values(co_active).reduce((s, arr) => s + arr.length, 0);
  console.log(`storyline.json: ${people.length} people, ${months.length} months, ${totalCoEdges} co-mention edges across all months`);
  console.log(`  people with activity: ${peopleWithActivity}/${people.length}`);
  console.log(`  with portraits: ${people.filter(p => p.has_portrait).length}`);

  await conn.disconnectSync();
}

main().catch(e => { console.error(e); process.exit(1); });
