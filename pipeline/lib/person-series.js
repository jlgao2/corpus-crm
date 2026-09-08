/**
 * Per-person relationship series — the /person header sparkline's data.
 *
 * Years from the person's first event through the corpus's latest event
 * year: events together + meaningful messages per year, plus the gap story
 * (longest event-less stretch and the resurfacing year after it) — the
 * Culturegraphy long-arc, reduced to its sentence.
 */

export async function personSeries(conn, canonicalId) {
  const q = async (sql) => (await conn.runAndReadAll(sql)).getRows();
  const sq = "'" + String(canonicalId).replace(/'/g, "''") + "'";

  const evYears = (await q(`
    SELECT CAST(EXTRACT(year FROM to_timestamp(start_ts/1000)) AS INT) AS y, COUNT(*) AS n
    FROM events WHERE list_contains(participants, ${sq}) GROUP BY 1
  `)).map(r => [Number(r[0]), Number(r[1])]);
  if (!evYears.length) return null;

  const lastCorpusYear = Number((await q(`
    SELECT CAST(EXTRACT(year FROM to_timestamp(MAX(start_ts)/1000)) AS INT) FROM events
  `))[0][0]);
  const msgYears = new Map((await q(`
    SELECT CAST(EXTRACT(year FROM to_timestamp(m.ts/1000)) AS INT) AS y, COUNT(*) AS n
    FROM messages m JOIN thread_identity ti ON ti.thread_id = m.thread_id
    WHERE m.meaningful AND ti.canonical_id = ${sq} GROUP BY 1
  `)).map(r => [Number(r[0]), Number(r[1])]));

  const evMap = new Map(evYears);
  const firstYear = Math.min(...evYears.map(([y]) => y));
  const series = [];
  for (let y = firstYear; y <= lastCorpusYear; y++) {
    series.push({ year: y, events: evMap.get(y) || 0, messages: msgYears.get(y) || 0 });
  }

  // Longest run of event-less years strictly inside the known span.
  let gap = null, run = null;
  for (const r of series) {
    if (r.events === 0) {
      if (!run) run = { from: r.year, to: r.year };
      else run.to = r.year;
      if (!gap || run.to - run.from > gap.to - gap.from) gap = { ...run };
    } else run = null;
  }
  // A trailing (still-open) gap has no resurfacing year.
  let resurfacedYear = null;
  if (gap) {
    const after = series.find(r => r.year > gap.to && r.events > 0);
    if (after) resurfacedYear = after.year;
  }

  return { firstYear, lastYear: lastCorpusYear, series, gap, resurfacedYear };
}
