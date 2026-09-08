import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { unwrap } from './normalize/fold-identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const SELF_NAME = 'Demo User';
const GENERIC = new Set(['the','team','support','info','admin','user','facebook','instagram','service','orders','mum','mom','dad','me']);

const normName = s => (s || '').trim().toLowerCase();
const digits = s => (s || '').replace(/\D/g, '');
const tokens = s => normName(s).split(/\s+/).filter(t => t.length > 1 && !GENERIC.has(t));

export async function findDupIdentities(conn, { minScore = 2 } = {}) {
  const rows = (await conn.runAndReadAll(`
    SELECT i.canonical_id, i.display_name, i.aliases, i.sources, COALESCE(COUNT(m.id),0) AS msgs
    FROM identities i
    LEFT JOIN thread_identity ti ON ti.canonical_id = i.canonical_id
    LEFT JOIN messages m ON m.thread_id = ti.thread_id
    WHERE i.display_name IS NOT NULL AND i.display_name <> '${SELF_NAME}'
    GROUP BY 1,2,3,4
  `)).getRowObjectsJson().map(r => ({
    id: r.canonical_id, name: r.display_name, aliases: unwrap(r.aliases),
    sources: unwrap(r.sources), msgs: Number(r.msgs),
  }));

  const byPhone = new Map(), byEmail = new Map(), byNameAlias = new Map(), byToken = new Map();
  const add = (map, k, id) => { if (!k) return; (map.get(k) || map.set(k, []).get(k)).push(id); };
  const idx = new Map(rows.map(r => [r.id, r]));
  for (const r of rows) {
    for (const a of [r.name, ...r.aliases]) {
      const s = String(a);
      if (s.includes('@')) add(byEmail, s.toLowerCase(), r.id);
      else if (/^\+?\d[\d ()-]{6,}$/.test(s)) add(byPhone, '+' + digits(s), r.id);
      else add(byNameAlias, normName(s), r.id);
      for (const t of tokens(s)) add(byToken, t, r.id);
    }
  }

  const pairScore = new Map();
  const bump = (a, b, pts, reason) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const e = pairScore.get(k) || { score: 0, reasons: new Set() };
    e.score += pts; e.reasons.add(reason); pairScore.set(k, e);
  };
  const eachPair = (ids, fn) => { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) fn(ids[i], ids[j]); };
  for (const ids of byPhone.values())     if (ids.length <= 6) eachPair(ids, (a, b) => bump(a, b, 3, 'shared phone'));
  for (const ids of byEmail.values())     if (ids.length <= 6) eachPair(ids, (a, b) => bump(a, b, 3, 'shared email'));
  for (const ids of byNameAlias.values()) if (ids.length <= 8) eachPair(ids, (a, b) => bump(a, b, 2, 'shared name'));
  for (const ids of byToken.values()) {
    if (ids.length > 12) continue;
    eachPair(ids, (a, b) => {
      const ta = new Set(tokens(idx.get(a).name));
      const tb = tokens(idx.get(b).name);
      const overlap = tb.filter(t => ta.has(t)).length;
      if (overlap >= 1 && (ta.size <= 3 || tb.length <= 3)) bump(a, b, 1, 'similar name');
    });
  }

  const out = [];
  for (const [k, e] of pairScore) {
    if (e.score < minScore) continue;
    const [a, b] = k.split('|');
    out.push({ a: idx.get(a), b: idx.get(b), score: e.score, reasons: [...e.reasons] });
  }
  out.sort((x, y) => y.score - x.score);
  return out;
}

async function main() {
  const conn = await (await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' })).connect();
  const cands = await findDupIdentities(conn);
  console.log(`${cands.length} candidate pairs`);
  for (const c of cands.slice(0, 40)) console.log(`  [${c.score}] ${c.a.name} (${c.a.msgs}) <-> ${c.b.name} (${c.b.msgs})  {${c.reasons.join(', ')}}`);
  await conn.disconnectSync();
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
