// Read tools over messages.duckdb. Every call opens its own READ_ONLY
// connection and closes it, so a long-lived MCP process never holds the file
// lock `npm run build-db` needs. All timestamps leaving this module are
// rendered sender-local via lib/local-time.js; all bodies pass the
// redactions filter before leaving the database.

import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { formatLocal } from '../lib/local-time.js';
import { isHandle } from '../lib/person-anchors.js';
import { isRedacted } from '../lib/redactions.js';
import { assertReadOnlySql } from './guard.js';

const MSG_COLS = 'id, ts, source, thread_id, from_me, sender_name, body, attachment_type';

function toArray(v) {
  return Array.isArray(v) ? v : (v?.items ?? []);
}

function dateToMs(s) {
  if (s == null) return null;
  if (typeof s === 'number') return s;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
  if (Number.isNaN(t)) throw new Error(`bad date: ${s}`);
  return t;
}

// ms timestamps must bind as BigInt — a JS number param truncates to 32 bits.
function msParam(v) {
  return BigInt(Math.trunc(Number(v)));
}

const SEARCH_BODY_PREVIEW = 500;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `query` appears in `body` as a whole word, ignoring text inside
 * URLs — "imax" must not hit "climax" or a newsletter's link slug.
 */
function matchesVisibleWord(body, query) {
  const visible = (body || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ');
  const re = new RegExp(`(?<![a-z0-9])${escapeRegex(query.toLowerCase())}(?![a-z0-9])`);
  return re.test(visible);
}

/** Drop any row whose string fields contain redacted content. */
function redactRows(rows) {
  return rows.filter((r) => !Object.values(r).some((v) => typeof v === 'string' && isRedacted(v)));
}

export function createCorpus({
  dbPath,
  portraitsDir,
  meId = 'id-753',
  mergesPath = path.join(path.dirname(dbPath), 'merges-proposed.json'),
}) {
  let mergeLinksCache = null;
  async function withConnection(fn) {
    let inst;
    try {
      inst = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
    } catch (e) {
      if (/lock/i.test(e.message)) {
        throw new Error('messages.duckdb is locked (pipeline build in progress?) — try again shortly');
      }
      throw e;
    }
    const con = await inst.connect();
    try {
      return await fn(con);
    } finally {
      con.closeSync();
      inst.closeSync();
    }
  }

  async function all(con, sql, params) {
    const reader = await con.runAndReadAll(sql, params);
    return reader.getRowObjectsJson();
  }

  function renderMessage(row, counterpartyId) {
    const ts = Number(row.ts);
    const senderId = row.from_me ? meId : counterpartyId;
    return {
      id: row.id,
      ts,
      local_time: formatLocal(senderId, ts).formatted,
      speaker: row.from_me ? 'ME' : 'THEM',
      sender_name: row.sender_name,
      source: row.source,
      thread_id: row.thread_id,
      body: row.body ?? (row.attachment_type ? `[${row.attachment_type}]` : ''),
    };
  }

  function portraitPathFor(displayName) {
    if (!portraitsDir || !displayName) return null;
    const p = path.join(portraitsDir, displayName.replace(/\s+/g, '_') + '.md');
    return fs.existsSync(p) ? p : null;
  }

  /**
   * same_as adjacency from merges-proposed.json (confident + manual pairs).
   * The file records ids from whenever the proposal ran, and canonical ids
   * renumber on every rebuild — so pairs are resolved by display_name against
   * the live identities table; names that don't resolve uniquely are dropped.
   */
  async function mergeLinks(con) {
    if (mergeLinksCache) return mergeLinksCache;
    let pairs = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(mergesPath, 'utf8'));
      pairs = [...(parsed.confident ?? []), ...(parsed.manual ?? [])];
    } catch {
      mergeLinksCache = new Map();
      return mergeLinksCache;
    }
    const names = [...new Set(pairs.flatMap((p) => [p.winner_name, p.loser_name]))].filter(Boolean);
    const links = new Map();
    if (names.length) {
      const params = {};
      names.forEach((n, i) => { params[`m${i}`] = n; });
      const rows = await all(con, `
        SELECT display_name, list(canonical_id) AS ids FROM identities
        WHERE display_name IN (${names.map((_, i) => `$m${i}`).join(', ')})
        GROUP BY display_name
      `, params);
      const idByName = new Map(
        rows.filter((r) => toArray(r.ids).length === 1).map((r) => [r.display_name, toArray(r.ids)[0]]));
      for (const p of pairs) {
        const a = idByName.get(p.winner_name);
        const b = idByName.get(p.loser_name);
        if (!a || !b || a === b) continue;
        if (!links.has(a)) links.set(a, new Set());
        if (!links.has(b)) links.set(b, new Set());
        links.get(a).add(b);
        links.get(b).add(a);
      }
    }
    mergeLinksCache = links;
    return links;
  }

  async function resolvePerson({ query }) {
    return withConnection(async (con) => {
      const rows = await all(con, `
        SELECT i.canonical_id, i.display_name, i.aliases, i.sources,
               (SELECT count(*) FROM messages m JOIN thread_identity ti ON m.thread_id = ti.thread_id
                 WHERE ti.canonical_id = i.canonical_id) AS message_count
        FROM identities i
        WHERE i.display_name ILIKE '%' || $q || '%'
           OR EXISTS (SELECT 1 FROM unnest(i.aliases) AS t(a) WHERE a ILIKE '%' || $q || '%')
        ORDER BY message_count DESC
        LIMIT 20
      `, { q: query });
      const links = await mergeLinks(con);
      return rows.map((r) => ({
        canonical_id: r.canonical_id,
        display_name: r.display_name,
        aliases: toArray(r.aliases),
        sources: toArray(r.sources),
        message_count: Number(r.message_count),
        same_as: [...(links.get(r.canonical_id) ?? [])],
        has_portrait: portraitPathFor(r.display_name) != null,
      }));
    });
  }

  async function searchMessages({ query, person_id, person_ids, source, after, before, limit = 50, match = 'word' }) {
    return withConnection(async (con) => {
      const ids = person_ids?.length ? person_ids : person_id ? [person_id] : null;
      // The LIKE scan is a fast prefilter; word-boundary and URL-blindness are
      // refined in JS afterwards, so word mode over-fetches before slicing.
      const fetchN = match === 'word' ? Math.min(limit * 5, 500) : limit;
      const where = [`m.body_lower LIKE '%' || lower($q) || '%'`];
      const params = { q: query, n: fetchN };
      if (ids) {
        where.push(`ti.canonical_id IN (${ids.map((_, i) => `$p${i}`).join(', ')})`);
        ids.forEach((v, i) => { params[`p${i}`] = v; });
      }
      if (source) { where.push('m.source = $source'); params.source = source; }
      const afterMs = dateToMs(after);
      const beforeMs = dateToMs(before);
      if (afterMs != null) { where.push('m.ts >= $after'); params.after = msParam(afterMs); }
      if (beforeMs != null) { where.push('m.ts < $before'); params.before = msParam(beforeMs); }
      const rows = await all(con, `
        SELECT ${MSG_COLS.split(', ').map((c) => 'm.' + c).join(', ')}, ti.canonical_id AS counterparty_id
        FROM messages m LEFT JOIN thread_identity ti USING (thread_id)
        WHERE ${where.join(' AND ')}
        ORDER BY m.ts DESC
        LIMIT $n
      `, params);
      const filtered = redactRows(rows)
        .filter((r) => match !== 'word' || matchesVisibleWord(r.body, query))
        .slice(0, limit);
      return filtered.map((r) => {
        const msg = renderMessage(r, r.counterparty_id);
        if (msg.body.length > SEARCH_BODY_PREVIEW) {
          return { ...msg, body: msg.body.slice(0, SEARCH_BODY_PREVIEW), body_truncated: true };
        }
        return msg;
      });
    });
  }

  async function getConversationWindow({ thread_id, around_ts, before = 20, after = 20 }) {
    return withConnection(async (con) => {
      const ti = await all(con,
        'SELECT canonical_id FROM thread_identity WHERE thread_id = $t', { t: thread_id });
      const counterpartyId = ti[0]?.canonical_id ?? null;
      const earlier = await all(con, `
        SELECT ${MSG_COLS} FROM messages WHERE thread_id = $t AND ts <= $ts
        ORDER BY ts DESC LIMIT $n
      `, { t: thread_id, ts: msParam(around_ts), n: before + 1 });
      const later = await all(con, `
        SELECT ${MSG_COLS} FROM messages WHERE thread_id = $t AND ts > $ts
        ORDER BY ts ASC LIMIT $n
      `, { t: thread_id, ts: msParam(around_ts), n: after });
      const rows = redactRows([...earlier.reverse(), ...later]);
      return {
        thread_id,
        counterparty_id: counterpartyId,
        messages: rows.map((r) => renderMessage({ ...r, thread_id }, counterpartyId)),
      };
    });
  }

  async function getIdentity(personId) {
    return withConnection(async (con) => {
      const rows = await all(con,
        'SELECT canonical_id, display_name, aliases, sources FROM identities WHERE canonical_id = $id',
        { id: personId });
      if (!rows.length) return null;
      return { ...rows[0], aliases: toArray(rows[0].aliases), sources: toArray(rows[0].sources) };
    });
  }

  async function personSummary({ person_id }) {
    return withConnection(async (con) => {
      const ident = await all(con,
        'SELECT canonical_id, display_name, aliases, sources FROM identities WHERE canonical_id = $id',
        { id: person_id });
      if (!ident.length) throw new Error(`unknown person: ${person_id}`);
      const identity = {
        ...ident[0],
        aliases: toArray(ident[0].aliases),
        sources: toArray(ident[0].sources),
      };
      const [agg] = await all(con, `
        SELECT count(*) AS c, min(m.ts) AS first_ts, max(m.ts) AS last_ts,
               list(DISTINCT m.source) AS sources, list(DISTINCT m.thread_id) AS threads
        FROM messages m JOIN thread_identity ti USING (thread_id)
        WHERE ti.canonical_id = $id
      `, { id: person_id });
      const stats = {
        message_count: Number(agg.c),
        sources: toArray(agg.sources),
        threads: toArray(agg.threads),
        first_ts: agg.first_ts == null ? null : Number(agg.first_ts),
        last_ts: agg.last_ts == null ? null : Number(agg.last_ts),
        first_local: agg.first_ts == null ? null : formatLocal(person_id, Number(agg.first_ts)).formatted,
        last_local: agg.last_ts == null ? null : formatLocal(person_id, Number(agg.last_ts)).formatted,
      };
      const portraitPath = portraitPathFor(identity.display_name);
      const portrait = portraitPath ? fs.readFileSync(portraitPath, 'utf8') : null;
      const links = await mergeLinks(con);
      return { identity, stats, portrait, same_as: [...(links.get(person_id) ?? [])] };
    });
  }

  async function runQuery({ sql, limit = 200 }) {
    assertReadOnlySql(sql);
    return withConnection(async (con) => {
      const rows = redactRows(await all(con, sql));
      return { rows: rows.slice(0, limit), truncated: rows.length > limit };
    });
  }

  /**
   * The corpus's July-27ths: every prior year's messages on a given
   * month-day, bucketed by year in Demo's local time (the rememberer's
   * frame), grouped by who the day was spent with.
   */
  async function onThisDay({ date, person_id, limit_per_year = 8 } = {}) {
    return withConnection(async (con) => {
      const now = new Date();
      const monthDay = date
        ? (date.length === 5 ? date : date.slice(5))
        : formatLocal(meId, now.getTime()).formatted.slice(5, 10);
      // ±1 day UTC band, refined to the local month-day in JS — a Melbourne
      // evening and a Chicago morning land on different UTC dates.
      const [m, d] = monthDay.split('-').map(Number);
      const band = [-1, 0, 1].map((off) => {
        const dt = new Date(Date.UTC(2020, m - 1, d + off)); // leap-safe scaffold year
        return `${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
      });
      const params = { a: band[0], b: band[1], c: band[2] };
      let personFilter = '';
      if (person_id) { personFilter = 'AND ti.canonical_id = $p'; params.p = person_id; }
      const rows = await all(con, `
        SELECT m.ts, m.from_me, m.sender_name, m.body, m.thread_id, ti.canonical_id AS cp,
               i.display_name AS cp_name
        FROM messages m
        LEFT JOIN thread_identity ti USING (thread_id)
        LEFT JOIN identities i ON i.canonical_id = ti.canonical_id
        WHERE m.meaningful AND strftime(to_timestamp(m.ts/1000), '%m-%d') IN ($a, $b, $c)
        ${personFilter}
      `, params);
      // Corpus-wide two-way check: a thread Demo has never sent into is a
      // broadcast (banks, shortcodes, lockers) even when it maps to an
      // identity — build-db maps every DM thread, service or not.
      const dayThreads = [...new Set(rows.map((r) => r.thread_id))];
      const twoWay = new Set();
      if (dayThreads.length) {
        const tParams = {};
        dayThreads.forEach((t, i) => { tParams[`t${i}`] = t; });
        const replied = await all(con, `
          SELECT DISTINCT thread_id FROM messages
          WHERE from_me AND thread_id IN (${dayThreads.map((_, i) => `$t${i}`).join(', ')})
        `, tParams);
        for (const r of replied) twoWay.add(r.thread_id);
      }
      const currentYear = Number(formatLocal(meId, now.getTime()).formatted.slice(0, 4));
      const byYear = new Map();
      for (const r of redactRows(rows)) {
        const local = formatLocal(meId, Number(r.ts)).formatted;
        if (local.slice(5, 10) !== monthDay) continue;
        const year = Number(local.slice(0, 4));
        if (year === currentYear) continue;
        if (!byYear.has(year)) byYear.set(year, []);
        byYear.get(year).push({ ...r, local });
      }
      const years = [...byYear.keys()].sort().map((year) => {
        const msgs = byYear.get(year).sort((a, b) => Number(a.ts) - Number(b.ts));
        const buckets = new Map();
        for (const msg of msgs) {
          const key = msg.cp ?? msg.thread_id;
          if (!buckets.has(key)) {
            buckets.set(key, { name: msg.cp_name ?? msg.thread_id, person_id: msg.cp ?? null, count: 0 });
          }
          buckets.get(key).count++;
        }
        const top_people = [...buckets.values()].sort((a, b) => b.count - a.count).slice(0, 5);
        // Samples prefer real conversations: two-way threads with NAMED
        // people first (a replied-to package locker is still nameless),
        // then two-way, then mapped, then whatever the year has.
        // top_people stays the honest census of the whole day.
        const tiers = [
          msgs.filter((msg) => msg.cp && twoWay.has(msg.thread_id) && !isHandle(msg.cp_name)),
          msgs.filter((msg) => msg.cp && twoWay.has(msg.thread_id)),
          msgs.filter((msg) => msg.cp),
          msgs,
        ];
        const pool = tiers.find((t) => t.length) ?? msgs;
        const step = Math.max(1, Math.floor(pool.length / limit_per_year));
        const samples = pool.filter((_, idx) => idx % step === 0).slice(0, limit_per_year)
          .map((msg) => ({
            local_time: msg.local,
            speaker: msg.from_me ? 'ME' : 'THEM',
            sender_name: msg.sender_name,
            thread_id: msg.thread_id,
            ts: Number(msg.ts),
            body: (msg.body ?? '').slice(0, 300),
          }));
        return { year, message_count: msgs.length, top_people, samples };
      });
      return { date: monthDay, years };
    });
  }

  async function getSchema() {
    return withConnection(async (con) => {
      const rows = await all(con, `
        SELECT table_name, list(column_name || ':' || lower(data_type) ORDER BY ordinal_position) AS cols
        FROM information_schema.columns
        GROUP BY table_name ORDER BY table_name
      `);
      return rows.map((r) => ({ table: r.table_name, columns: toArray(r.cols) }));
    });
  }

  return { resolvePerson, searchMessages, getConversationWindow, getIdentity, personSummary, onThisDay, runQuery, getSchema };
}
