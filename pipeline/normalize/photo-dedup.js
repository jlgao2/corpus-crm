import crypto from 'crypto';
import fs from 'fs';

/**
 * SHA-256 hash of a file's contents, hex-encoded.
 *
 * @param {string} filepath
 * @returns {Promise<string>}
 */
export function hashFile(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Canonical photo id: Apple UUID if available, else "sha256:<hash>".
 *
 * @param {{apple_uuid: string|null, hash_sha256: string|null}} input
 * @returns {string}
 */
export function canonicalIdFor({ apple_uuid, hash_sha256 }) {
  if (apple_uuid) return apple_uuid;
  if (hash_sha256) return `sha256:${hash_sha256}`;
  throw new Error('canonicalIdFor requires apple_uuid or hash_sha256');
}

/**
 * Merge same-hash photos from different sources into one row each.
 *
 * Precedence: a row whose source is 'apple_photos' (Apple UUID id) wins as
 * the canonical row. Other rows' source/source_ref/message_id become alt_refs
 * on the winner. ts and asset_path on the winner are kept; other rows'
 * fields are preserved only in alt_refs.
 *
 * @param {Array} photos - rows with hash_sha256, source, source_ref
 * @returns {Array} deduped rows with .alt_refs[]
 */
export function mergeDuplicates(photos) {
  const byHash = new Map();
  for (const p of photos) {
    if (!p.hash_sha256) {
      // No hash — can't dedup. Pass through with empty alt_refs.
      byHash.set(`__nohash__:${p.id}`, { ...p, alt_refs: [] });
      continue;
    }
    if (!byHash.has(p.hash_sha256)) {
      byHash.set(p.hash_sha256, { ...p, alt_refs: [] });
      continue;
    }
    const existing = byHash.get(p.hash_sha256);
    // Decide winner: apple_photos source preferred
    if (p.source === 'apple_photos' && existing.source !== 'apple_photos') {
      // Demote existing to alt_ref, promote p
      const altRef = { source: existing.source, source_ref: existing.source_ref };
      if (existing.message_id !== undefined) altRef.message_id = existing.message_id;
      const newWinner = { ...p, alt_refs: [...existing.alt_refs, altRef] };
      byHash.set(p.hash_sha256, newWinner);
    } else {
      // Add p as alt_ref to existing
      const altRef = { source: p.source, source_ref: p.source_ref };
      if (p.message_id !== undefined) altRef.message_id = p.message_id;
      existing.alt_refs.push(altRef);
    }
  }
  return [...byHash.values()];
}
