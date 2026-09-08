/**
 * Yearly almanac compiler — the Feltron-style /year/<y> pages.
 *
 * Everything derives from events (both sources), messages, photos. Year
 * boundaries use UTC on the stored timestamps: events near midnight on
 * New Year's can land one year off in the worst case — acceptable at
 * almanac granularity (revisit if a New Year's party ever lands wrong).
 * People lists always exclude Demo himself.
 */

const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

function yearBounds(year) {
  return [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)];
}

export async function compileYear(conn, year) {
  const [t0, t1] = yearBounds(year);
  const q = async (sql) => (await conn.runAndReadAll(sql)).getRows();
  const one = async (sql) => Number((await q(sql))[0][0]);

  const georgeIds = new Set(
    (await q(`SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user'`)).map(r => r[0]));
  const names = new Map(
    (await q(`SELECT canonical_id, display_name FROM identities`)).map(r => [r[0], r[1]]));

  // Presence per person per year, from event participants (both sources).
  const presence = (await q(`
    SELECT y, cid, COUNT(*) AS n FROM (
      SELECT CAST(EXTRACT(year FROM to_timestamp(start_ts/1000)) AS INT) AS y, unnest(participants) AS cid
      FROM events
    ) GROUP BY 1, 2
  `)).map(r => ({ y: Number(r[0]), cid: r[1], n: Number(r[2]) }))
    .filter(p => !georgeIds.has(p.cid));

  const thisYear = presence.filter(p => p.y === year);
  const mostSeen = thisYear
    .sort((a, b) => b.n - a.n)
    .map(p => ({ canonical_id: p.cid, name: names.get(p.cid) || p.cid, events: p.n }));

  const firstYear = new Map();
  for (const p of presence) {
    if (!firstYear.has(p.cid) || p.y < firstYear.get(p.cid)) firstYear.set(p.cid, p.y);
  }
  const newFaces = mostSeen.filter(p => firstYear.get(p.canonical_id) === year);
  const seenThis = new Set(thisYear.map(p => p.cid));
  const lapsed = [...new Set(presence.filter(p => p.y === year - 1 && !seenThis.has(p.cid)).map(p => p.cid))]
    .map(cid => ({ canonical_id: cid, name: names.get(cid) || cid }));

  const counts = {
    events: await one(`SELECT COUNT(*) FROM events WHERE start_ts >= ${t0} AND start_ts < ${t1}`),
    inferred: await one(`SELECT COUNT(*) FROM events WHERE start_ts >= ${t0} AND start_ts < ${t1} AND source = 'messages'`),
    messages: await one(`SELECT COUNT(*) FROM messages WHERE meaningful AND ts >= ${t0} AND ts < ${t1}`),
    photos: await one(`SELECT COUNT(*) FROM photos WHERE ts >= ${t0} AND ts < ${t1}`),
    people: seenThis.size,
  };

  const topPlaces = (await q(`
    SELECT place_name, COUNT(*) AS n FROM events
    WHERE start_ts >= ${t0} AND start_ts < ${t1} AND place_name IS NOT NULL
    GROUP BY 1 ORDER BY n DESC, place_name LIMIT 8
  `)).map(r => ({ place: r[0], events: Number(r[1]) }));

  // Concentration of meaningful DM messages across people (Felton's number).
  const perPerson = (await q(`
    SELECT ti.canonical_id, COUNT(*) AS n
    FROM messages m JOIN thread_identity ti ON ti.thread_id = m.thread_id
    WHERE m.meaningful AND m.ts >= ${t0} AND m.ts < ${t1}
    GROUP BY 1 ORDER BY n DESC
  `)).map(r => ({ cid: r[0], n: Number(r[1]) })).filter(p => !georgeIds.has(p.cid));
  const totalMsgs = perPerson.reduce((s, p) => s + p.n, 0);
  const concentration = {
    totalPeople: perPerson.length,
    top1Share: totalMsgs ? perPerson[0].n / totalMsgs : 0,
    top5Share: totalMsgs ? perPerson.slice(0, 5).reduce((s, p) => s + p.n, 0) / totalMsgs : 0,
  };

  const months = new Array(12).fill(0);
  for (const [m, n] of await q(`
    SELECT CAST(EXTRACT(month FROM to_timestamp(start_ts/1000)) AS INT), COUNT(*)
    FROM events WHERE start_ts >= ${t0} AND start_ts < ${t1} GROUP BY 1
  `)) months[Number(m) - 1] = Number(n);

  const big = await q(`
    SELECT event_id, summary, place_name, n_photos, start_ts, participants FROM events
    WHERE start_ts >= ${t0} AND start_ts < ${t1} ORDER BY n_photos DESC LIMIT 1
  `);
  const biggestEvent = big.length ? {
    event_id: big[0][0],
    title: big[0][1] || big[0][2] || big[0][0],
    n_photos: Number(big[0][3]),
    start_ts: Number(big[0][4]),
    participants: unw(big[0][5]).filter(id => !georgeIds.has(id)).map(id => names.get(id) || id),
  } : null;

  return { year, counts, mostSeen, newFaces, lapsed, topPlaces, concentration, months, biggestEvent };
}

/** Years that have any event — drives the /year index + prev/next links. */
export async function eventYears(conn) {
  return (await conn.runAndReadAll(`
    SELECT DISTINCT CAST(EXTRACT(year FROM to_timestamp(start_ts/1000)) AS INT) AS y
    FROM events ORDER BY y
  `)).getRows().map(r => Number(r[0]));
}
