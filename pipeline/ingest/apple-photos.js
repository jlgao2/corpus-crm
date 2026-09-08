import { execFileSync } from 'child_process';

const EXCLUDE_ALBUM = '_exclude_from_analysis';

// Absolute path to osxphotos (installed via pipx).
// pipx puts binaries in ~/.local/bin which isn't always on PATH for shelled-out children.
const OSXPHOTOS_BIN = process.env.OSXPHOTOS_BIN
  || `${process.env.HOME}/.local/bin/osxphotos`;

/**
 * Run `osxphotos query --json` to get all photo metadata.
 *
 * Returns an array of objects with at least:
 *   uuid, original_filename, path, date, latitude, longitude,
 *   width, height, persons (array of names), albums (array of names)
 *
 * Set --library to override the default Photos library location.
 */
export async function loadAppleLibraryMetadata(opts = {}) {
  const { library = null, includeHidden = false } = opts;

  const args = [
    'query',
    '--json',
    '--only-photos',  // exclude movies for now
  ];
  if (!includeHidden) args.push('--not-hidden');
  if (library) args.push('--library', library);

  let raw;
  try {
    raw = execFileSync(OSXPHOTOS_BIN, args, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 1024, // 1GB — Photos libraries can be huge
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`osxphotos not found at ${OSXPHOTOS_BIN}. Install with: pipx install osxphotos`);
    }
    throw new Error(`osxphotos query failed: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`osxphotos returned non-JSON: ${err.message}`);
  }

  // Filter out the user-curated exclude album
  return data.filter(p => !(p.albums || []).includes(EXCLUDE_ALBUM));
}

/**
 * Convert a single osxphotos record into our photos / photo_faces / places shape.
 *
 * Returns: { photo, faces: [...names], place: {lat, lng} | null }
 */
export function normalizeApplePhoto(record) {
  const ts = record.date ? new Date(record.date).getTime() : 0;
  const photo = {
    id: record.uuid,                       // Apple UUID is canonical
    apple_uuid: record.uuid,
    ts,
    ts_iso: ts ? new Date(ts).toISOString() : null,
    source: 'apple_photos',
    source_ref: null,
    message_id: null,
    asset_path: record.path || null,        // null if iCloud-only and not downloaded
    width: record.width || null,
    height: record.height || null,
    hash_sha256: null,                      // filled in later if asset_path exists
    has_named_face: (record.persons || []).filter(n => n && n.trim()).length > 0,
  };
  const faces = (record.persons || []).filter(n => n && n.trim());
  const place = (record.latitude && record.longitude)
    ? { lat: record.latitude, lng: record.longitude }
    : null;
  return { photo, faces, place };
}

/**
 * Match face cluster names against the existing identities table.
 *
 * @param {Array<{photo_id, name}>} faceRows
 * @param {Map<string, string>} nameToCanonical - lowercased display_name → canonical_id
 * @returns {{matched: Array, unmatched: Array<string>}}
 */
export function resolveFaces(faceRows, nameToCanonical) {
  const matched = [];
  const unmatched = new Set();
  for (const { photo_id, name } of faceRows) {
    const canId = nameToCanonical.get(name.toLowerCase());
    if (canId) {
      matched.push({ photo_id, canonical_id: canId, face_cluster: name });
    } else {
      unmatched.add(name);
    }
  }
  return { matched, unmatched: [...unmatched] };
}
