#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function count(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new Error(`invalid message count for ${label}: ${String(value)}`);
  }
}

function timestamp(value, label) {
  if (value == null || value === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid newest_message for ${label}: ${value}`);
  return parsed;
}

function sourceMap(manifest, label) {
  if (!Array.isArray(manifest?.database?.sources)) {
    throw new Error(`${label} manifest has no database.sources array`);
  }
  const result = new Map();
  for (const source of manifest.database.sources) {
    if (!source?.source || result.has(source.source)) {
      throw new Error(`${label} manifest has an invalid or duplicate source`);
    }
    result.set(source.source, source);
  }
  return result;
}

export function compareCorpusManifests(candidate, baseline) {
  const candidateSources = sourceMap(candidate, 'candidate');
  const baselineSources = sourceMap(baseline, 'baseline');
  const names = [...new Set([...baselineSources.keys(), ...candidateSources.keys()])].sort();
  const rows = [];
  const regressions = [];

  for (const name of names) {
    const before = baselineSources.get(name);
    const after = candidateSources.get(name);
    const beforeCount = before ? count(before.messages, `baseline ${name}`) : 0n;
    const afterCount = after ? count(after.messages, `candidate ${name}`) : 0n;
    const beforeNewest = before ? timestamp(before.newest_message, `baseline ${name}`) : null;
    const afterNewest = after ? timestamp(after.newest_message, `candidate ${name}`) : null;
    const problems = [];

    if (before && !after) problems.push('source missing');
    if (afterCount < beforeCount) problems.push(`count down ${beforeCount - afterCount}`);
    if (beforeNewest != null && (afterNewest == null || afterNewest < beforeNewest)) {
      problems.push('newest message moved backward');
    }

    const row = {
      source: name,
      baseline: beforeCount,
      candidate: afterCount,
      delta: afterCount - beforeCount,
      baselineNewest: before?.newest_message ?? null,
      candidateNewest: after?.newest_message ?? null,
      problems,
    };
    rows.push(row);
    for (const problem of problems) regressions.push(`${name}: ${problem}`);
  }

  const baselineTotal = count(baseline?.database?.messages, 'baseline total');
  const candidateTotal = count(candidate?.database?.messages, 'candidate total');
  if (candidateTotal < baselineTotal) {
    regressions.push(`total: count down ${baselineTotal - candidateTotal}`);
  }

  return {
    ok: regressions.length === 0,
    regressions,
    rows,
    baselineTotal,
    candidateTotal,
  };
}

function signed(value) {
  return value >= 0n ? `+${value}` : String(value);
}

function printResult(result) {
  const widths = { source: 12, baseline: 12, candidate: 12, delta: 12 };
  console.log([
    'source'.padEnd(widths.source),
    'baseline'.padStart(widths.baseline),
    'candidate'.padStart(widths.candidate),
    'delta'.padStart(widths.delta),
    'gate',
  ].join('  '));
  for (const row of result.rows) {
    console.log([
      row.source.padEnd(widths.source),
      String(row.baseline).padStart(widths.baseline),
      String(row.candidate).padStart(widths.candidate),
      signed(row.delta).padStart(widths.delta),
      row.problems.length ? row.problems.join('; ') : 'PASS',
    ].join('  '));
  }
  console.log(`total: ${result.baselineTotal} -> ${result.candidateTotal} (${signed(result.candidateTotal - result.baselineTotal)})`);
}

function usage() {
  console.error('usage: node scripts/verify-corpus-gate.mjs --baseline <manifest> --candidate <manifest> [--allow-regression]');
}

function main(argv) {
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : null;
  };
  const baselinePath = valueAfter('--baseline');
  const candidatePath = valueAfter('--candidate');
  const allowRegression = argv.includes('--allow-regression');
  if (!baselinePath || !candidatePath) {
    usage();
    return 2;
  }

  const read = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8'));
  const result = compareCorpusManifests(read(candidatePath), read(baselinePath));
  printResult(result);
  if (result.ok) {
    console.log('corpus gate passed');
    return 0;
  }

  console.error(`corpus gate failed: ${result.regressions.join(', ')}`);
  if (allowRegression) {
    console.error('WARNING: regression explicitly allowed; continuing');
    return 0;
  }
  return 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main(process.argv.slice(2));
