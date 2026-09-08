import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { foldIdentity, esc } from './normalize/fold-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const MERGES_PATH = path.join(__dirname, 'identity-merges.json');
const SELF_NAME = 'Demo User';

export async function resolveSignature(conn, sig) {
  if (!sig) return { id: null, why: 'empty' };
  if (sig.alias) {
    const r = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE list_contains(aliases, ${esc(sig.alias)}) OR LOWER(display_name) = LOWER(${esc(sig.alias)})`)).getRows();
    if (r.length === 1) return { id: r[0][0], why: 'alias' };
    if (r.length > 1) return { id: null, why: 'alias ambiguous' };
  }
  if (sig.name) {
    const r = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE display_name = ${esc(sig.name)}`)).getRows();
    if (r.length === 1) return { id: r[0][0], why: 'name' };
    if (r.length > 1) return { id: null, why: 'name ambiguous' };
  }
  return { id: null, why: 'not found' };
}

export async function applyMerges(conn, merges, { apply }) {
  const selfRow = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE display_name = ${esc(SELF_NAME)} LIMIT 1`)).getRows()[0];
  const selfId = selfRow ? selfRow[0] : null;
  const report = { applied: [], skipped: [], unresolved: [] };
  for (const m of merges) {
    const w = await resolveSignature(conn, m.winner);
    const l = await resolveSignature(conn, m.loser);
    if (!w.id || !l.id) { report.unresolved.push({ m, w, l }); continue; }
    if (w.id === l.id) { report.skipped.push({ m, why: 'already merged' }); continue; }
    if (w.id === selfId || l.id === selfId) { report.skipped.push({ m, why: 'self-guard' }); continue; }
    if (apply) await foldIdentity(conn, w.id, l.id);
    report.applied.push({ winner: w.id, loser: l.id, name: m.winner.name });
  }
  return report;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const merges = fs.existsSync(MERGES_PATH) ? (JSON.parse(fs.readFileSync(MERGES_PATH, 'utf-8')).merges || []) : [];
  const conn = await (await DuckDBInstance.create(DB_PATH, apply ? {} : { access_mode: 'READ_ONLY' })).connect();
  const r = await applyMerges(conn, merges, { apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${r.applied.length} applied, ${r.skipped.length} skipped, ${r.unresolved.length} unresolved`);
  for (const u of r.unresolved) console.log(`  unresolved: ${u.m.winner?.name} <- ${u.m.loser?.name} (winner:${u.w.why}, loser:${u.l.why})`);
  if (apply) console.log('Next: build-connections && build-graph');
  await conn.disconnectSync();
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
