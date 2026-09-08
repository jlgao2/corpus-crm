/**
 * The field (/field) — layout half of the soot-style mosh.
 *
 * Every event is a particle. Depth = year (the client maps it to
 * scale/blur/z). Within a stratum: bearing = dominant companion (a friend's
 * events share an angle, so their thread aligns through depth — soot's
 * orbital paths, earned deterministically), radius = distance from the
 * nearest home city (home gathers the center, trips fling to the rim).
 * No physics, no randomness — every position replays from the data.
 */

const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

const HOMES = [[-37.81, 144.96], [-33.87, 151.21], [41.88, -87.63]]; // MEL, SYD, CHI

function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0);
}

export async function computeField(conn) {
  const q = async (sql) => (await conn.runAndReadAll(sql)).getRows();
  const georgeIds = new Set(
    (await q(`SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user'`)).map(r => r[0]));
  const names = new Map(
    (await q(`SELECT canonical_id, display_name FROM identities`)).map(r => [r[0], r[1]]));

  // Dominant companion per event = most face-appearances (photo events).
  const domFace = new Map();
  for (const [eid, cid, n] of await q(`
    SELECT ep.event_id, pf.canonical_id, COUNT(*) AS n
    FROM event_photos ep JOIN photo_faces pf ON pf.photo_id = ep.photo_id
    GROUP BY 1, 2 ORDER BY n DESC, pf.canonical_id
  `)) {
    if (georgeIds.has(cid)) continue;
    if (!domFace.has(eid)) domFace.set(eid, cid);
  }

  const rows = await q(`
    SELECT e.event_id, e.start_ts, e.place_name, e.summary, e.participants,
           e.n_photos, e.n_messages, COALESCE(e.source, 'photos') AS source, e.lat, e.lng,
           (SELECT p.asset_path FROM event_photos ep JOIN photos p ON p.id = ep.photo_id
            WHERE ep.event_id = e.event_id ORDER BY p.ts LIMIT 1) AS thumb
    FROM events e ORDER BY e.start_ts
  `);
  if (!rows.length) return { years: [], items: [] };

  const yearOf = (ts) => new Date(Number(ts)).getUTCFullYear();
  const y0 = yearOf(rows[0][1]), y1 = yearOf(rows[rows.length - 1][1]);
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);

  const items = rows.map(r => {
    const [event_id, start_ts, place_name, summary, participants, n_photos, n_messages, source, lat, lng, thumb] = r;
    const others = unw(participants).filter(id => !georgeIds.has(id));
    const person = domFace.get(event_id) || others[0] || null;

    const baseAngle = person
      ? (hash(person) % 3600) / 3600 * 2 * Math.PI
      : (hash(event_id) % 3600) / 3600 * 2 * Math.PI;
    const jA = ((hash(event_id + 'a') % 1000) / 1000 - 0.5) * 0.45;
    const angle = baseAngle + jA;

    let r01;
    if (lat == null || lng == null) {
      r01 = 0.45 + ((hash(event_id + 'r') % 1000) / 1000 - 0.5) * 0.18;
    } else {
      const km = Math.min(...HOMES.map(([hl, hg]) => haversineKm(Number(lat), Number(lng), hl, hg)));
      r01 = Math.min(1, 0.18 + Math.log1p(km) / 9.5);
    }
    r01 = Math.max(0.06, Math.min(1, r01 + ((hash(event_id + 'j') % 1000) / 1000 - 0.5) * 0.1));

    return {
      event_id,
      yi: yearOf(start_ts) - y0,
      ts: Number(start_ts),
      title: summary || place_name || event_id,
      person,
      personName: person ? (names.get(person) || person) : null,
      n_photos: Number(n_photos ?? 0),
      n_messages: Number(n_messages ?? 0),
      inferred: source === 'messages',
      thumb: thumb || null,
      r: Number(r01.toFixed(4)),
      x: Number((r01 * Math.cos(angle)).toFixed(4)),
      y: Number((r01 * Math.sin(angle)).toFixed(4)),
    };
  });

  return { years, items };
}
