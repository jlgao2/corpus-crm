const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const RATE_LIMIT_MS = 1100;  // 1 req/sec + 10% headroom

function roundCoord(c) {
  return Math.round(c * 1000) / 1000;
}

/**
 * Reverse-geocode a list of (lat, lng) tuples, using the DuckDB cache to skip
 * coords already resolved. Inserts new resolutions into the cache.
 *
 * @param {Array<{lat, lng}>} coords
 * @param {DuckDBConnection} conn
 * @returns {Promise<Map<string, {place_name, city, region, country}>>}
 *          keyed by "lat_round,lng_round"
 */
export async function reverseGeocodeAll(coords, conn) {
  // Collect unique rounded coords
  const unique = new Map();
  for (const { lat, lng } of coords) {
    if (lat == null || lng == null) continue;
    const key = `${roundCoord(lat)},${roundCoord(lng)}`;
    if (!unique.has(key)) unique.set(key, { lat: roundCoord(lat), lng: roundCoord(lng) });
  }

  // Pull existing cache hits
  const cached = new Map();
  const cacheReader = await conn.runAndReadAll(`SELECT lat_round, lng_round, place_name, city, region, country FROM reverse_geocode_cache`);
  for (const row of cacheReader.getRows()) {
    const [lat, lng, place_name, city, region, country] = row;
    cached.set(`${lat},${lng}`, { place_name, city, region, country });
  }

  // Compute the misses
  const misses = [...unique.entries()].filter(([k, _]) => !cached.has(k));
  console.log(`  ${cached.size} cached, ${misses.length} to fetch`);

  // Fetch misses sequentially with rate limiting
  for (const [key, { lat, lng }] of misses) {
    const url = `${NOMINATIM}?format=json&lat=${lat}&lon=${lng}&zoom=14`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'social-graph-pipeline/1.0' },
      });
      if (!res.ok) {
        console.error(`  geocode failed for ${key}: ${res.status}`);
        continue;
      }
      const j = await res.json();
      const addr = j.address || {};
      const result = {
        place_name: j.display_name || null,
        city: addr.city || addr.town || addr.village || addr.suburb || null,
        region: addr.state || addr.county || null,
        country: addr.country || null,
      };
      cached.set(key, result);
      // Insert into cache
      await conn.run(`
        INSERT INTO reverse_geocode_cache (lat_round, lng_round, place_name, city, region, country)
        VALUES (${lat}, ${lng}, ${esc(result.place_name)}, ${esc(result.city)}, ${esc(result.region)}, ${esc(result.country)})
      `);
    } catch (err) {
      console.error(`  geocode error for ${key}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  return cached;
}

function esc(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * Forward-geocode a free-text place query (venue name, address). Returns
 * { lat, lng, display_name } or null. `viewbox` ("x1,y1,x2,y2" lon/lat) is a
 * soft bias, not a restriction (bounded=0). Caller owns rate limiting between
 * calls (use RATE_LIMIT_MS) and caching.
 */
export async function geocodePlace(query, { viewbox } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  const params = new URLSearchParams({ format: 'json', q, limit: '1' });
  if (viewbox) { params.set('viewbox', viewbox); params.set('bounded', '0'); }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': 'social-graph-pipeline/1.0' },
  });
  if (!res.ok) return null;
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) return null;
  const h = hits[0];
  const lat = parseFloat(h.lat), lng = parseFloat(h.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, display_name: h.display_name || null };
}

export { RATE_LIMIT_MS };
