// Incremental-export date logic for meta-dyi.mjs.
//
// The corpus is the source of truth: we already know the timestamp of the last
// message we ingested per source, so a fresh DYI export only needs everything
// since then. No separate cutoff bookkeeping — if an export fails, the next run
// recomputes the same gap from the data and self-heals.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, 'output', 'raw', 'messages.duckdb');
const DAY = 86_400_000;

// Back the corpus max off by a small margin so late-arriving messages and
// clock skew across the export boundary can't open a gap. The overlap is
// harmless — the messenger ingester dedupes on message id.
export function computeSinceMs({ maxTsMs, marginDays = 2 }) {
  if (maxTsMs == null) return null; // no data for this source yet → full export
  return maxTsMs - marginDays * DAY;
}

// Meta's DYI date control is radio presets (Last week … Last 3 years, All
// time). Pick the smallest one that still covers the whole gap since `sinceMs`.
// Over-fetching is fine (the ingester dedupes on id); under-fetching would
// silently lose messages, so the day thresholds sit safely below each preset's
// real span (calendar months vary in length).
export function pickPreset(sinceMs, nowMs) {
  if (sinceMs == null) return 'all';
  const gap = nowMs - sinceMs;
  if (gap <= 7 * DAY) return 'last-week';
  if (gap <= 28 * DAY) return 'last-month';
  if (gap <= 88 * DAY) return 'last-3-months';
  if (gap <= 180 * DAY) return 'last-6-months';
  if (gap <= 364 * DAY) return 'last-year';
  if (gap <= 1094 * DAY) return 'last-3-years';
  return 'all';
}

// Latest message timestamp (unix ms) already in the corpus for a source, or
// null if none. Source is whitelisted rather than bound so we can skip the
// prepared-statement API and stay injection-safe.
export async function getMaxTs(source, dbPath = DEFAULT_DB) {
  if (!/^[a-z_]+$/.test(source)) throw new Error(`bad source: ${source}`);
  const inst = await DuckDBInstance.create(dbPath, { access_mode: 'READ_ONLY' });
  const conn = await inst.connect();
  const rows = await (
    await conn.run(`select max(ts)::BIGINT as max_ts from messages where source = '${source}'`)
  ).getRows();
  const v = rows?.[0]?.[0];
  return v == null ? null : Number(v);
}
