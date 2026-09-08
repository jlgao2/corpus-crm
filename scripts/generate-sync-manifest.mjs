#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUTPUT = path.join(ROOT, 'pipeline', 'output');
const DB = path.join(OUTPUT, 'raw', 'messages.duckdb');

const releaseIndex = process.argv.indexOf('--release');
const releaseId = releaseIndex >= 0 ? process.argv[releaseIndex + 1] : null;
if (!releaseId || !/^[A-Za-z0-9._-]+$/.test(releaseId)) {
  console.error('usage: node scripts/generate-sync-manifest.mjs --release <safe-release-id>');
  process.exit(2);
}
if (!fs.existsSync(DB)) {
  console.error(`database not found: ${DB}`);
  process.exit(1);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

const instance = await DuckDBInstance.create(DB, { access_mode: 'READ_ONLY' });
const connection = await instance.connect();
const totalsReader = await connection.runAndReadAll(`
  SELECT count(*)::BIGINT AS messages, max(ts_iso) AS newest_message
  FROM messages
`);
const sourcesReader = await connection.runAndReadAll(`
  SELECT source, count(*)::BIGINT AS messages, max(ts_iso) AS newest_message
  FROM messages
  GROUP BY source
  ORDER BY source
`);
const identitiesReader = await connection.runAndReadAll(`
  SELECT count(*)::BIGINT AS identities FROM identities
`);
const totals = totalsReader.getRowObjectsJson()[0];
const identities = identitiesReader.getRowObjectsJson()[0];
const sources = sourcesReader.getRowObjectsJson();
connection.closeSync();

const stat = fs.statSync(DB);
const manifest = {
  schemaVersion: 1,
  releaseId,
  generatedAt: new Date().toISOString(),
  git: {
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain').length > 0,
  },
  database: {
    relativePath: 'raw/messages.duckdb',
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: await sha256(DB),
    messages: totals.messages,
    identities: identities.identities,
    newestMessage: totals.newest_message,
    sources,
  },
};

const target = path.join(OUTPUT, 'sync-manifest.json');
fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${path.relative(ROOT, target)}`);
console.log(`release=${releaseId}`);
console.log(`sha256=${manifest.database.sha256}`);
console.log(`messages=${manifest.database.messages} identities=${manifest.database.identities}`);
