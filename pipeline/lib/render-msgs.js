#!/usr/bin/env node
// Render a thread (or set of threads) within a time window with sender-local
// timestamps. Useful as a one-shot CLI or imported into REPL.
//
// CLI usage:
//   node pipeline/lib/render-msgs.js \
//     --counterparty id-1233 \
//     --thread "imsg:+155501001" --thread "wai:15550100@s.whatsapp.net" --thread "ig:maya_100000000000001" \
//     --from 2025-07-08 --to 2025-07-15
//
//   # alternative: select threads by substring of thread_id
//   node pipeline/lib/render-msgs.js --counterparty id-1233 \
//     --thread-like 15550100 --thread-like maya_100000000000001 \
//     --from 2025-07-08 --to 2025-07-15
//
// Programmatic:
//   import { renderMessages } from './render-msgs.js';
//   const lines = await renderMessages({ counterpartyId, threadIds, from, to });

import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { formatLocal, resolveTz } from './local-time.js';
import { filterRedacted } from './redactions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_DB = path.resolve(__dirname, '..', 'output', 'raw', 'messages.duckdb');

// ---------- core ----------

async function getCounterpartyName(conn, canonicalId) {
  if (!canonicalId) return null;
  const r = await conn.run(
    `SELECT display_name FROM identities WHERE canonical_id = '${canonicalId.replace(/'/g, "''")}'`
  );
  const rows = await r.getRowObjectsJson();
  return rows[0]?.display_name || null;
}

function dateToMs(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  // Accept "YYYY-MM-DD" or full ISO.
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {object} args
 * @param {string} args.counterpartyId  canonical_id of the non-user party (drives tz resolution for their messages)
 * @param {string[]} [args.threadIds]   exact thread_id values to include
 * @param {string[]} [args.threadLike]  substrings; each one becomes a LIKE filter
 * @param {string|number|Date} args.from  inclusive lower bound (ISO date string or ms)
 * @param {string|number|Date} args.to    exclusive upper bound
 * @param {string} [args.dbPath]
 * @param {string} [args.meId='id-751']
 * @returns {Promise<{ lines: string[], rows: Array, counterpartyName: string|null }>}
 */
export async function renderMessages({
  counterpartyId,
  threadIds = [],
  threadLike = [],
  from,
  to,
  dbPath = DEFAULT_DB,
  meId = 'id-751',
}) {
  const fromMs = dateToMs(from);
  const toMs = dateToMs(to);
  if (fromMs == null || toMs == null) throw new Error('renderMessages requires --from and --to');

  const inst = await DuckDBInstance.create(dbPath);
  const conn = await inst.connect();

  const counterpartyName = await getCounterpartyName(conn, counterpartyId);

  const exactClause = threadIds.length
    ? `thread_id IN (${threadIds.map(t => `'${t.replace(/'/g, "''")}'`).join(', ')})`
    : null;
  const likeClause = threadLike.length
    ? `(${threadLike.map(p => `thread_id LIKE '%${p.replace(/'/g, "''")}%'`).join(' OR ')})`
    : null;
  const threadFilter = [exactClause, likeClause].filter(Boolean).join(' OR ');
  if (!threadFilter) {
    throw new Error('renderMessages requires --thread and/or --thread-like');
  }

  const sql = `
    SELECT id, ts, ts_iso, source, thread_id, from_me, sender_name, body, attachment_type
    FROM messages
    WHERE (${threadFilter})
      AND ts >= ${fromMs} AND ts < ${toMs}
    ORDER BY ts
  `;
  const r = await conn.run(sql);
  const rows = filterRedacted(await r.getRowObjectsJson());

  const meName = 'Demo';
  const themName = counterpartyName || counterpartyId || 'them';

  const lines = rows.map(row => {
    const senderId = row.from_me ? meId : counterpartyId;
    const senderName = row.from_me ? meName : themName;
    const receiverId = row.from_me ? counterpartyId : meId;
    const receiverName = row.from_me ? themName : meName;

    const senderLocal = formatLocal(senderId, row.ts);
    const senderTz = resolveTz(senderId, row.ts);
    const receiverTz = resolveTz(receiverId, row.ts);
    const sameTz = senderTz.tz === receiverTz.tz;

    const senderStr = `${senderLocal.formatted} (${senderName})`;
    const both = sameTz
      ? senderStr
      : `${senderStr} / ${formatLocal(receiverId, row.ts, { withDate: false }).formatted} (${receiverName})`;

    const speaker = row.from_me ? 'ME' : 'THEM';
    const body = (row.body || (row.attachment_type ? `[${row.attachment_type}]` : '')).replace(/\n/g, ' ⏎ ');
    const src = row.source ? `[${row.source}]` : '';
    return `${both} — ${speaker} ${src}  | ${body}`;
  });

  return { lines, rows, counterpartyName };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { threadIds: [], threadLike: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--counterparty') out.counterpartyId = next();
    else if (a === '--thread') out.threadIds.push(next());
    else if (a === '--thread-like') out.threadLike.push(next());
    else if (a === '--from') out.from = next();
    else if (a === '--to') out.to = next();
    else if (a === '--out') out.outPath = next();
    else if (a === '--db') out.dbPath = next();
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

const HELP = `render-msgs — extract a thread window with sender-local timestamps

  --counterparty <id>        canonical_id of the other party (e.g. id-1233)
  --thread <thread_id>       repeatable; exact match
  --thread-like <substr>     repeatable; substring match on thread_id
  --from YYYY-MM-DD          inclusive lower bound (UTC date)
  --to   YYYY-MM-DD          exclusive upper bound (UTC date)
  --out <path>               also write to this file
  --db <path>                override DB path (default: pipeline/output/raw/messages.duckdb)
`;

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }
  if (args.help) { process.stdout.write(HELP); return; }

  const { lines, rows, counterpartyName } = await renderMessages(args);
  const header = [
    `# ${counterpartyName || args.counterpartyId} — ${args.from} → ${args.to}`,
    `# ${rows.length} messages across ${new Set(rows.map(r => r.thread_id)).size} thread(s)`,
    `# rendered with sender-local time (receiver-local appended when tz differs)`,
    '',
  ];
  const output = [...header, ...lines].join('\n') + '\n';
  process.stdout.write(output);

  if (args.outPath) {
    const fs = await import('fs');
    fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
    fs.writeFileSync(args.outPath, output);
    process.stderr.write(`\nwrote ${args.outPath}\n`);
  }
}

const invokedPath = process.argv[1] ? fileURLToPath(new URL(`file://${process.argv[1]}`)) : '';
if (__filename === invokedPath) {
  main().catch(err => { console.error(err); process.exit(1); });
}
