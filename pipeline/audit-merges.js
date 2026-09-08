#!/usr/bin/env node
/**
 * Merge audit — propose cross-source identity merges via shared third-party mention overlap.
 *
 * For every unmerged single-source identity in the top K by message volume, compute the set of
 * other canonical_ids they mention in their thread. Pair candidates across sources where
 * (a) Jaccard overlap of the mentioned-set is high, and (b) activity time-windows overlap.
 *
 *   node pipeline/audit-merges.js                    # show top candidates
 *   node pipeline/audit-merges.js --json out.json    # write JSON
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const TOP_K = 60;
const MIN_MENTIONS = 5;        // need at least this many mentioned third parties for a meaningful signature
const MIN_JACCARD = 0.10;      // surface candidates above this overlap

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // 1. Top-K identities per source-class (instagram-only vs imessage-only)
  const topRows = (await conn.runAndReadAll(`
    SELECT i.canonical_id, i.display_name, i.sources::VARCHAR AS s, COUNT(m.id) AS n
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN threads t ON t.thread_id = m.thread_id
    JOIN identities i ON i.canonical_id = ti.canonical_id
    WHERE NOT t.is_group AND m.body IS NOT NULL AND m.body <> ''
    GROUP BY i.canonical_id, i.display_name, i.sources
    HAVING n > 100
    ORDER BY n DESC LIMIT ${TOP_K}
  `)).getRows();

  const single = { instagram: [], imessage: [] };
  for (const [cid, name, srcRaw, n] of topRows) {
    const sources = srcRaw.replace(/[\[\]'"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
    if (sources.length === 1 && (sources[0] === 'instagram' || sources[0] === 'imessage')) {
      single[sources[0]].push({ canonical_id: cid, display_name: name, sources, msgs: Number(n) });
    }
  }
  console.log(`single-source candidates: instagram=${single.instagram.length}, imessage=${single.imessage.length}`);

  // 2. Build mention signature per identity: set of OTHER canonical_ids they mention in their DM thread
  const allCids = [...single.instagram, ...single.imessage].map(p => p.canonical_id);
  if (allCids.length === 0) { console.log('nothing to audit'); await conn.disconnectSync(); return; }

  const sigRows = (await conn.runAndReadAll(`
    SELECT ti.canonical_id AS owner_cid,
           mn.mentioned_canonical_id AS mentioned_cid,
           COUNT(*) AS n,
           MIN(mn.ts) AS first_ts, MAX(mn.ts) AS last_ts
    FROM mentions mn
    JOIN thread_identity ti ON ti.thread_id = mn.thread_id
    JOIN threads t ON t.thread_id = mn.thread_id
    WHERE NOT t.is_group
      AND ti.canonical_id IN (${allCids.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
      AND mn.mentioned_canonical_id <> ti.canonical_id
    GROUP BY ti.canonical_id, mn.mentioned_canonical_id
  `)).getRows();

  // sig: cid → Map<mentioned_cid, count>
  const sig = new Map();
  for (const [owner, mentioned, n] of sigRows) {
    if (!sig.has(owner)) sig.set(owner, new Map());
    sig.get(owner).set(mentioned, Number(n));
  }

  // Activity windows
  const winRows = (await conn.runAndReadAll(`
    SELECT ti.canonical_id, MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN threads t ON t.thread_id = m.thread_id
    WHERE NOT t.is_group AND m.body IS NOT NULL
      AND ti.canonical_id IN (${allCids.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
    GROUP BY ti.canonical_id
  `)).getRows();
  const win = new Map();
  for (const [cid, first, last] of winRows) win.set(cid, { first: Number(first), last: Number(last) });

  // IDF: down-weight third parties that everyone mentions (friend-group cohort noise).
  // Drop entirely the ones mentioned by >= 50% of people.
  const N = sig.size;
  const df = new Map();
  for (const om of sig.values()) for (const k of om.keys()) df.set(k, (df.get(k) || 0) + 1);
  const idf = new Map();
  for (const [k, d] of df) idf.set(k, Math.log((N + 1) / d));
  const dfCutoff = Math.max(3, Math.ceil(N * 0.5));
  const dropCommon = new Set();
  for (const [k, d] of df) if (d >= dfCutoff) dropCommon.add(k);
  console.log(`mention IDF: N=${N}, dropping ${dropCommon.size} cohort-level common mentions (df >= ${dfCutoff})`);

  // Helper: IDF-weighted Jaccard over shared third-parties (excluding cohort-noise).
  function score(a, b) {
    const sa = sig.get(a) || new Map();
    const sb = sig.get(b) || new Map();
    if (sa.size < MIN_MENTIONS || sb.size < MIN_MENTIONS) return null;
    const keys = new Set([...sa.keys(), ...sb.keys()]);
    let inter = 0, union = 0;
    let sharedTop = [];
    for (const k of keys) {
      if (dropCommon.has(k)) continue;
      const w = idf.get(k) || 0;
      const va = (sa.get(k) || 0) * w;
      const vb = (sb.get(k) || 0) * w;
      inter += Math.min(va, vb);
      union += Math.max(va, vb);
      if (sa.get(k) > 0 && sb.get(k) > 0) {
        sharedTop.push([k, Math.min(sa.get(k), sb.get(k)) * w]);
      }
    }
    const jaccard = union ? inter / union : 0;
    const sharedCount = sharedTop.length;
    sharedTop.sort((x, y) => y[1] - x[1]);
    return { jaccard, sharedCount, sharedTop: sharedTop.slice(0, 6), sa: sa.size, sb: sb.size };
  }

  // Time-window overlap (in days)
  function overlap(a, b) {
    const wa = win.get(a), wb = win.get(b);
    if (!wa || !wb) return 0;
    const start = Math.max(wa.first, wb.first);
    const end = Math.min(wa.last, wb.last);
    return Math.max(0, (end - start) / 86400000);
  }

  // 3. Pair across sources
  const pairs = [];
  for (const ig of single.instagram) {
    for (const im of single.imessage) {
      const s = score(ig.canonical_id, im.canonical_id);
      if (!s || s.jaccard < MIN_JACCARD) continue;
      const ov = overlap(ig.canonical_id, im.canonical_id);
      pairs.push({
        ig_cid: ig.canonical_id,
        ig_name: ig.display_name,
        ig_msgs: ig.msgs,
        im_cid: im.canonical_id,
        im_name: im.display_name,
        im_msgs: im.msgs,
        jaccard: s.jaccard,
        shared_count: s.sharedCount,
        ig_sig_size: s.sa,
        im_sig_size: s.sb,
        overlap_days: Math.round(ov),
        shared_top: s.sharedTop,
      });
    }
  }
  pairs.sort((a, b) => b.jaccard - a.jaccard || b.shared_count - a.shared_count);

  // Resolve mentioned-cid display names for the shared_top
  const allMentionedCids = new Set();
  for (const p of pairs) for (const [k] of p.shared_top) allMentionedCids.add(k);
  const nameRows = (await conn.runAndReadAll(`
    SELECT canonical_id, display_name FROM identities
    WHERE canonical_id IN (${[...allMentionedCids].map(c => `'${c.replace(/'/g, "''")}'`).join(',')})
  `)).getRows();
  const nameMap = new Map(nameRows.map(r => [r[0], r[1]]));
  for (const p of pairs) {
    p.shared_top = p.shared_top.map(([k, v]) => ({ canonical_id: k, name: nameMap.get(k) || k, count: v }));
  }

  // 4. Print
  console.log(`\n${pairs.length} cross-source candidates with Jaccard >= ${MIN_JACCARD}:\n`);
  for (const p of pairs.slice(0, 30)) {
    console.log(`  J=${p.jaccard.toFixed(3)} shared=${p.shared_count}/${p.ig_sig_size}+${p.im_sig_size} | ` +
                `IG ${p.ig_name} (${p.ig_msgs} msgs) ↔ IMSG ${p.im_name} (${p.im_msgs} msgs) | ` +
                `overlap ${p.overlap_days}d`);
    console.log(`     shared3p: ${p.shared_top.map(s => s.name + '×' + s.count).join(', ')}`);
  }

  const outPath = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ generated: new Date().toISOString(), pairs }, null, 2));
    console.log(`\nwrote ${outPath}`);
  }
  await conn.disconnectSync();
}

main().catch(e => { console.error(e); process.exit(1); });
