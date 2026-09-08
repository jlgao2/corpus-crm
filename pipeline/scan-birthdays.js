#!/usr/bin/env node
/**
 * Scan messages for birthday signals and add high-confidence ones to
 * the birthdays table.
 *
 *   npm run scan-birthdays              # dry-run
 *   npm run scan-birthdays -- --apply   # insert into the DB
 *
 * Strategy:
 *  - For each 1-on-1 thread, find Demo's messages matching
 *    /happy birthday|happy bday|hbd|happy b'?day|🎂|🎁/i
 *  - The (month, day) of those messages is a candidate birthday for
 *    the OTHER person in the thread
 *  - Group by canonical_id + month + day
 *  - Confidence:
 *      HIGH   = 2+ messages across distinct years on the same MM-DD
 *      MEDIUM = 1 message with no conflicting MM-DD candidate
 *      LOW    = 1 message but other candidates exist for this person
 *  - Insert HIGH and MEDIUM with source='inferred-msg'
 *  - Skip any (canonical_id, MM-DD) that's already in the birthdays table
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function main() {
  const apply = process.argv.includes('--apply');
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  console.log(`Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  // Find Demo's "happy birthday" messages in 1-on-1 threads, grouped by
  // (recipient canonical_id, month, day) with year list and message count.
  const sql = `
    WITH bday_msgs AS (
      SELECT
        ti.canonical_id,
        i.display_name,
        date_part('month', make_timestamp(m.ts*1000)) AS month,
        date_part('day',   make_timestamp(m.ts*1000)) AS day,
        date_part('year',  make_timestamp(m.ts*1000)) AS year,
        COUNT(*) AS n,
        m.ts
      FROM messages m
      JOIN thread_identity ti ON ti.thread_id = m.thread_id
      JOIN threads t          ON t.thread_id  = m.thread_id
      JOIN identities i       ON i.canonical_id = ti.canonical_id
      WHERE m.from_me
        AND NOT t.is_group
        AND m.meaningful
        AND (
          regexp_matches(LOWER(m.body), '\\bhappy\\s+birthday\\b')
          OR regexp_matches(LOWER(m.body), '\\bhbd\\b')
          OR regexp_matches(LOWER(m.body), '\\bhappy\\s+b''?day\\b')
          OR regexp_matches(m.body, '🎂')
        )
      GROUP BY ti.canonical_id, i.display_name, month, day, year, m.ts
    ),
    by_pair AS (
      SELECT
        canonical_id,
        any_value(display_name) AS display_name,
        CAST(month AS INTEGER) AS month,
        CAST(day AS INTEGER) AS day,
        COUNT(DISTINCT year) AS distinct_years,
        COUNT(*) AS msg_count,
        list(DISTINCT CAST(year AS INTEGER)) AS years
      FROM bday_msgs
      GROUP BY canonical_id, month, day
    )
    SELECT * FROM by_pair
    ORDER BY canonical_id, distinct_years DESC, month, day
  `;
  const rows = (await conn.runAndReadAll(sql)).getRows();

  // Build a map: canonical_id → list of (month, day, distinct_years, ...)
  const perPerson = new Map();
  for (const [canId, displayName, month, day, distinctYears, msgCount, yearsRaw] of rows) {
    const years = Array.isArray(yearsRaw) ? yearsRaw : (yearsRaw && yearsRaw.items) || [];
    if (!perPerson.has(canId)) perPerson.set(canId, { displayName, candidates: [] });
    perPerson.get(canId).candidates.push({ month, day, distinctYears: Number(distinctYears), msgCount: Number(msgCount), years });
  }

  // Existing birthday rows — don't double-insert
  const existingRows = (await conn.runAndReadAll(
    `SELECT canonical_id, month, day FROM birthdays`
  )).getRows();
  const existing = new Set(existingRows.map(r => `${r[0]}|${r[1]}|${r[2]}`));

  // Classify
  const high = [], medium = [], low = [];
  for (const [canId, { displayName, candidates }] of perPerson) {
    // For each person, the "best" candidate is the one with most distinct years
    candidates.sort((a, b) => b.distinctYears - a.distinctYears || b.msgCount - a.msgCount);
    const top = candidates[0];
    const others = candidates.slice(1);

    const key = `${canId}|${top.month}|${top.day}`;
    if (existing.has(key)) continue;

    const note = {
      canonical_id: canId,
      display_name: displayName,
      month: top.month,
      day: top.day,
      msg_count: top.msgCount,
      years: top.years,
      conflicting: others,
    };

    if (top.distinctYears >= 2) high.push(note);
    else if (others.length === 0) medium.push(note);
    else low.push(note);
  }

  const fmt = (n) => `${String(n.month).padStart(2, ' ')}/${String(n.day).padStart(2, ' ')} for ${n.display_name} (msgs: ${n.msg_count}, years: ${n.years.join(',')})`;

  console.log(`HIGH confidence (2+ years on same MM-DD): ${high.length}`);
  high.forEach(n => console.log(`  ✓ ${fmt(n)}`));
  console.log(`\nMEDIUM confidence (1 message, no conflicting candidate): ${medium.length}`);
  medium.forEach(n => console.log(`  ~ ${fmt(n)}`));
  console.log(`\nLOW confidence (1 msg, conflicting candidates exist): ${low.length}`);
  low.slice(0, 10).forEach(n => {
    const conflicts = n.conflicting.map(c => `${c.month}/${c.day}`).join(',');
    console.log(`  ? ${fmt(n)} — also seen on: ${conflicts}`);
  });
  if (low.length > 10) console.log(`  (... and ${low.length - 10} more)`);

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to insert HIGH and MEDIUM into the birthdays table.');
    await conn.disconnectSync();
    return;
  }

  console.log(`\nInserting ${high.length + medium.length} inferred birthdays...`);
  for (const n of [...high, ...medium]) {
    await conn.run(`
      INSERT INTO birthdays (canonical_id, name, month, day, year, year_known, source)
      VALUES (${esc(n.canonical_id)}, ${esc(n.display_name)}, ${n.month}, ${n.day}, NULL, false, 'inferred-msg')
    `);
  }
  console.log('Done.');
  await conn.disconnectSync();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
