/**
 * The braid (/threads) — data half.
 *
 * People as threads across years, distance from Demo = tie strength
 * (SpreadLine's rule). This module computes the per-person per-year series;
 * the serve.js route does layout + SVG. Only people with at least one
 * physical event/meetup ever get a thread — the braid answers "who was I
 * with," not "who did I text."
 *
 * strength(year) = messages + 5·photo-events + 3·inferred-meetups. Log-damped
 * at render time, not here.
 */

const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

export async function computeBraid(conn, { topN = 40 } = {}) {
  const q = async (sql) => (await conn.runAndReadAll(sql)).getRows();

  const georgeIds = new Set(
    (await q(`SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user'`)).map(r => r[0]));
  const names = new Map(
    (await q(`SELECT canonical_id, display_name FROM identities`)).map(r => [r[0], r[1]]));

  // Physical presence per person-year, split by source.
  const evRows = (await q(`
    SELECT y, cid, src, COUNT(*) AS n FROM (
      SELECT CAST(EXTRACT(year FROM to_timestamp(start_ts/1000)) AS INT) AS y,
             COALESCE(source, 'photos') AS src, unnest(participants) AS cid
      FROM events
    ) GROUP BY 1, 2, 3
  `)).map(r => ({ y: Number(r[0]), cid: r[1], src: r[2], n: Number(r[3]) }))
    .filter(r => !georgeIds.has(r.cid));

  // Message volume per person-year (DMs via thread_identity).
  const msgRows = (await q(`
    SELECT CAST(EXTRACT(year FROM to_timestamp(m.ts/1000)) AS INT) AS y, ti.canonical_id AS cid, COUNT(*) AS n
    FROM messages m JOIN thread_identity ti ON ti.thread_id = m.thread_id
    WHERE m.meaningful GROUP BY 1, 2
  `)).map(r => ({ y: Number(r[0]), cid: r[1], n: Number(r[2]) }))
    .filter(r => !georgeIds.has(r.cid));

  const met = new Set(evRows.map(r => r.cid));
  if (!met.size) return { years: [], people: [] };

  const y0 = Math.min(...evRows.map(r => r.y));
  const y1 = Math.max(...evRows.map(r => r.y));
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);

  const acc = new Map(); // cid -> year -> {events, inferred, messages}
  const bump = (cid, y, key, n) => {
    if (!met.has(cid) || y < y0 || y > y1) return;
    let per = acc.get(cid);
    if (!per) { per = new Map(); acc.set(cid, per); }
    let cell = per.get(y);
    if (!cell) { cell = { events: 0, inferred: 0, messages: 0 }; per.set(y, cell); }
    cell[key] += n;
  };
  for (const r of evRows) bump(r.cid, r.y, r.src === 'messages' ? 'inferred' : 'events', r.n);
  for (const r of msgRows) bump(r.cid, r.y, 'messages', r.n);

  const people = [...acc.entries()].map(([cid, per]) => {
    let total = 0, firstYear = null;
    const series = years.map(y => {
      const c = per.get(y) || { events: 0, inferred: 0, messages: 0 };
      const strength = c.messages + 5 * c.events + 3 * c.inferred;
      total += strength;
      if (firstYear === null && strength > 0) firstYear = y;
      return { year: y, strength, events: c.events + c.inferred, messages: c.messages };
    });
    return { canonical_id: cid, name: names.get(cid) || cid, firstYear, total, series };
  })
    .sort((a, b) => b.total - a.total)
    .slice(0, topN);

  return { years, people };
}
