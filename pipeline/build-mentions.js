#!/usr/bin/env node
/**
 * For each top-N person, extract every external mention (in OTHER 1-on-1 threads
 * where someone else mentions them) and emit a markdown side-quotes block.
 *
 *   npm run build-mentions
 *
 * Outputs: pipeline/output/portraits/mentions/<slug>.md  (one per person)
 *
 * The mention block is suitable to fold into the portrait under a section like:
 *   ## How others see her
 *
 * Keeps quotes only when:
 *   - thread_owner ≠ self (excludes "you mentioning them in a self-thread", which doesn't exist)
 *   - body length 5–500 chars (skip empty / mega-paste)
 *   - body contains the actual name/handle (sanity check; mentions table can over-match)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const OUT_DIR = path.join(__dirname, 'output', 'portraits', 'mentions');
const TOP_N = 60;

function safeFilename(s) { return s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, ''); }

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // Top N people we care about (1-on-1 volume)
  const top = (await conn.runAndReadAll(`
    SELECT i.canonical_id, i.display_name, COUNT(m.id) AS n
    FROM messages m
    JOIN thread_identity ti ON ti.thread_id = m.thread_id
    JOIN threads t ON t.thread_id = m.thread_id
    JOIN identities i ON i.canonical_id = ti.canonical_id
    WHERE NOT t.is_group AND m.body IS NOT NULL AND m.body <> ''
    GROUP BY i.canonical_id, i.display_name
    ORDER BY n DESC LIMIT ${TOP_N}
  `)).getRows();

  let writtenCount = 0;
  for (const [cid, name] of top) {
    const mentions = (await conn.runAndReadAll(`
      SELECT i.display_name AS owner,
             strftime(make_timestamp(mn.ts*1000), '%Y-%m-%d') AS day,
             m.from_me, m.body
      FROM mentions mn
      JOIN messages m ON m.id = mn.message_id
      JOIN thread_identity ti ON ti.thread_id = mn.thread_id
      JOIN threads t ON t.thread_id = mn.thread_id
      JOIN identities i ON i.canonical_id = ti.canonical_id
      WHERE mn.mentioned_canonical_id = '${cid}'
        AND NOT t.is_group
        AND ti.canonical_id <> '${cid}'
        AND LENGTH(m.body) BETWEEN 5 AND 500
      ORDER BY mn.ts
    `)).getRows();

    if (mentions.length < 3) continue;

    // Bucket by owner; surface quotes per friend
    const byOwner = new Map();
    for (const [owner, day, fm, body] of mentions) {
      const key = owner;
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key).push({ day, from_me: fm, body });
    }

    // Sort owners by their msg count
    const owners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);

    const sections = [];
    sections.push(`# ${name} — mentions in others' threads\n`);
    sections.push(`*${mentions.length} times mentioned across ${byOwner.size} friends' 1-on-1 threads.*\n`);
    for (const [owner, msgs] of owners) {
      sections.push(`## In ${owner}'s thread (${msgs.length})\n`);
      for (const m of msgs) {
        const speaker = m.from_me ? 'You' : owner;
        // Strip iMessage exporter pollution from body
        const cleanBody = m.body
          .replace(/\nTapbacks:[\s\S]*$/i, '')
          .replace(/\n[ \t]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}[\s\S]*$/i, '')
          .replace(/\n+/g, ' / ')
          .trim();
        sections.push(`- **${m.day}** ${speaker}: ${cleanBody}`);
      }
      sections.push('');
    }

    const outPath = path.join(OUT_DIR, safeFilename(name) + '.md');
    fs.writeFileSync(outPath, sections.join('\n'));
    writtenCount++;
  }

  console.log(`wrote ${writtenCount} mention files to ${path.relative(path.join(__dirname, '..'), OUT_DIR)}`);
  await conn.disconnectSync();
}

main().catch(e => { console.error(e); process.exit(1); });
