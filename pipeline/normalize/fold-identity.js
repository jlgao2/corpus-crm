// Fold one identity (loser) into another (winner): move all FK rows, union
// aliases+sources, optionally rename, then delete the loser. Shared by
// merge-case-variant-identities.js and apply-merges.js. Caller owns the txn.
export const esc = s => s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
export const unwrap = v => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

export async function foldIdentity(conn, winnerId, loserId, opts = {}) {
  if (!winnerId || !loserId || winnerId === loserId) return;
  await conn.run(`INSERT INTO thread_identity (thread_id, canonical_id) SELECT thread_id, ${esc(winnerId)} FROM thread_identity WHERE canonical_id = ${esc(loserId)} ON CONFLICT DO NOTHING`);
  await conn.run(`DELETE FROM thread_identity WHERE canonical_id = ${esc(loserId)}`);
  try {
    await conn.run(`INSERT INTO photo_faces (photo_id, canonical_id, face_cluster) SELECT photo_id, ${esc(winnerId)}, face_cluster FROM photo_faces WHERE canonical_id = ${esc(loserId)} ON CONFLICT DO NOTHING`);
    await conn.run(`DELETE FROM photo_faces WHERE canonical_id = ${esc(loserId)}`);
  } catch {}
  try { await conn.run(`UPDATE face_clusters SET canonical_id = ${esc(winnerId)} WHERE canonical_id = ${esc(loserId)}`); } catch {}
  try { await conn.run(`UPDATE birthdays SET canonical_id = ${esc(winnerId)} WHERE canonical_id = ${esc(loserId)}`); } catch {}
  try { await conn.run(`UPDATE calls SET canonical_id = ${esc(winnerId)} WHERE canonical_id = ${esc(loserId)}`); } catch {}
  try { await conn.run(`UPDATE group_membership SET canonical_id = ${esc(winnerId)} WHERE canonical_id = ${esc(loserId)}`); } catch {}
  try { await conn.run(`UPDATE mentions SET mentioned_canonical_id = ${esc(winnerId)} WHERE mentioned_canonical_id = ${esc(loserId)}`); } catch {}
  try {
    await conn.run(`UPDATE links SET canonical_id = ${esc(winnerId)} WHERE canonical_id = ${esc(loserId)}`);
    await conn.run(`UPDATE links SET related_canonical_id = ${esc(winnerId)} WHERE related_canonical_id = ${esc(loserId)}`);
    await conn.run(`DELETE FROM links WHERE canonical_id = related_canonical_id`);
  } catch {}
  const w = (await conn.runAndReadAll(`SELECT aliases, sources FROM identities WHERE canonical_id = ${esc(winnerId)}`)).getRows()[0];
  const l = (await conn.runAndReadAll(`SELECT aliases, sources FROM identities WHERE canonical_id = ${esc(loserId)}`)).getRows()[0];
  if (w && l) {
    const al = [...new Set([...unwrap(w[0]), ...unwrap(l[0])])].map(esc).join(',');
    const sr = [...new Set([...unwrap(w[1]), ...unwrap(l[1])])].map(esc).join(',');
    await conn.run(`UPDATE identities SET aliases = [${al}], sources = [${sr}] WHERE canonical_id = ${esc(winnerId)}`);
  }
  if (opts.renameTo) await conn.run(`UPDATE identities SET display_name = ${esc(opts.renameTo)} WHERE canonical_id = ${esc(winnerId)}`);
  await conn.run(`DELETE FROM identities WHERE canonical_id = ${esc(loserId)}`);
}
