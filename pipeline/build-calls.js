import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadCalls } from './ingest/calls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const CALLS_DB = path.join(__dirname, '..', 'inputs', 'calls', 'CallHistory.db');
const esc = s => s == null ? 'NULL' : "'" + String(s).replace(/'/g, "''") + "'";
const num = n => (n == null || Number.isNaN(Number(n))) ? 'NULL' : Number(n);
const digits = s => String(s || '').replace(/\D/g, '');
const unwrap = v => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);

// Build a phone/email -> canonical_id resolver from identity aliases, matching
// identity.js's normalization (phone => '+' + digits; email => lowercased).
export function buildResolver(idRows) {
  const phone = new Map(), email = new Map();
  for (const r of idRows) {
    for (const a of unwrap(r.aliases)) {
      const s = String(a);
      if (s.includes('@')) { const k = s.toLowerCase(); if (!email.has(k)) email.set(k, r.canonical_id); }
      else { const d = digits(s); if (d.length >= 7) { const k = '+' + d; if (!phone.has(k)) phone.set(k, r.canonical_id); } }
    }
  }
  return (address) => {
    if (!address) return null;
    if (address.includes('@')) return email.get(address.toLowerCase()) || null;
    const d = digits(address);
    return d.length >= 7 ? (phone.get('+' + d) || null) : null;
  };
}

export async function buildCalls(conn, calls) {
  await conn.run(`
    DROP TABLE IF EXISTS calls;
    CREATE TABLE calls (call_id VARCHAR PRIMARY KEY, ts BIGINT, duration_s DOUBLE, direction VARCHAR,
      answered BOOLEAN, missed BOOLEAN, service VARCHAR, address VARCHAR, name VARCHAR, canonical_id VARCHAR);
    CREATE INDEX IF NOT EXISTS idx_calls_canon ON calls(canonical_id);
  `);
  const idRows = (await conn.runAndReadAll('SELECT canonical_id, aliases FROM identities')).getRowObjectsJson();
  const resolve = buildResolver(idRows);
  let resolved = 0;
  for (const c of calls) {
    const cid = resolve(c.address);
    if (cid) resolved++;
    await conn.run(`INSERT INTO calls VALUES (${esc(c.call_id)}, ${num(c.ts)}, ${num(c.duration_s)}, ${esc(c.direction)}, ${c.answered === true}, ${c.missed === true}, ${esc(c.service)}, ${esc(c.address)}, ${esc(c.name)}, ${esc(cid)}) ON CONFLICT DO NOTHING`);
  }
  return { n: calls.length, resolved };
}

async function main() {
  const calls = fs.existsSync(CALLS_DB) ? loadCalls(CALLS_DB) : [];
  const conn = await (await DuckDBInstance.create(DB_PATH)).connect();
  const r = await buildCalls(conn, calls);
  console.log(`[calls] ${r.n} calls, ${r.resolved} resolved to identities -> calls table`);
  await conn.disconnectSync();
}
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main().catch(e => { console.error('Fatal:', e); process.exit(1); });
