const HOUR_MS = 3600 * 1000;

/**
 * Haversine distance in km between two {lat, lng} points.
 */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function clusterCenter(photos) {
  const withGps = photos.filter(p => p.lat != null && p.lng != null);
  if (withGps.length === 0) return null;
  const lat = withGps.reduce((s, p) => s + p.lat, 0) / withGps.length;
  const lng = withGps.reduce((s, p) => s + p.lng, 0) / withGps.length;
  return { lat, lng };
}

/**
 * Greedy time-location clustering.
 *
 * @param {Array} photos     - { id, ts, lat?, lng? } sorted by ts asc
 * @param {Object} opts
 * @param {number} opts.timeGapHours  default 6
 * @param {number} opts.locationKm    default 1.0
 * @param {number} opts.minPhotos     default 3
 * @returns {Array<{event_id, start_ts, end_ts, photos}>}
 */
export function clusterEvents(photos, opts = {}) {
  const { timeGapHours = 6, locationKm = 1.0, minPhotos = 3 } = opts;
  const gapMs = timeGapHours * HOUR_MS;
  const sorted = [...photos].sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return [];

  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const last = current[current.length - 1];
    const timeGap = p.ts - last.ts;

    let split = false;
    if (timeGap > gapMs) {
      split = true;
    } else if (p.lat != null && p.lng != null) {
      const center = clusterCenter(current);
      if (center && haversineKm(p, center) > locationKm && timeGap > HOUR_MS) {
        split = true;
      }
    }

    if (split) {
      clusters.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }
  clusters.push(current);

  // Filter under minPhotos and assemble result
  return clusters
    .filter(c => c.length >= minPhotos)
    .map(c => ({
      event_id: `evt_${new Date(c[0].ts).toISOString().slice(0, 10)}_${shortHash(c.map(p => p.id).join(''))}`,
      start_ts: c[0].ts,
      end_ts: c[c.length - 1].ts,
      photos: c,
    }));
}

function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}
