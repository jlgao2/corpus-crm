#!/usr/bin/env node
// Re-attach crm.sqlite to the current corpus after a rebuild.
//   node pipeline/crm-relink.js            # relink + tz verify
// Exit 1 when any annotation row cannot be resolved (detached annotations
// are an error to fix, not a warning to scroll past). Tz staleness is
// advisory — it prints paste-ready lines for lib/local-time.js.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { openDb } from './crm-server/db.js';
import { relinkCrm, checkTzRules } from './lib/crm-relink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUCKDB_PATH = process.env.MCP_DUCKDB_PATH || path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const CRM_DB_PATH = process.env.MCP_CRM_DB_PATH || path.join(__dirname, 'output', 'crm.sqlite');

const inst = await DuckDBInstance.create(DUCKDB_PATH, { access_mode: 'READ_ONLY' });
const con = await inst.connect();
const reader = await con.runAndReadAll('SELECT canonical_id, display_name, aliases FROM identities');
const identities = reader.getRowObjectsJson();
con.closeSync();
inst.closeSync();

const db = openDb(CRM_DB_PATH);
const report = relinkCrm({ db, identities });
db.close();

console.log(`[crm-relink] ${CRM_DB_PATH}`);
console.log(`  ok ${report.ok.length} | backfilled ${report.backfilled.length} | rewritten ${report.rewritten.length} | merged ${report.merged.length} | unresolved ${report.unresolved.length}`);
for (const r of report.rewritten) console.log(`  rewrote ${r.from} → ${r.to}  (${r.name})`);
for (const m of report.merged) console.log(`  merged ${m.from} → ${m.to}`);
for (const u of report.unresolved) console.log(`  UNRESOLVED ${u.id}  (${u.name}) — annotations detached, fix by hand`);

const stale = checkTzRules(identities);
if (stale.length) {
  console.log('\n[crm-relink] IDENTITY_TZ_RULES is stale — paste into pipeline/lib/local-time.js:');
  for (const s of stale) console.log(`  ${s.pasteLine}`);
}

process.exit(report.unresolved.length ? 1 : 0);
