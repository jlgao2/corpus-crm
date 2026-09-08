/**
 * Life-in-weeks (/weeks) — data half. One cell per Monday-started week, each
 * carrying that week's event count and dominant companion (most shared
 * events, Demo excluded). Cheap enough to compute per request from the
 * ~2.7k events. UTC week boundaries — same tolerance note as the almanac.
 */

const DAY = 86400000, WEEK = 7 * DAY;
const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

/** Monday-started week bucket: {year, week} where week counts Mondays since Jan 1's week start. */
export function weekIndex(ts) {
  const d = new Date(ts);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
  const year = new Date(monday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const jan1Monday = jan1 - ((new Date(jan1).getUTCDay() + 6) % 7) * DAY;
  return { year, week: Math.floor((monday - jan1Monday) / WEEK) };
}

export async function computeWeeks(conn) {
  const q = async (sql) => (await conn.runAndReadAll(sql)).getRows();
  const georgeIds = new Set(
    (await q(`SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user'`)).map(r => r[0]));
  const names = new Map(
    (await q(`SELECT canonical_id, display_name FROM identities`)).map(r => [r[0], r[1]]));

  const rows = (await q(`SELECT start_ts, participants FROM events ORDER BY start_ts`))
    .map(r => ({ ts: Number(r[0]), parts: unw(r[1]).filter(id => !georgeIds.has(id)) }));
  if (!rows.length) return { years: [], cells: [] };

  const firstYears = {}; // cid -> first-ever event year (drives the era hue, matching /threads)
  const byWeek = new Map(); // 'year|week' -> {year, week, events, companions: Map}
  for (const r of rows) {
    const y = weekIndex(r.ts).year;
    for (const id of r.parts) if (!(id in firstYears)) firstYears[id] = y;
    const { year, week } = weekIndex(r.ts);
    const key = `${year}|${week}`;
    let cell = byWeek.get(key);
    if (!cell) { cell = { year, week, events: 0, companions: new Map() }; byWeek.set(key, cell); }
    cell.events++;
    for (const id of r.parts) cell.companions.set(id, (cell.companions.get(id) || 0) + 1);
  }

  const y0 = weekIndex(rows[0].ts).year, y1 = weekIndex(rows[rows.length - 1].ts).year;
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);

  const cells = [];
  for (const cell of [...byWeek.values()].sort((a, b) => a.year - b.year || a.week - b.week)) {
    const top = [...cell.companions.entries()].sort((a, b) => b[1] - a[1])[0] || null;
    cells.push({
      year: cell.year, week: cell.week, events: cell.events,
      top: top ? { canonical_id: top[0], name: names.get(top[0]) || top[0], events: top[1] } : null,
    });
  }
  return { years, cells, firstYears };
}
