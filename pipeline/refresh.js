#!/usr/bin/env node
// Nightly corpus refresh — see docs/superpowers/specs/2026-07-30-auto-refresh-design.md.
//   npm run refresh              # full chain
//   npm run refresh -- --no-publish   # everything except sync:push
//
// Acquisition steps (partiful fetch) no-op quietly until their scripts and
// credentials exist. build-db failure aborts the publish. build-photos is
// never part of this chain (it wipes photo_faces).

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { runSteps, computeFreshness } from './lib/refresh-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const noPublish = process.argv.includes('--no-publish');

const sh = (cmd) => () => execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
const log = (m) => console.log(m);

const THRESHOLD_DAYS = {
  imessage: 7,      // local — anything stale here means the refresh itself broke
  whatsapp: 14,     // live bridge
  gmail: 60,        // Takeout cadence
  instagram: 60,    // HTML export cadence
  messenger: 90,    // DYI cadence
};

const steps = [
  { name: 'pull-labels', run: sh('bash scripts/sync-pull-labels.sh') },
  {
    name: 'pull-meta',
    run: () => {
      const script = path.join(ROOT, 'scripts', 'sync-pull-meta.sh');
      if (!fs.existsSync(script)) { log('  (pull-meta not installed — skipping)'); return; }
      execSync(`bash ${script}`, { cwd: ROOT, stdio: 'inherit' });
    },
  },
  {
    name: 'partiful-fetch',
    run: () => {
      const script = path.join(__dirname, 'ingest', 'partiful-fetch.js');
      if (!fs.existsSync(script)) { log('  (partiful fetch not installed yet — skipping)'); return; }
      execSync(`node ${script}`, { cwd: ROOT, stdio: 'inherit' });
    },
  },
  {
    // build-db deletes the DB file, and the Nominatim geocode cache lives in
    // it — snapshot before, restore after, or gphotos re-crawls ~4k coords.
    name: 'geocache-backup',
    run: () => {
      const db = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
      if (fs.existsSync(db)) fs.copyFileSync(db, db + '.prebuild.bak');
      else log('  (no DB to back up)');
    },
  },
  { name: 'build-db', critical: true, run: sh('npm run build-db') },
  { name: 'geocache-restore', run: sh('node scripts/restore-geocache.mjs') },
  // One step per builder so a single failure doesn't skip the rest. Order
  // matters: build-db deleted the whole DB, so photos/places (gphotos) and
  // photo_faces (faces export+ingest) must exist before build-events, or the
  // events layer rebuilds empty — and publish would ship that hollow release.
  ...[
    // Must precede everything that reads thread_identity: build-db wipes it,
    // and only this applies identity-aliases.json's thread splits.
    { file: 'apply-aliases.mjs' },
    { file: 'build-connections.js' },
    { file: 'build-graph.js' },
    { file: 'build-groups.js' },
    { file: 'build-gphotos-only.js' },
    { file: 'build-fb-events.js' },  // build-db empties fb_events nightly; events naming needs it
    { file: 'build-calls.js' },      // ditto calls — /person + /relationships facets
    { file: 'build-faces.js', args: 'export', name: 'build-faces-export' },
    { file: 'build-faces.js' },
    { file: 'build-events.js' },
    { file: 'build-inferred-events.js' }, // soft-fails when locallmm is down
    { file: 'build-rhythm.js' },
    { file: 'build-thumbs.js' },  // shipped thumb cache — the homelab has no raw archive
    { file: 'build-partiful-events.js' },
  ].map(({ file, args, name }) => ({
    name: name || file.replace(/\.m?js$/, ''),
    run: () => {
      const p = path.join(__dirname, file);
      if (!fs.existsSync(p)) { log(`  (${file} absent — skipping)`); return; }
      execSync(`node ${p}${args ? ' ' + args : ''}`, { cwd: ROOT, stdio: 'inherit' });
    },
  })),
  ...(noPublish ? [] : [{ name: 'publish', run: sh('npm run sync:push') }]),
];

const report = await runSteps(steps, { log });

// Freshness — per-source newest message vs thresholds.
let freshness = [];
try {
  const inst = await DuckDBInstance.create(path.join(__dirname, 'output', 'raw', 'messages.duckdb'), { access_mode: 'READ_ONLY' });
  const con = await inst.connect();
  const rows = (await con.runAndReadAll('SELECT source, max(ts) AS newest_ts FROM messages GROUP BY source')).getRowObjectsJson();
  con.closeSync(); inst.closeSync();
  freshness = computeFreshness(rows, THRESHOLD_DAYS, Date.now());
  fs.writeFileSync(path.join(__dirname, 'output', 'freshness.json'),
    JSON.stringify({ generated_at: new Date().toISOString(), report, sources: freshness }, null, 2));
} catch (e) {
  log(`[refresh] freshness failed: ${e.message}`);
}

const stale = freshness.filter((s) => s.stale);
for (const s of stale) {
  log(`[refresh] STALE: ${s.source} is ${s.days_behind}d behind (threshold ${s.threshold_days}d)`);
}
if (stale.length) {
  const msg = stale.map((s) => `${s.source} ${s.days_behind}d`).join(', ');
  try {
    execSync(`osascript -e 'display notification "${msg}" with title "corpus stale"'`);
  } catch { /* headless run — the log line is the record */ }
}

const failed = report.filter((r) => r.ok === false);
log(`[refresh] done — ${report.filter((r) => r.ok).length} ok, ${failed.length} failed, ${stale.length} stale sources`);
process.exit(failed.some((f) => steps.find((s) => s.name === f.name)?.critical) ? 1 : 0);
