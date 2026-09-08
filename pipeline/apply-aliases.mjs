// Applies pipeline/identity-aliases.json: merges (via cli-merge-identities), renames (display_name+aliases),
// and splits (peel one thread out of an existing canonical_id into its own new identity).
import fs from 'fs';
import { DuckDBInstance } from '@duckdb/node-api';

const cfg = JSON.parse(fs.readFileSync('pipeline/identity-aliases.json'));
const inst = await DuckDBInstance.create('pipeline/output/raw/messages.duckdb');
const conn = await inst.connect();

// Renames
for (const r of cfg.renames || []) {
  const before = (await conn.runAndReadAll(`SELECT canonical_id, display_name, aliases::VARCHAR FROM identities WHERE canonical_id = '${r.canonical_id}'`)).getRows();
  if (!before.length) { console.log('rename skip — not found:', r.canonical_id); continue; }
  const [, oldName, oldAliasesStr] = before[0];
  // Skip the early-return when only an alias mutation is requested (rename target same as current name)
  if (oldName === r.to && !(r.remove_aliases && r.remove_aliases.length) && !(r.aliases && r.aliases.length)) continue;
  const oldAliases = oldAliasesStr.replace(/[\[\]'"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  const removeSet = new Set((r.remove_aliases || []).map(s => s.toLowerCase()));
  const newAliases = Array.from(new Set([...oldAliases, oldName, ...(r.aliases || [])]))
    .filter(a => a !== r.to)
    .filter(a => !removeSet.has(a.toLowerCase()));
  const aliasLit = '[' + newAliases.map(a => "'" + a.replace(/'/g, "''") + "'").join(',') + ']';
  await conn.run(`UPDATE identities SET display_name = '${r.to.replace(/'/g, "''")}', aliases = ${aliasLit} WHERE canonical_id = '${r.canonical_id}'`);
  console.log('renamed/aliases', r.canonical_id, oldName, '→', r.to, removeSet.size ? `(removed: ${[...removeSet].join(', ')})` : '');
}

// Explicit canonical_id-based merges (for duplicate display_name cases).
for (const m of cfg.id_merges || []) {
  const winnerExists = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE canonical_id = '${m.winner_id}'`)).getRows();
  const loserExists = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE canonical_id = '${m.loser_id}'`)).getRows();
  if (!winnerExists.length || !loserExists.length) {
    console.log('id_merge skip — missing identity:', m.winner_id, m.loser_id);
    continue;
  }
  // Reassign FK tables from loser to winner
  for (const stmt of [
    `UPDATE thread_identity SET canonical_id = '${m.winner_id}' WHERE canonical_id = '${m.loser_id}'`,
    `UPDATE group_membership SET canonical_id = '${m.winner_id}' WHERE canonical_id = '${m.loser_id}'`,
    `UPDATE mentions SET mentioned_canonical_id = '${m.winner_id}' WHERE mentioned_canonical_id = '${m.loser_id}'`,
    `UPDATE links SET src_canonical_id = '${m.winner_id}' WHERE src_canonical_id = '${m.loser_id}'`,
    `UPDATE links SET dst_canonical_id = '${m.winner_id}' WHERE dst_canonical_id = '${m.loser_id}'`,
    `UPDATE birthdays SET canonical_id = '${m.winner_id}' WHERE canonical_id = '${m.loser_id}'`,
    `DELETE FROM links WHERE src_canonical_id = dst_canonical_id`,
  ]) {
    try { await conn.run(stmt); } catch (e) { /* table may not have column */ }
  }
  // Update display_name + merge aliases on winner
  const before = (await conn.runAndReadAll(`SELECT display_name, aliases::VARCHAR FROM identities WHERE canonical_id = '${m.winner_id}'`)).getRows();
  const loserRow = (await conn.runAndReadAll(`SELECT display_name, aliases::VARCHAR FROM identities WHERE canonical_id = '${m.loser_id}'`)).getRows();
  const winnerAliases = (before[0][1] || '').replace(/[\[\]'"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  const loserAliases = (loserRow[0][1] || '').replace(/[\[\]'"]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  const newDisplay = m.display_name || before[0][0];
  const newAliases = Array.from(new Set([...winnerAliases, ...loserAliases, before[0][0], loserRow[0][0]])).filter(a => a !== newDisplay);
  const aliasLit = '[' + newAliases.map(a => "'" + a.replace(/'/g, "''") + "'").join(',') + ']';
  await conn.run(`UPDATE identities SET display_name = '${newDisplay.replace(/'/g, "''")}', aliases = ${aliasLit} WHERE canonical_id = '${m.winner_id}'`);
  // Delete loser identity
  await conn.run(`DELETE FROM identities WHERE canonical_id = '${m.loser_id}'`);
  console.log('id_merge', m.loser_id, '→', m.winner_id, '(' + newDisplay + ')');
}

// Splits — peel a thread out of its current canonical_id into a new one
for (const s of cfg.splits || []) {
  // Check thread exists in messages
  const msgCheck = (await conn.runAndReadAll(`SELECT COUNT(*) FROM messages WHERE thread_id = '${s.thread_id.replace(/'/g, "''")}' LIMIT 1`)).getRows();
  if (!msgCheck.length || !msgCheck[0][0]) { console.log('split skip — no messages for thread:', s.thread_id); continue; }
  // Check current thread_identity assignment (may not exist for ghost threads)
  const cur = (await conn.runAndReadAll(`SELECT canonical_id FROM thread_identity WHERE thread_id = '${s.thread_id.replace(/'/g, "''")}'`)).getRows();
  const oldCid = cur.length ? cur[0][0] : null;

  // Already split? (canonical_id display_name already matches "to")
  const existing = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE display_name = '${s.to.replace(/'/g, "''")}'`)).getRows();
  if (existing.length && existing[0][0] === oldCid) {
    console.log('split skip — already on a single-identity', oldCid, s.to);
    continue;
  }
  if (existing.length) {
    // Identity with this name already exists — just reassign the thread to it
    const targetCid = existing[0][0];
    await conn.run(`UPDATE thread_identity SET canonical_id = '${targetCid}' WHERE thread_id = '${s.thread_id.replace(/'/g, "''")}'`);
    console.log('split-reassign', s.thread_id, oldCid, '→', targetCid, '(existing', s.to, ')');
    continue;
  }

  // Create new identity
  const allIds = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE canonical_id LIKE 'id-%'`)).getRows();
  const maxN = Math.max(...allIds.map(r => parseInt(String(r[0]).replace('id-', ''), 10) || 0));
  const newCid = `id-${maxN + 1}`;
  // Determine sources from the thread's messages
  const srcRows = (await conn.runAndReadAll(`SELECT DISTINCT source FROM messages WHERE thread_id = '${s.thread_id.replace(/'/g, "''")}'`)).getRows();
  const sources = srcRows.map(r => r[0]);
  const srcLit = '[' + sources.map(x => "'" + x + "'").join(',') + ']';
  const aliasArr = [s.thread_id, ...(s.aliases || [])];
  const aliasLit = '[' + aliasArr.map(a => "'" + a.replace(/'/g, "''") + "'").join(',') + ']';
  await conn.run(`INSERT INTO identities (canonical_id, display_name, aliases, sources) VALUES ('${newCid}', '${s.to.replace(/'/g, "''")}', ${aliasLit}, ${srcLit})`);
  await conn.run(`UPDATE thread_identity SET canonical_id = '${newCid}' WHERE thread_id = '${s.thread_id.replace(/'/g, "''")}'`);
  // Also rewire any per-thread mention rows pointing at oldCid for this thread (none should, but leave as-is — mentions are mentioned_canonical_id-keyed)
  console.log('split', s.thread_id, oldCid, '→', newCid, s.to);
}

await conn.disconnectSync();
console.log('done');
