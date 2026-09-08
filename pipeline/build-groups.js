#!/usr/bin/env node
/**
 * Build group-chat dataset for analysis.
 *
 *   npm run build-groups
 *
 * Outputs:
 *   pipeline/output/groups.json — per-group metadata, members, role stats, monthly activity
 *
 * For each group thread:
 *   - thread_id, name (best guess from participants array), msg_count, span
 *   - members: [{ canonical_id, display_name, msgs, share_pct, first_ts, last_ts, role }]
 *   - monthly_activity: { ym: msgs }
 *   - peak_month
 *   - life_status: 'active' | 'cooling' | 'dormant' | 'dead'
 *
 * Roles per member (within the group):
 *   - 'host'         (top msgs, named by you)
 *   - 'co-host'      (>20% share)
 *   - 'regular'      (5-20%)
 *   - 'periphery'    (<5%)
 *   - 'lurker'       (<1% but >0)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const OUT = path.join(__dirname, 'output', 'groups.json');
const TODAY = new Date();

function daysSince(iso) {
  return Math.round((TODAY - new Date(iso)) / 86400000);
}

async function main() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // Top group threads by msg count
  const groupRows = (await conn.runAndReadAll(`
    SELECT t.thread_id, t.participants::VARCHAR AS p, t.source,
           COUNT(m.id) AS msgs,
           MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts,
           COUNT(DISTINCT m.sender_name) AS distinct_senders
    FROM threads t
    LEFT JOIN messages m ON m.thread_id = t.thread_id
    WHERE t.is_group AND m.body IS NOT NULL AND m.body <> ''
    GROUP BY t.thread_id, t.participants, t.source
    HAVING msgs > 50
    ORDER BY msgs DESC
    LIMIT 80
  `)).getRows();

  console.log(`Found ${groupRows.length} group threads with >50 msgs.`);

  const groups = [];
  for (const [tid, pStr, source, msgs, firstTs, lastTs, distinct] of groupRows) {
    const participants = pStr.replace(/[\[\]]/g, '').split(',').map(s => s.replace(/^['"\s]+|['"\s]+$/g, '')).filter(Boolean);

    // Per-sender stats inside this thread
    const senderRows = (await conn.runAndReadAll(`
      SELECT m.sender_name, COUNT(*) AS n, MIN(m.ts) AS f, MAX(m.ts) AS l
      FROM messages m WHERE m.thread_id = '${tid.replace(/'/g, "''")}'
        AND m.body IS NOT NULL AND m.body <> ''
        AND m.sender_name IS NOT NULL AND m.sender_name <> ''
      GROUP BY m.sender_name ORDER BY n DESC
    `)).getRows();

    const totalMsgs = senderRows.reduce((s, r) => s + Number(r[1]), 0);

    // Resolve each sender_name to canonical_id via identities (display_name OR alias)
    const members = [];
    for (const [name, n, f, l] of senderRows) {
      const idRow = (await conn.runAndReadAll(`
        SELECT canonical_id FROM identities
        WHERE display_name = '${name.replace(/'/g, "''")}'
           OR list_contains(aliases, '${name.replace(/'/g, "''")}')
        LIMIT 1
      `)).getRows();
      const cid = idRow.length ? idRow[0][0] : null;
      const share = Number(n) / Math.max(1, totalMsgs);
      let role;
      if (name === 'Demo User') role = 'self';
      else if (share >= 0.30) role = 'host';
      else if (share >= 0.15) role = 'co-host';
      else if (share >= 0.05) role = 'regular';
      else if (share >= 0.01) role = 'periphery';
      else role = 'lurker';
      members.push({
        sender_name: name,
        canonical_id: cid,
        msgs: Number(n),
        share_pct: Math.round(share * 1000) / 10,
        first_ts: Number(f),
        last_ts: Number(l),
        role,
      });
    }

    // Per-month activity
    const monthRows = (await conn.runAndReadAll(`
      SELECT strftime(make_timestamp(ts*1000), '%Y-%m') AS ym, COUNT(*) AS n
      FROM messages WHERE thread_id = '${tid.replace(/'/g, "''")}'
        AND body IS NOT NULL AND body <> ''
      GROUP BY ym ORDER BY ym
    `)).getRows();
    const monthly = {};
    for (const [ym, n] of monthRows) monthly[ym] = Number(n);
    const months = Object.keys(monthly).sort();
    const peakMonth = Object.entries(monthly).sort((a, b) => b[1] - a[1])[0][0];

    const lastIso = new Date(Number(lastTs)).toISOString().slice(0, 10);
    const dSince = daysSince(lastIso);
    const life_status = dSince <= 60 ? 'active'
                       : dSince <= 365 ? 'cooling'
                       : dSince <= 1095 ? 'dormant'
                       : 'dead';

    groups.push({
      thread_id: tid,
      source,
      // Best-guess group name: participants joined, capped
      name: participants.slice(0, 4).join(', ') + (participants.length > 4 ? `, +${participants.length - 4}` : ''),
      participants_raw: participants,
      msg_count: Number(msgs),
      first_iso: new Date(Number(firstTs)).toISOString().slice(0, 10),
      last_iso: lastIso,
      days_since_last: dSince,
      distinct_senders: Number(distinct),
      peak_month: peakMonth,
      life_status,
      monthly,
      members,
    });
  }

  fs.writeFileSync(OUT, JSON.stringify({
    generated: TODAY.toISOString(),
    count: groups.length,
    groups,
  }, null, 2));

  console.log(`groups.json: ${groups.length} groups written`);
  console.log(`  active: ${groups.filter(g => g.life_status === 'active').length}`);
  console.log(`  cooling: ${groups.filter(g => g.life_status === 'cooling').length}`);
  console.log(`  dormant: ${groups.filter(g => g.life_status === 'dormant').length}`);
  console.log(`  dead: ${groups.filter(g => g.life_status === 'dead').length}`);
  console.log(`Top 10 by msgs:`);
  for (const g of groups.slice(0, 10)) {
    console.log(`  ${String(g.msg_count).padStart(6)} | ${g.life_status.padEnd(8)} | ${g.distinct_senders} ppl | ${g.first_iso} → ${g.last_iso} | ${g.name}`);
  }

  await conn.disconnectSync();
}

main().catch(e => { console.error(e); process.exit(1); });
