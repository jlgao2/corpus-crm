#!/usr/bin/env node
/**
 * Rhythm grid builder — the Wolfram diel view's data.
 *
 *   npm run build-rhythm
 *
 * Buckets every meaningful message into (week, Demo-local hour-of-day)
 * and writes output/rhythm.json for the /rhythm heatmap. Local hours go
 * through the tz rule table, so the Melbourne→Chicago relocation shows as
 * a visible seam in the sleep band. Runs in seconds; rerun after build-db.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';
import { resolveTz } from './lib/local-time.js';
import { weekIndex } from './lib/weeks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const OUT_PATH = process.env.RHYTHM_OUT || path.join(__dirname, 'output', 'rhythm.json');

/**
 * @param {Array<{ts:number, from_me:boolean}>} rows
 * @param {(ts:number) => number} localHourFn - ts -> 0..23 in the subject's local tz
 * @returns {{cells: Array<[number,number,number,number,number]>}} [year, week, hour, n, nFromMe]
 */
export function bucketRhythm(rows, { localHourFn }) {
  const grid = new Map();
  for (const r of rows) {
    const { year, week } = weekIndex(r.ts);
    const hour = localHourFn(r.ts);
    const key = `${year}|${week}|${hour}`;
    let c = grid.get(key);
    if (!c) { c = { year, week, hour, n: 0, out: 0 }; grid.set(key, c); }
    c.n++;
    if (r.from_me) c.out++;
  }
  return {
    cells: [...grid.values()]
      .sort((a, b) => a.year - b.year || a.week - b.week || a.hour - b.hour)
      .map(c => [c.year, c.week, c.hour, c.n, c.out]),
  };
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  const inst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();
  const georgeId = (await conn.runAndReadAll(
    `SELECT canonical_id FROM identities WHERE lower(display_name) = 'demo user' LIMIT 1`)).getRows()[0]?.[0] || null;

  const rows = (await conn.runAndReadAll(
    `SELECT ts, from_me FROM messages WHERE meaningful AND ts IS NOT NULL`)).getRows()
    .map(r => ({ ts: Number(r[0]), from_me: !!r[1] }));
  console.log(`${rows.length} meaningful messages`);

  // One cached hour formatter per tz — the rule table only has a handful.
  const fmts = new Map();
  const localHourFn = (ts) => {
    const { tz } = resolveTz(georgeId, ts);
    let f = fmts.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }); fmts.set(tz, f); }
    return parseInt(f.format(new Date(ts)), 10) % 24;
  };

  const grid = bucketRhythm(rows, { localHourFn });
  fs.writeFileSync(OUT_PATH, JSON.stringify(grid));
  console.log(`${grid.cells.length} cells -> ${OUT_PATH}`);
  await conn.disconnectSync();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
