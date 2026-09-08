#!/usr/bin/env node
/**
 * Derive output/email-summary.json from the email_correspondents + email_meta
 * tables (built by build-db.js). Read-only over the DB; no mbox access.
 *
 *   node pipeline/build-email-summary.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.join(__dirname, 'output');
const DB_PATH = path.join(OUTPUT, 'raw', 'messages.duckdb');
const OUT = path.join(OUTPUT, 'email-summary.json');

// Pure shaping function — unit-tested independently of DuckDB.
export function summarize(correspondents, categoryRows, topLimit = 50) {
  const by_category = {};
  for (const r of categoryRows) {
    const key = r.category == null ? 'uncategorized' : r.category;
    by_category[key] = (by_category[key] || 0) + Number(r.n);
  }
  const domainTotals = new Map();
  let total_bulk_messages = 0;
  for (const c of correspondents) {
    total_bulk_messages += c.n_messages;
    if (c.domain) domainTotals.set(c.domain, (domainTotals.get(c.domain) || 0) + c.n_messages);
  }
  const top_domains = [...domainTotals.entries()]
    .map(([domain, n_messages]) => ({ domain, n_messages }))
    .sort((a, b) => b.n_messages - a.n_messages)
    .slice(0, topLimit);
  const top_correspondents = [...correspondents]
    .sort((a, b) => b.n_messages - a.n_messages)
    .slice(0, topLimit)
    .map(c => ({ addr: c.addr, display_name: c.display_name, domain: c.domain, kind: c.kind, n_messages: c.n_messages, list_unsubscribe: c.list_unsubscribe }));
  return {
    total_correspondents: correspondents.length,
    total_bulk_messages,
    by_category,
    top_domains,
    top_correspondents,
  };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  const inst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();

  const corrRows = (await conn.runAndReadAll(
    `SELECT addr, display_name, domain, kind, n_messages, list_unsubscribe FROM email_correspondents`
  )).getRows().map(r => ({
    addr: r[0], display_name: r[1], domain: r[2], kind: r[3], n_messages: Number(r[4]), list_unsubscribe: r[5],
  }));

  const catRows = (await conn.runAndReadAll(
    `SELECT category, COUNT(*) AS n FROM email_meta GROUP BY category`
  )).getRows().map(r => ({ category: r[0], n: Number(r[1]) }));

  await conn.disconnectSync();

  const summary = { generated: new Date().toISOString(), ...summarize(corrRows, catRows) };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`Wrote ${path.relative(path.join(__dirname, '..'), OUT)} — `
    + `${summary.total_correspondents} correspondents, ${summary.total_bulk_messages} bulk msgs, `
    + `${Object.keys(summary.by_category).length} categories`);
}

// Only run main() when invoked directly, not when imported by the test.
if (process.argv[1] && process.argv[1].endsWith('build-email-summary.js')) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
