#!/usr/bin/env node
/**
 * Thumbnail builder — pregenerates the /thumb cache as a derived artifact.
 *
 *   npm run build-thumbs
 *
 * 320px JPEGs for every photo asset, named sha1(absolute path).jpg in
 * output/thumbs — the same key serve.js uses, so the cache ships inside
 * releases and the homelab serves photos without holding the 82G archive.
 * Incremental: existing thumbs are skipped. macOS `sips` does the resizing.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const THUMBS_DIR = process.env.THUMBS_DIR || path.join(__dirname, 'output', 'thumbs');
const WORKERS = parseInt(process.env.THUMB_WORKERS || '8', 10);

export function thumbPathFor(assetPath, dir) {
  return path.join(dir, crypto.createHash('sha1').update(assetPath).digest('hex') + '.jpg');
}

export function planMissing(assets, dir) {
  return assets
    .map(asset => ({ asset, out: thumbPathFor(asset, dir) }))
    .filter(t => !fs.existsSync(t.out));
}

function sips(asset, out) {
  return new Promise(resolve => {
    execFile('sips', ['-s', 'format', 'jpeg', '-Z', '320', asset, '--out', out],
      { timeout: 30000, killSignal: 'SIGKILL' }, (err) => resolve(!err));
  });
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }
  const inst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();
  const assets = (await conn.runAndReadAll(
    `SELECT DISTINCT asset_path FROM photos WHERE asset_path IS NOT NULL`)).getRows().map(r => r[0]);
  await conn.disconnectSync();

  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const plan = planMissing(assets, THUMBS_DIR).filter(t => fs.existsSync(t.asset));
  console.log(`${assets.length} assets, ${plan.length} thumbs to generate (${assets.length - plan.length} cached/absent)`);

  let done = 0, failed = 0, i = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (i < plan.length) {
      const t = plan[i++];
      (await sips(t.asset, t.out)) ? done++ : failed++;
      if ((done + failed) % 2000 === 0) console.log(`  ${done + failed}/${plan.length}`);
    }
  }));
  console.log(`thumbs: ${done} generated, ${failed} failed -> ${THUMBS_DIR}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
