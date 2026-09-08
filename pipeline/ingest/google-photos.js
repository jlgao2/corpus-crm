import fs from 'fs';
import path from 'path';

/**
 * Google Photos Takeout ingest. Keys off the per-media JSON sidecars
 * (`<media>.supplemental-metadata*.json`) — the only source of timestamp + GPS.
 * Returns the pipeline's standard { photo, faces, place } records (same inline
 * shape as loadIMessageAttachments/loadInstagramAttachments in
 * message-attachments.js) so build-photos dedups, geocodes, and event-clusters
 * them alongside Apple/iMessage/Instagram.
 *
 * faces is always [] (no face data in Takeout — that's Phase 4b). place is set
 * only when geoData has real (non-zero) coordinates.
 */

// Strip the sidecar suffix → the media BASENAME. "IMG.HEIC.supplemental-metadata.json"
// or "IMG.HEIC.supplemental-metadata(3).json" → "IMG.HEIC".
export function mediaPathFromSidecar(sidecarPath) {
  const base = path.basename(sidecarPath);
  return base.replace(/\.supplemental-metadata(\(\d+\))?\.json$/i, '');
}

export function parseSidecar(jsonText, { sidecarPath, mediaIndex }) {
  let d;
  try { d = JSON.parse(jsonText); } catch { return null; }
  const tsSec = d && d.photoTakenTime && d.photoTakenTime.timestamp;
  if (!tsSec) return null;
  const mediaName = mediaPathFromSidecar(sidecarPath);
  // Resolve to the real file across ALL roots (it often lives in another Takeout-N
  // dir). Fall back to the sidecar-adjacent path if not indexed (metadata-only row).
  const resolved = (mediaIndex && mediaIndex.get(mediaName.toLowerCase()))
    || path.join(path.dirname(sidecarPath), mediaName);
  const ts = Number(tsSec) * 1000;
  // Key id on basename + photoTakenTime, NOT basename alone: camera counters like
  // IMG_0001.HEIC repeat across phones/years, so basename-only silently merged ~6,400
  // DIFFERENT photos on the real archive (verified). basename@ts keeps distinct shots
  // distinct while still collapsing true same-photo cross-export duplicates (same
  // basename AND same timestamp). asset_path still resolves by basename (best-effort).
  const photo = {
    id: 'gphotos:' + mediaName + '@' + tsSec,
    apple_uuid: null,
    ts,
    ts_iso: new Date(ts).toISOString(),
    source: 'gphotos',
    source_ref: d.url || null,
    message_id: null,
    asset_path: resolved,
    width: null,
    height: null,
    hash_sha256: null,
    has_named_face: false,
  };
  let place = null;
  const lat = d.geoData ? Number(d.geoData.latitude) : NaN;
  const lng = d.geoData ? Number(d.geoData.longitude) : NaN;
  // Google Photos uses 0,0 to mean "no GPS". Guard on BOTH being zero (not
  // either) so real equator/prime-meridian coords (one axis exactly 0) survive.
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    place = { lat, lng };
  }
  return { photo, faces: [], place };
}

const SIDECAR_RE = /\.supplemental-metadata(\(\d+\))?\.json$/i;

function walk(dir, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, onFile);
    else onFile(full, e.name);
  }
}

// Global index of real media files across ALL roots: lowercase basename → first path.
// (A photo's media often lives in a different Takeout-N export than its sidecar, and
// the same photo can appear in several exports — first-seen wins, which dedups copies.)
// Returns { index, collisions } where collisions counts distinct-path basename
// clashes (same filename, different file) — a real risk since camera counters
// like IMG_0001.HEIC repeat across phones. Task 6's real run surfaces the count
// so we know whether basename-keyed dedup is safe on this archive.
export function buildMediaIndex(roots) {
  const index = new Map();
  let collisions = 0;
  for (const root of roots) {
    walk(root, (full, name) => {
      if (/\.json$/i.test(name)) return;            // skip sidecars + album metadata
      const key = name.toLowerCase();
      if (!index.has(key)) index.set(key, full);
      else if (index.get(key) !== full) collisions++;  // same basename, different file
    });
  }
  index._collisions = collisions;                   // stashed for the loader's log
  return index;
}

export function loadGooglePhotos(roots) {
  const mediaIndex = buildMediaIndex(roots);
  const sidecars = [];
  for (const root of roots) walk(root, (full, name) => { if (SIDECAR_RE.test(name)) sidecars.push(full); });

  const byId = new Map();                            // dedup records by photo.id (basename)
  let skipped = 0;
  for (const sc of sidecars) {
    let text;
    try { text = fs.readFileSync(sc, 'utf-8'); } catch { skipped++; continue; }
    const rec = parseSidecar(text, { sidecarPath: sc, mediaIndex });
    if (!rec) { skipped++; continue; }
    if (!byId.has(rec.photo.id)) byId.set(rec.photo.id, rec);
  }
  const records = [...byId.values()];
  console.log(`Google Photos: ${records.length} records from ${roots.length} root(s) `
    + `(${mediaIndex.size} media indexed, ${skipped} skipped, ${mediaIndex._collisions || 0} basename collisions)`);
  return records;
}

export function findGooglePhotosRoots(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(baseDir).sort()) {
    const gp = path.join(baseDir, name, 'Google Photos');
    if (fs.existsSync(gp) && fs.statSync(gp).isDirectory()) out.push(gp);
  }
  return out;
}
