/**
 * Year atlas (/atlas) — data half of the small-multiple year maps.
 *
 * No basemap: the city as lived (Parecki) — event dots ARE the map. Each
 * year gets the frame (Melbourne / Sydney / Chicago) holding most of its
 * geotagged events; out-of-frame events are tallied by place ("beyond:
 * Tokyo ×3") instead of silently dropped, and the all-time point cloud per
 * frame is the grey substrate under every year (layout stability).
 */

// [latMin, latMax, lngMin, lngMax] — city-scale, hand-sized to the corpus.
export const FRAMES = {
  MEL: [-38.25, -37.45, 144.35, 145.45],
  SYD: [-34.25, -33.55, 150.75, 151.55],
  CHI: [41.55, 42.25, -88.05, -87.35],
};

function frameOf(lat, lng) {
  for (const [key, [a, b, c, d]] of Object.entries(FRAMES)) {
    if (lat >= a && lat <= b && lng >= c && lng <= d) return key;
  }
  return null;
}

export async function yearAtlas(conn) {
  const rows = (await conn.runAndReadAll(`
    SELECT CAST(EXTRACT(year FROM to_timestamp(start_ts/1000)) AS INT) AS y,
           lat, lng, place_name, summary, n_photos, event_id, source
    FROM events ORDER BY start_ts
  `)).getRows().map(r => ({
    year: Number(r[0]), lat: r[1], lng: r[2], place: r[3], summary: r[4],
    n_photos: Number(r[5] ?? 0), event_id: r[6], source: r[7],
  }));
  if (!rows.length) return { years: [], substrate: {} };

  const substrate = Object.fromEntries(Object.keys(FRAMES).map(k => [k, []]));
  const byYear = new Map();
  for (const r of rows) {
    let y = byYear.get(r.year);
    if (!y) { y = { year: r.year, located: [], noCoords: 0 }; byYear.set(r.year, y); }
    if (r.lat == null || r.lng == null) { y.noCoords++; continue; }
    const f = frameOf(r.lat, r.lng);
    r.frame = f;
    y.located.push(r);
    if (f) substrate[f].push({ lat: r.lat, lng: r.lng });
  }

  const years = [...byYear.values()].sort((a, b) => a.year - b.year).map(y => {
    const counts = {};
    for (const r of y.located) if (r.frame) counts[r.frame] = (counts[r.frame] || 0) + 1;
    const frame = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'MEL';
    const points = y.located.filter(r => r.frame === frame);
    const beyondMap = new Map();
    for (const r of y.located.filter(r => r.frame !== frame)) {
      const key = r.place || 'somewhere';
      beyondMap.set(key, (beyondMap.get(key) || 0) + 1);
    }
    const beyond = [...beyondMap.entries()].sort((a, b) => b[1] - a[1])
      .map(([place, n]) => ({ place, n }));
    return { year: y.year, frame, points, beyond, nNoCoords: y.noCoords };
  });

  return { years, substrate };
}
