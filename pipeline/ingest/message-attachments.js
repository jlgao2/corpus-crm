import fs from 'fs';
import path from 'path';
import os from 'os';
import { hashFile } from '../normalize/photo-dedup.js';

const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i;

/**
 * Walk a directory recursively, return all file paths matching IMAGE_EXT.
 */
function walkImages(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkImages(full));
    else if (IMAGE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * iMessage attachments live at ~/Library/Messages/Attachments/
 * Subdirectory structure varies but the basename includes the message GUID.
 *
 * We can't perfectly reverse-link without scanning the chat.db's
 * `attachment` table. For v1 we hash every image, look up by attachment
 * filename in chat.db, and link if found.
 */
export async function loadIMessageAttachments(conn, attachmentsRoot) {
  const root = attachmentsRoot || path.join(os.homedir(), 'Library', 'Messages', 'Attachments');
  const files = walkImages(root);

  // Pull attachment → message linkage from chat.db (already linked into our DB
  // would be ideal but we don't track this yet, so query directly via duckdb_sqlite_scan
  // or via a separate sqlite read). For simplicity we just leave message_id null
  // for now and rely on the Apple Photos "imported via Messages" tag for linking.
  // (See spec — message-attachment linking is best-effort in v1.)

  const results = [];
  for (const fp of files) {
    let h;
    try { h = await hashFile(fp); } catch { continue; }
    results.push({
      photo: {
        id: `sha256:${h}`,
        apple_uuid: null,
        ts: fs.statSync(fp).mtimeMs,
        ts_iso: new Date(fs.statSync(fp).mtimeMs).toISOString(),
        source: 'imessage',
        source_ref: null,
        message_id: null,    // best-effort linkage in a future iteration
        asset_path: fp,
        width: null,
        height: null,
        hash_sha256: h,
        has_named_face: false,
      },
      faces: [],
      place: null,
    });
  }
  return results;
}

/**
 * Instagram exports keep message photos at:
 *   <export_root>/your_instagram_activity/messages/inbox/<thread>/photos/*
 * Each thread is keyed by handle_id matching what the existing parser uses.
 */
export async function loadInstagramAttachments(exportRoot) {
  const inbox = path.join(exportRoot, 'your_instagram_activity', 'messages', 'inbox');
  if (!fs.existsSync(inbox)) return [];

  const results = [];
  const threadDirs = fs.readdirSync(inbox).filter(d =>
    fs.statSync(path.join(inbox, d)).isDirectory()
  );

  for (const dir of threadDirs) {
    const photoDir = path.join(inbox, dir, 'photos');
    if (!fs.existsSync(photoDir)) continue;
    const files = walkImages(photoDir);
    for (const fp of files) {
      let h;
      try { h = await hashFile(fp); } catch { continue; }
      results.push({
        photo: {
          id: `sha256:${h}`,
          apple_uuid: null,
          ts: fs.statSync(fp).mtimeMs,
          ts_iso: new Date(fs.statSync(fp).mtimeMs).toISOString(),
          source: 'instagram',
          source_ref: `ig:${dir}`,
          message_id: null,
          asset_path: fp,
          width: null,
          height: null,
          hash_sha256: h,
          has_named_face: false,
        },
        faces: [],
        place: null,
      });
    }
  }
  return results;
}
