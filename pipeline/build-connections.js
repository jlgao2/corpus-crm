#!/usr/bin/env node
/**
 * Build the connection map on top of messages.duckdb.
 *
 *   node pipeline/build-connections.js
 *
 * Adds three derived tables to the existing DB:
 *
 *   group_membership  — every (group_thread, person) pair, with canonical_id
 *                       resolution where possible
 *   mentions          — every time person X is mentioned by name in thread Y at
 *                       time Z, by speaker S
 *   links             — derived per-person link facts: shared groups,
 *                       co-mentions, with counts and evidence
 *
 * Idempotent: drops + recreates the three tables on each run.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');

function escSql(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Tokens to strip when comparing aliases — bare emoji, punctuation, very short tokens
function nameableForms(displayName, aliases) {
  // Returns an array of candidate strings to search for in message bodies.
  // Filters out phone numbers, emails, anything <3 letters, and pure-symbol entries.
  const out = new Set();
  // DuckDB returns list-typed columns as DuckDBListValue { items: [...] } — unwrap it.
  const aliasArr = Array.isArray(aliases)
    ? aliases
    : (aliases && Array.isArray(aliases.items) ? aliases.items : []);
  const candidates = [displayName, ...aliasArr];
  for (const raw of candidates) {
    if (!raw) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (/^[+\d]/.test(s)) continue;            // phone-shaped
    if (s.includes('@')) continue;             // email-shaped
    if (s.length < 3) continue;                // too short to disambiguate
    // Strip emoji/decoration: pull out the longest run of letters/spaces
    const letters = s.replace(/[^\p{L}\p{N}\s'.-]/gu, ' ').trim();
    if (letters.length < 3) continue;
    // Use first-name and full-form as candidates
    const first = letters.split(/\s+/)[0];
    if (first && first.length >= 3 && /\p{L}/u.test(first)) out.add(first);
    if (letters.length >= 3 && letters.length <= 40) out.add(letters);
  }
  return [...out];
}

async function main() {
  console.log('Opening DuckDB...');
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();

  // ─── Drop and recreate ────────────────────────────────────────────────────
  await conn.run(`
    DROP TABLE IF EXISTS group_membership;
    DROP TABLE IF EXISTS mentions;
    DROP TABLE IF EXISTS links;

    CREATE TABLE group_membership (
      thread_id        VARCHAR NOT NULL,
      participant_name VARCHAR NOT NULL,
      canonical_id     VARCHAR,
      PRIMARY KEY (thread_id, participant_name)
    );
    CREATE INDEX idx_gm_canonical ON group_membership(canonical_id);

    CREATE TABLE mentions (
      mentioned_canonical_id VARCHAR NOT NULL,
      mentioned_form         VARCHAR NOT NULL,
      thread_id              VARCHAR NOT NULL,
      message_id             VARCHAR NOT NULL,
      ts                     BIGINT NOT NULL,
      from_me                BOOLEAN NOT NULL
    );
    CREATE INDEX idx_mentions_who    ON mentions(mentioned_canonical_id);
    CREATE INDEX idx_mentions_thread ON mentions(thread_id);

    CREATE TABLE links (
      canonical_id          VARCHAR NOT NULL,
      link_type             VARCHAR NOT NULL,
      related_canonical_id  VARCHAR,
      related_label         VARCHAR,
      evidence              VARCHAR,
      weight                INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX idx_links_subject ON links(canonical_id);
    CREATE INDEX idx_links_type    ON links(link_type);
  `);
  console.log('Schema reset.');

  // ─── Step 1: group_membership ────────────────────────────────────────────
  // Each group thread's `participants` array exploded into rows. Resolve
  // canonical_id by matching display_name or aliases.
  console.log('\n[1/3] Populating group_membership...');
  // A participant name can match MULTIPLE identities (e.g. two "Leo Reeves"
  // identities, or one carrying the other's name as an alias). The PK is
  // (thread_id, participant_name), so resolve each (thread, name) to a SINGLE
  // canonical_id — the matching identity with the most messages — instead of
  // emitting one row per match (which collided on PK). Unmatched names keep NULL.
  await conn.run(`
    INSERT INTO group_membership (thread_id, participant_name, canonical_id)
    WITH msg_counts AS (
      SELECT ti.canonical_id, COUNT(*) AS n
      FROM thread_identity ti JOIN messages m ON m.thread_id = ti.thread_id
      GROUP BY ti.canonical_id
    ),
    exploded AS (
      SELECT t.thread_id AS thread_id, p.unnested AS participant_name, i.canonical_id AS canonical_id
      FROM threads t,
           UNNEST(t.participants) AS p(unnested)
      LEFT JOIN identities i
        ON i.display_name = p.unnested
           OR list_contains(i.aliases, p.unnested)
      WHERE t.is_group
    ),
    ranked AS (
      SELECT e.thread_id, e.participant_name, e.canonical_id,
             ROW_NUMBER() OVER (
               PARTITION BY e.thread_id, e.participant_name
               ORDER BY COALESCE(mc.n, 0) DESC, e.canonical_id
             ) AS rn
      FROM exploded e
      LEFT JOIN msg_counts mc ON mc.canonical_id = e.canonical_id
    )
    SELECT thread_id, participant_name, canonical_id
    FROM ranked WHERE rn = 1;
  `);
  const gmCountReader = await conn.runAndReadAll('SELECT COUNT(*), COUNT(canonical_id) FROM group_membership');
  const [gmTotal, gmResolved] = gmCountReader.getRows()[0];
  console.log(`  ${gmTotal} memberships (${gmResolved} resolved to a canonical identity, ${gmTotal - gmResolved} unresolved)`);

  // ─── Step 2: mentions (the expensive step) ───────────────────────────────
  // For each canonical identity with a "nameable form," scan all messages
  // in OTHER threads for that name. Whole-word match.
  console.log('\n[2/3] Populating mentions (this may take a minute)...');
  const idsReader = await conn.runAndReadAll('SELECT canonical_id, display_name, aliases FROM identities');
  const allIdentities = idsReader.getRows();
  console.log(`  ${allIdentities.length} identities to scan`);

  // Build (canonical_id, search_form) pairs to scan for
  const searches = [];
  for (const [canId, dispName, aliases] of allIdentities) {
    const forms = nameableForms(dispName, aliases || []);
    for (const f of forms) searches.push({ canId, form: f });
  }
  console.log(`  ${searches.length} search forms across ${new Set(searches.map(s => s.canId)).size} identities`);

  // Build a thread→canonical map so we don't count messages IN the person's own thread as mentions
  const tiReader = await conn.runAndReadAll('SELECT thread_id, canonical_id FROM thread_identity');
  const ownThreads = new Map(); // canonicalId -> Set<threadId>
  for (const [tid, cid] of tiReader.getRows()) {
    if (!ownThreads.has(cid)) ownThreads.set(cid, new Set());
    ownThreads.get(cid).add(tid);
  }

  // Scan in batches: a single SQL UNION ALL is too big, so loop.
  let totalInserted = 0;
  let processed = 0;
  for (const s of searches) {
    processed++;
    if (processed % 100 === 0) {
      process.stdout.write(`\r  scanned ${processed} / ${searches.length} forms — ${totalInserted} mentions found`);
    }
    const own = ownThreads.get(s.canId) || new Set();
    const ownList = own.size ? [...own].map(escSql).join(',') : null;
    // Whole-word match on body_lower; the LIKE pattern uses spaces/start/end as boundaries
    const formLow = s.form.toLowerCase();
    const sql = `
      INSERT INTO mentions (mentioned_canonical_id, mentioned_form, thread_id, message_id, ts, from_me)
      SELECT
        ${escSql(s.canId)},
        ${escSql(s.form)},
        m.thread_id,
        m.id,
        m.ts,
        m.from_me
      FROM messages m
      WHERE m.meaningful
        AND m.body_lower IS NOT NULL
        AND regexp_matches(m.body_lower, ${escSql('\\b' + formLow.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\b')})
        ${ownList ? `AND m.thread_id NOT IN (${ownList})` : ''}
    `;
    const before = totalInserted;
    try {
      await conn.run(sql);
      const r = await conn.runAndReadAll('SELECT COUNT(*) FROM mentions');
      totalInserted = Number(r.getRows()[0][0]);
    } catch (err) {
      // Skip forms with regex issues silently
    }
  }
  console.log(`\n  done — ${totalInserted} mentions across the corpus`);

  // ─── Step 3: links (derived) ─────────────────────────────────────────────
  console.log('\n[3/3] Populating links...');

  // 3a) shared_group: pairs of identities that co-occur in a group thread
  await conn.run(`
    INSERT INTO links (canonical_id, link_type, related_canonical_id, related_label, evidence, weight)
    SELECT
      a.canonical_id,
      'shared_group',
      b.canonical_id,
      i_b.display_name,
      'co-member of group thread: ' || a.thread_id,
      COUNT(DISTINCT a.thread_id)
    FROM group_membership a
    JOIN group_membership b
      ON a.thread_id = b.thread_id
     AND a.canonical_id != b.canonical_id
    JOIN identities i_b ON b.canonical_id = i_b.canonical_id
    WHERE a.canonical_id IS NOT NULL
      AND b.canonical_id IS NOT NULL
    GROUP BY a.canonical_id, b.canonical_id, i_b.display_name, a.thread_id
  `);

  // 3b) mentioned_in: each (subject, thread-they're-mentioned-in) pair, weight = mention count
  await conn.run(`
    INSERT INTO links (canonical_id, link_type, related_label, evidence, weight)
    SELECT
      mentioned_canonical_id,
      'mentioned_in_thread',
      thread_id,
      'mentioned ' || COUNT(*) || ' times in thread ' || thread_id,
      COUNT(*)
    FROM mentions
    GROUP BY mentioned_canonical_id, thread_id
  `);

  // 3c) co_mentioned: pairs of people frequently named in the same thread by the same speaker on the same day
  await conn.run(`
    WITH co_pairs AS (
      SELECT
        a.mentioned_canonical_id AS a_id,
        b.mentioned_canonical_id AS b_id,
        a.thread_id,
        DATE_TRUNC('day', make_timestamp(a.ts*1000)) AS day,
        COUNT(*) AS n
      FROM mentions a
      JOIN mentions b
        ON a.thread_id = b.thread_id
       AND a.from_me = b.from_me
       AND DATE_TRUNC('day', make_timestamp(a.ts*1000)) = DATE_TRUNC('day', make_timestamp(b.ts*1000))
       AND a.mentioned_canonical_id < b.mentioned_canonical_id
      GROUP BY a.mentioned_canonical_id, b.mentioned_canonical_id, a.thread_id, day
    )
    INSERT INTO links (canonical_id, link_type, related_canonical_id, related_label, evidence, weight)
    SELECT
      a_id,
      'co_mentioned',
      b_id,
      i_b.display_name,
      'co-mentioned on ' || strftime(day, '%Y-%m-%d') || ' in ' || thread_id,
      n
    FROM co_pairs
    JOIN identities i_b ON b_id = i_b.canonical_id
    WHERE n >= 1
  `);

  const linksReader = await conn.runAndReadAll('SELECT link_type, COUNT(*) FROM links GROUP BY link_type ORDER BY link_type');
  console.log('  links by type:');
  for (const row of linksReader.getRows()) {
    console.log(`    ${String(row[0]).padEnd(22)} ${row[1]}`);
  }

  // ─── Stats ───────────────────────────────────────────────────────────────
  console.log('\nDone. Quick stats:');
  for (const [label, sql] of [
    ['group_membership rows', 'SELECT COUNT(*) FROM group_membership'],
    ['mentions total',        'SELECT COUNT(*) FROM mentions'],
    ['mentions distinct subjects', 'SELECT COUNT(DISTINCT mentioned_canonical_id) FROM mentions'],
    ['links total',           'SELECT COUNT(*) FROM links'],
    ['identities w/ links',   'SELECT COUNT(DISTINCT canonical_id) FROM links'],
  ]) {
    const r = await conn.runAndReadAll(sql);
    console.log(`  ${label.padEnd(28)} ${r.getRows()[0][0]}`);
  }

  await conn.disconnectSync();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
