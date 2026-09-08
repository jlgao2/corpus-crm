#!/usr/bin/env node
/**
 * Context-snippet generator.
 *
 *   node pipeline/cli-context.js "Display Name"
 *   node pipeline/cli-context.js --canonical id-42
 *
 * Given a person, return a packet of "linking facts" mined from the connection
 * map: group memberships, frequent co-mentions, top mentioning threads, recent
 * mention samples. This is what gets prepended to a future portrait
 * synthesizer's prompt so they know who-knows-whom-and-via-what.
 *
 * Output is markdown, written to stdout (or `--out path.md`).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');

function parseArgs(argv) {
  const args = { name: null, canonicalId: null, out: null, top: 10 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--canonical') args.canonicalId = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--top') args.top = parseInt(argv[++i], 10);
    else if (!args.name) args.name = argv[i];
  }
  return args;
}

async function getRows(conn, sql) {
  const r = await conn.runAndReadAll(sql);
  return r.getRows();
}

async function getOne(conn, sql) {
  const rows = await getRows(conn, sql);
  return rows[0] || null;
}

function escSql(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function isoDay(tsMs) {
  return new Date(Number(tsMs)).toISOString().slice(0, 10);
}

async function resolveIdentity(conn, args) {
  if (args.canonicalId) {
    const row = await getOne(conn, `SELECT canonical_id, display_name, aliases, sources FROM identities WHERE canonical_id = ${escSql(args.canonicalId)}`);
    return row;
  }
  if (args.name) {
    // Try exact display name first
    let row = await getOne(conn, `SELECT canonical_id, display_name, aliases, sources FROM identities WHERE LOWER(display_name) = LOWER(${escSql(args.name)}) LIMIT 1`);
    if (row) return row;
    // Then alias contains
    row = await getOne(conn, `
      SELECT canonical_id, display_name, aliases, sources
      FROM identities
      WHERE list_contains(aliases, ${escSql(args.name)})
      LIMIT 1
    `);
    if (row) return row;
    // Then case-insensitive alias scan
    row = await getOne(conn, `
      SELECT canonical_id, display_name, aliases, sources
      FROM identities
      WHERE EXISTS (SELECT 1 FROM UNNEST(aliases) AS u(a) WHERE LOWER(u.a) = LOWER(${escSql(args.name)}))
      LIMIT 1
    `);
    return row;
  }
  return null;
}

async function generateContext(conn, identity, top) {
  const [canId, dispName, aliasesRaw, sourcesRaw] = identity;
  const aliases = Array.isArray(aliasesRaw) ? aliasesRaw : (aliasesRaw && aliasesRaw.items) || [];
  const sources = Array.isArray(sourcesRaw) ? sourcesRaw : (sourcesRaw && sourcesRaw.items) || [];

  let md = '';
  md += `# Context for ${dispName}\n\n`;
  md += `_canonical: \`${canId}\`_\n\n`;
  md += `**Aliases:** ${aliases.length ? aliases.map(a => '`' + a + '`').join(', ') : '(none)'}  \n`;
  md += `**Sources:** ${sources.join(', ') || '(none)'}\n\n`;

  // Direct thread stats
  const directRows = await getRows(conn, `
    SELECT
      ti.thread_id,
      t.source,
      COUNT(*) AS msgs,
      MIN(m.ts) AS first_ts,
      MAX(m.ts) AS last_ts,
      SUM(CASE WHEN m.from_me THEN 1 ELSE 0 END) AS from_me
    FROM thread_identity ti
    JOIN messages m ON m.thread_id = ti.thread_id
    JOIN threads t   ON t.thread_id = ti.thread_id
    WHERE ti.canonical_id = ${escSql(canId)}
      AND m.meaningful
    GROUP BY ti.thread_id, t.source
    ORDER BY msgs DESC
  `);
  if (directRows.length) {
    md += `## Direct threads (1-on-1)\n\n`;
    md += `| Source | Messages | From you | Range |\n|---|---:|---:|---|\n`;
    for (const [tid, src, n, firstTs, lastTs, fromMe] of directRows) {
      md += `| ${src} | ${Number(n).toLocaleString()} | ${Number(fromMe).toLocaleString()} | ${isoDay(firstTs)} → ${isoDay(lastTs)} |\n`;
    }
    md += `\n`;
  }

  // Group memberships (this person and who else is in those groups with Demo)
  const groups = await getRows(conn, `
    SELECT t.thread_id, t.source,
      (SELECT LIST(participant_name) FROM group_membership gm2 WHERE gm2.thread_id = t.thread_id) AS members,
      (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.thread_id AND m.meaningful) AS n_msgs
    FROM group_membership gm
    JOIN threads t ON gm.thread_id = t.thread_id
    WHERE gm.canonical_id = ${escSql(canId)}
    ORDER BY n_msgs DESC
  `);
  if (groups.length) {
    md += `## Group threads they're in\n\n`;
    for (const [tid, src, membersRaw, n] of groups) {
      const members = Array.isArray(membersRaw) ? membersRaw : (membersRaw && membersRaw.items) || [];
      const others = members.filter(m => m && m !== dispName).slice(0, 8);
      const moreCount = Math.max(0, members.length - 1 - others.length);
      const memList = others.join(', ') + (moreCount > 0 ? `, +${moreCount} more` : '');
      md += `- **${tid.slice(0, 60)}** (${src}, ${Number(n).toLocaleString()} msgs) — with ${memList || '(only this person)'}\n`;
    }
    md += `\n`;
  }

  // Top co-mentioned with — who is named alongside this person on the same day
  const coMentioned = await getRows(conn, `
    SELECT related_label, related_canonical_id, SUM(weight) AS total
    FROM links
    WHERE link_type = 'co_mentioned'
      AND (canonical_id = ${escSql(canId)} OR related_canonical_id = ${escSql(canId)})
    GROUP BY related_label, related_canonical_id
    ORDER BY total DESC
    LIMIT ${top}
  `);
  // Note: co_mentioned was symmetric-stored as a < b, so we may need to look from both sides
  const coRows = await getRows(conn, `
    WITH all_pairs AS (
      SELECT
        CASE WHEN canonical_id = ${escSql(canId)} THEN related_canonical_id ELSE canonical_id END AS other_id,
        SUM(weight) AS total
      FROM links
      WHERE link_type = 'co_mentioned'
        AND (canonical_id = ${escSql(canId)} OR related_canonical_id = ${escSql(canId)})
      GROUP BY other_id
    )
    SELECT i.display_name, ap.other_id, ap.total
    FROM all_pairs ap
    LEFT JOIN identities i ON i.canonical_id = ap.other_id
    ORDER BY ap.total DESC
    LIMIT ${top}
  `);
  if (coRows.length) {
    md += `## Frequently mentioned alongside (same day, same thread)\n\n`;
    for (const [otherName, otherId, n] of coRows) {
      md += `- **${otherName || '(unknown)'}** (${otherId || '?'}) — ${Number(n).toLocaleString()} co-mentions\n`;
    }
    md += `\n`;
  }

  // Where they're talked about — top threads where they're mentioned
  const threadMentions = await getRows(conn, `
    SELECT m.thread_id, t.is_group, COUNT(*) AS n,
      MIN(m.ts) AS first_ts, MAX(m.ts) AS last_ts
    FROM mentions m
    JOIN threads t ON t.thread_id = m.thread_id
    WHERE m.mentioned_canonical_id = ${escSql(canId)}
    GROUP BY m.thread_id, t.is_group
    ORDER BY n DESC
    LIMIT ${top}
  `);
  if (threadMentions.length) {
    md += `## Where they're talked about (other threads)\n\n`;
    md += `| Thread | Group? | Mentions | Range |\n|---|:---:|---:|---|\n`;
    for (const [tid, isGroup, n, firstTs, lastTs] of threadMentions) {
      // Resolve thread label to a display name if 1-on-1
      let label = tid;
      if (!isGroup) {
        const t = await getOne(conn, `
          SELECT i.display_name FROM thread_identity ti
          JOIN identities i ON i.canonical_id = ti.canonical_id
          WHERE ti.thread_id = ${escSql(tid)} LIMIT 1
        `);
        if (t) label = `1-on-1 with ${t[0]}`;
      } else {
        // For group, show first 3 participants
        const t = await getOne(conn, `SELECT LIST(participant_name) FROM group_membership WHERE thread_id = ${escSql(tid)}`);
        if (t) {
          const members = Array.isArray(t[0]) ? t[0] : (t[0] && t[0].items) || [];
          label = `group: ${members.slice(0, 3).join(', ')}${members.length > 3 ? '...' : ''}`;
        }
      }
      md += `| ${label} | ${isGroup ? '✓' : ''} | ${Number(n)} | ${isoDay(firstTs)} → ${isoDay(lastTs)} |\n`;
    }
    md += `\n`;
  }

  // Recent mention sample — 5 most recent mentions outside their own thread, with context
  const recentMentions = await getRows(conn, `
    SELECT mt.ts, mt.from_me, mt.thread_id, mt.message_id,
      msg.body, t.is_group
    FROM mentions mt
    JOIN messages msg ON msg.id = mt.message_id
    JOIN threads t ON t.thread_id = mt.thread_id
    WHERE mt.mentioned_canonical_id = ${escSql(canId)}
    ORDER BY mt.ts DESC
    LIMIT 8
  `);
  if (recentMentions.length) {
    md += `## Recent sample (where they came up in other conversations)\n\n`;
    for (const [ts, fromMe, tid, mid, body, isGroup] of recentMentions) {
      let label = tid.slice(0, 30);
      if (!isGroup) {
        const t = await getOne(conn, `
          SELECT i.display_name FROM thread_identity ti
          JOIN identities i ON i.canonical_id = ti.canonical_id
          WHERE ti.thread_id = ${escSql(tid)} LIMIT 1
        `);
        if (t) label = t[0];
      }
      const speaker = fromMe ? 'You' : `[${label}]`;
      const snip = String(body).replace(/\s+/g, ' ').slice(0, 200);
      md += `- **${isoDay(ts)}** ${speaker} → ${label}: _"${snip}"_\n`;
    }
    md += `\n`;
  }

  return md;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.name && !args.canonicalId) {
    console.error('Usage: node pipeline/cli-context.js "Display Name"');
    console.error('       node pipeline/cli-context.js --canonical id-42');
    console.error('       --out path.md to write to file instead of stdout');
    process.exit(1);
  }

  const inst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();

  const identity = await resolveIdentity(conn, args);
  if (!identity) {
    console.error(`No identity found for "${args.name || args.canonicalId}".`);
    console.error('Try one of these:');
    const top = await getRows(conn, `
      SELECT i.display_name, COUNT(*) AS msgs
      FROM identities i
      JOIN thread_identity ti ON ti.canonical_id = i.canonical_id
      JOIN messages m ON m.thread_id = ti.thread_id
      WHERE m.meaningful AND i.display_name IS NOT NULL
      GROUP BY i.display_name
      ORDER BY msgs DESC
      LIMIT 15
    `);
    for (const [name, n] of top) console.error(`  - ${name} (${n})`);
    process.exit(1);
  }

  const md = await generateContext(conn, identity, args.top);

  if (args.out) {
    fs.writeFileSync(args.out, md);
    console.error(`Wrote ${md.length} chars to ${args.out}`);
  } else {
    process.stdout.write(md);
  }

  await conn.disconnectSync();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
