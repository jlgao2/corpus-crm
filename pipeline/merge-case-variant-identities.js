#!/usr/bin/env node
/**
 * Merge case/whitespace-variant duplicate identities (same display_name after
 * lower()+trim()) into one canonical_id. Winner = most messages; the surviving
 * display_name is the best-cased variant. Folds thread_identity + photo_faces +
 * birthdays onto the winner, deletes losers. Re-run build-connections →
 * build-graph afterward (they regenerate group_membership/mentions/links/graph).
 *
 *   node pipeline/merge-case-variant-identities.js          # dry run
 *   node pipeline/merge-case-variant-identities.js --apply  # rewrite DB (stop serve.js first)
 *
 * Safe by construction: only merges identities whose NORMALIZED display_name is
 * identical, so it cannot fuse two different people. (Root cause is case-sensitive
 * identity resolution in build-db; this is the post-build cleanup until that's fixed.)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { foldIdentity } from './normalize/fold-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const apply = process.argv.includes('--apply');

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH, apply ? {} : { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();

  const rows = (await conn.runAndReadAll(`
    SELECT i.canonical_id id, i.display_name nm, COALESCE(COUNT(m.id), 0) msgs
    FROM identities i
    LEFT JOIN thread_identity ti ON ti.canonical_id = i.canonical_id
    LEFT JOIN messages m ON m.thread_id = ti.thread_id
    WHERE i.display_name IS NOT NULL
    GROUP BY 1, 2
  `)).getRowObjectsJson().map(r => ({ id: r.id, nm: r.nm, msgs: Number(r.msgs) }));

  const groups = new Map();
  for (const r of rows) {
    const k = (r.nm || '').trim().toLowerCase();
    if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }
  const dupGroups = [...groups.values()].filter(g => g.length > 1);

  const merges = [];
  for (const g of dupGroups) {
    g.sort((a, b) => b.msgs - a.msgs);
    const winner = g[0];
    const best = [...g].sort((a, b) => ((/[A-Z]/.test(b.nm) ? 1 : 0) - (/[A-Z]/.test(a.nm) ? 1 : 0)) || (b.msgs - a.msgs))[0];
    for (const loser of g.slice(1)) {
      merges.push({ winner: winner.id, loser: loser.id, name: best.nm, winnerName: winner.nm, loserName: loser.nm });
    }
  }

  console.log(`${dupGroups.length} normalized-name duplicate groups → ${merges.length} merges`);
  for (const m of merges) console.log(`  "${m.loserName}" (${m.loser}) → "${m.winnerName}" (${m.winner})  keep name: "${m.name}"`);

  if (!apply) { console.log('\nDry run. Re-run with --apply (stop serve.js first).'); await conn.disconnectSync(); return; }

  for (const m of merges) {
    await foldIdentity(conn, m.winner, m.loser, { renameTo: m.name });
  }
  console.log(`\nApplied ${merges.length} merges. Next: npm run build-connections && npm run build-graph.`);
  await conn.disconnectSync();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
