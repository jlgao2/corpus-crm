#!/usr/bin/env node
/**
 * Detect + fix threads misclassified as 1-on-1 when they're actually groups.
 *
 * The Meta-export parser marks `is_group=FALSE` when only one participant
 * name is parseable (the rest got scrubbed by Meta's privacy export). But
 * if 3+ DISTINCT sender_names appear in the messages, it was actually a
 * group, and the message volume gets attributed to the one named identity
 * (e.g. Jacky Ung's 62k inflation).
 *
 * Fix: for each thread with COUNT(DISTINCT sender_name) >= 3 AND is_group=FALSE,
 * flip to group, replace participants with the distinct senders, and clear
 * the thread_identity rows so build-connections rebuilds them as group_membership.
 *
 * Run after build-db (and before build-connections) to make the correction
 * durable across rebuilds.
 *
 * Usage:
 *   node pipeline/fix-misclassified-groups.js                # apply fixes
 *   node pipeline/fix-misclassified-groups.js --dry-run      # report only
 */

import { DuckDBInstance } from '@duckdb/node-api';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'pipeline', 'output', 'raw', 'messages.duckdb');

const DRY_RUN = process.argv.includes('--dry-run');
const MIN_DISTINCT_SENDERS = 3;

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // 1. Detect candidates
  const reader = await conn.runAndReadAll(`
    SELECT t.thread_id, t.participants,
           list(DISTINCT m.sender_name) FILTER (WHERE m.sender_name IS NOT NULL) AS senders,
           COUNT(DISTINCT m.sender_name) AS n_senders,
           COUNT(*) AS msg_count
    FROM threads t
    JOIN messages m ON m.thread_id = t.thread_id
    WHERE t.is_group = FALSE
    GROUP BY t.thread_id, t.participants
    HAVING n_senders >= ${MIN_DISTINCT_SENDERS}
    ORDER BY msg_count DESC
  `);
  const candidates = reader.getRowObjectsJson();

  console.log(`[fix-groups] ${candidates.length} threads with ≥${MIN_DISTINCT_SENDERS} distinct senders but is_group=FALSE`);
  if (!candidates.length) { conn.disconnectSync(); return; }

  for (const c of candidates) {
    const senders = (c.senders || []).filter(s => s && s.trim());
    console.log(`  ${c.thread_id}  (${c.msg_count.toLocaleString()} msgs, ${c.n_senders} senders) — participants will become: ${senders.slice(0, 6).join(', ')}${senders.length > 6 ? `… +${senders.length - 6}` : ''}`);
  }

  if (DRY_RUN) {
    console.log('[fix-groups] dry-run; no changes applied');
    conn.disconnectSync();
    return;
  }

  // 2. Apply fixes
  for (const c of candidates) {
    const senders = (c.senders || []).filter(s => s && s.trim());
    const sendersLit = '[' + senders.map(s => "'" + s.replace(/'/g, "''") + "'").join(',') + ']';
    const tidLit = "'" + c.thread_id.replace(/'/g, "''") + "'";
    await conn.run(`UPDATE threads SET is_group = TRUE, participants = ${sendersLit} WHERE thread_id = ${tidLit}`);
    await conn.run(`DELETE FROM thread_identity WHERE thread_id = ${tidLit}`);
  }
  console.log(`[fix-groups] reclassified ${candidates.length} threads as is_group=TRUE`);
  conn.disconnectSync();
}

main().catch(err => { console.error('[fix-groups] fatal:', err); process.exit(1); });
