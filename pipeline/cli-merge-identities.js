#!/usr/bin/env node
/**
 * Identity-merge CLI.
 *
 *   node pipeline/cli-merge-identities.js              # dry-run, prints proposals
 *   node pipeline/cli-merge-identities.js --apply      # actually rewrite the DB
 *   node pipeline/cli-merge-identities.js --apply --include-ambiguous
 *
 * Reads the existing DuckDB at pipeline/output/raw/messages.duckdb. Computes
 * cross-source identity-merge candidates. With --apply, rewrites all FK tables
 * (thread_identity, group_membership, mentions, links, photo_faces) so that
 * losing identities are replaced by their winners, then deletes the loser
 * rows from `identities` and renames display_name on the winners where
 * appropriate.
 *
 * Manual overrides at pipeline/identity-aliases.json take precedence.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

import { findMergeCandidates, manualMerges } from './normalize/identity-merge.js';
import { foldIdentity } from './normalize/fold-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const OVERRIDES_PATH = path.join(__dirname, '..', 'pipeline', 'identity-aliases.json');
const OUT_DIR = path.join(__dirname, 'output', 'raw');

function esc(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function main() {
  const apply = process.argv.includes('--apply');
  const includeAmbiguous = process.argv.includes('--include-ambiguous');

  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }

  console.log(`Mode: ${apply ? 'APPLY (will rewrite DB)' : 'DRY RUN'}`);
  console.log(`Including ambiguous: ${includeAmbiguous}`);

  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // 1. Load identities + per-identity message counts
  console.log('\nLoading identities and message counts...');
  const idRows = (await conn.runAndReadAll(
    `SELECT canonical_id, display_name, aliases, sources FROM identities`
  )).getRows();
  const identities = idRows.map(r => ({
    canonical_id: r[0],
    display_name: r[1],
    aliases: r[2],
    sources: r[3],
  }));

  const countRows = (await conn.runAndReadAll(`
    SELECT ti.canonical_id, COUNT(*) AS n
    FROM thread_identity ti
    JOIN messages m ON m.thread_id = ti.thread_id
    WHERE m.meaningful
    GROUP BY ti.canonical_id
  `)).getRows();
  const messageCounts = new Map();
  for (const [cid, n] of countRows) messageCounts.set(cid, Number(n));

  console.log(`  ${identities.length} identities`);
  console.log(`  ${messageCounts.size} have meaningful messages`);

  // 2. Manual overrides
  let overrides = null;
  if (fs.existsSync(OVERRIDES_PATH)) {
    try {
      overrides = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf-8'));
      console.log(`  Loaded ${(overrides.merges || []).length} manual override directives`);
    } catch (err) {
      console.warn(`  Failed to parse ${OVERRIDES_PATH}: ${err.message}`);
    }
  } else {
    console.log(`  No manual overrides at ${path.relative(ROOT, OVERRIDES_PATH)} (optional)`);
  }
  const manualPairs = manualMerges(identities, overrides);

  // 3. Find auto candidates
  console.log('\nFinding auto-merge candidates...');
  const { confident, ambiguous } = findMergeCandidates(identities, { minMessages: 5, messageCounts });
  console.log(`  ${confident.length} confident (auto-merge)`);
  console.log(`  ${ambiguous.length} ambiguous (review)`);
  console.log(`  ${manualPairs.length} from manual override`);

  // 4. Print samples
  const printPair = (m, idx) => {
    const tag = m.manual ? '[manual]' : (m.score >= 1.0 ? '[auto]' : '[ambig]');
    console.log(
      `  ${String(idx + 1).padStart(3)}. ${tag} ${m.loser_name} (${m.loser_sources.join(',')}, ${m.loser_msgs} msgs)`
      + ` → ${m.winner_name} (${m.winner_sources.join(',')}, ${m.winner_msgs} msgs)`
      + (m.merged_display_name && m.merged_display_name !== m.winner_name ? ` rename→ "${m.merged_display_name}"` : '')
    );
  };

  console.log('\n=== Manual override merges ===');
  manualPairs.forEach(printPair);
  console.log('\n=== Confident auto-merges ===');
  confident.slice(0, 30).forEach(printPair);
  if (confident.length > 30) console.log(`  ... and ${confident.length - 30} more`);
  console.log('\n=== Ambiguous (NOT auto-merged) ===');
  ambiguous.slice(0, 20).forEach(printPair);
  if (ambiguous.length > 20) console.log(`  ... and ${ambiguous.length - 20} more`);

  // 5. Write proposals to disk for audit
  fs.writeFileSync(path.join(OUT_DIR, 'merges-proposed.json'), JSON.stringify({ confident, ambiguous, manual: manualPairs }, null, 2));
  console.log(`\nWrote proposals to ${path.relative(ROOT, path.join(OUT_DIR, 'merges-proposed.json'))}`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to rewrite the DB.');
    await conn.disconnectSync();
    return;
  }

  // 6. APPLY — collapse loser → winner across all FK tables
  const all = [...manualPairs, ...confident];
  if (includeAmbiguous) all.push(...ambiguous);

  if (all.length === 0) {
    console.log('\nNothing to merge.');
    await conn.disconnectSync();
    return;
  }

  console.log(`\nApplying ${all.length} merges...`);

  // Resolve transitive merges: if A→B and B→C, then A→C.
  const idMap = new Map();
  for (const m of all) idMap.set(m.loser_id, m.winner_id);
  function resolve(id) {
    let v = id;
    const seen = new Set();
    while (idMap.has(v) && !seen.has(v)) {
      seen.add(v);
      v = idMap.get(v);
    }
    return v;
  }
  // Rebuild final mappings
  const finalMap = new Map();
  for (const id of idMap.keys()) {
    finalMap.set(id, resolve(id));
  }

  // Pick a chosen display_name per winner (prefer manual > confident > existing)
  const renameMap = new Map();  // winner_id → new display_name
  for (const m of all) {
    const w = resolve(m.winner_id);
    if (m.merged_display_name) {
      if (m.manual || !renameMap.has(w)) renameMap.set(w, m.merged_display_name);
    }
  }

  // Fold each loser into its resolved winner. foldIdentity rewrites every
  // FK table (thread_identity, group_membership, mentions, links,
  // photo_faces, face_clusters, birthdays, calls), unions aliases/sources,
  // and deletes the loser row.
  for (const [loser, winner] of finalMap) {
    if (loser === winner) continue;
    await foldIdentity(conn, winner, loser);
  }
  console.log(`  ${finalMap.size} loser identities folded`);

  // Rename display_name on winners where requested
  for (const [winnerId, newName] of renameMap) {
    await conn.run(`UPDATE identities SET display_name = ${esc(newName)} WHERE canonical_id = ${esc(winnerId)}`);
  }
  console.log(`  ${renameMap.size} winner display names updated`);

  await conn.disconnectSync();

  console.log('\nDone. Recommended: run npm run build-connections to regenerate derived links.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
