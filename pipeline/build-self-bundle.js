#!/usr/bin/env node
/**
 * Build self_bundle.json — the daily-summary surface consumed by the
 * Prefrontal Cortex iOS app's Now/Plan tabs.
 *
 * Combines: today's top knot (from layer-2), top silent-and-strange gap,
 * one open question worth sitting with. The iOS app reads this on launch
 * (via a synced location or app-group share — that wiring lives in the
 * personal-data-ios repo).
 *
 * Output: pipeline/output/self_bundle.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const LATEST = path.join(ROOT, 'pipeline', 'output', 'self', 'runs', 'latest');
const GAPS_PATH = path.join(ROOT, 'pipeline', 'output', 'self', 'gaps.json');
const OUT_PATH = path.join(ROOT, 'pipeline', 'output', 'self_bundle.json');

function readJsonOrNull(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function pickKnotOfTheDay(knotsJson) {
  if (!knotsJson || !knotsJson.knots || !knotsJson.knots.length) return null;
  // Highest confidence × highest lens_count
  const ranked = [...knotsJson.knots].sort((a, b) => {
    const conf = { high: 3, medium: 2, low: 1 };
    const aS = (conf[a.confidence] || 1) * (a.lens_count || 1);
    const bS = (conf[b.confidence] || 1) * (b.lens_count || 1);
    return bS - aS;
  });
  // Pick a deterministic one based on the day-of-month so it doesn't change every layer-2 run
  const idx = new Date().getDate() % ranked.length;
  const k = ranked[idx];
  return {
    knot_id: k.knot_id,
    claim: k.claim,
    confidence: k.confidence,
    lens_count: k.lens_count,
    operational_move: k.operational_move,
    open_question: (k.open_questions || [])[0],
  };
}

function pickTopGap(gapsJson) {
  const items = gapsJson?.top || gapsJson?.items
    || (gapsJson && Array.isArray(gapsJson.candidates) ? gapsJson.candidates : null)
    || (Array.isArray(gapsJson) ? gapsJson : null);
  let pool = items;
  if (!pool && gapsJson) {
    for (const v of Object.values(gapsJson)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object' && 'name' in v[0]) {
        pool = v;
        break;
      }
    }
  }
  if (!pool || !pool.length) return null;
  // Top by score; pick the one with the cleanest signal (last_initiator=me, big drop_ratio)
  const top = pool[0];
  return {
    name: top.name || top.display_name,
    canonical_id: top.canonical_id,
    days_silent: Math.round(top.days_since_last || 0),
    historical_baseline_30d: Math.round(top.historical_baseline_30d || 0),
    last_initiator: top.last_initiator,
    texture: top.gap_texture,
  };
}

function pickOpenQuestion(knotsJson) {
  if (!knotsJson || !knotsJson.knots) return null;
  // Cycle through all open questions across knots, deterministic by day-of-month
  const all = [];
  for (const k of knotsJson.knots) {
    for (const q of (k.open_questions || [])) {
      all.push({ knot_id: k.knot_id, claim: k.claim, question: q });
    }
  }
  if (!all.length) return null;
  const idx = (new Date().getDate() * 7) % all.length;
  return all[idx];
}

function pickWhatsNew(diffJson) {
  if (!diffJson) return null;
  const newKnots = diffJson.knot_diff?.new || [];
  const newStrengths = diffJson.strength_diff?.new || [];
  const driftedKnots = diffJson.knot_diff?.drifted || [];
  const goneKnots = diffJson.knot_diff?.gone || [];
  // Top 3 NEW claims today, knots first then strengths
  const items = [];
  for (const n of newKnots) {
    items.push({ kind: 'knot', id: n.knot_id, claim: n.claim, confidence: n.confidence, lens_count: n.lens_count });
    if (items.length >= 3) break;
  }
  if (items.length < 3) {
    for (const n of newStrengths) {
      items.push({ kind: 'strength', id: n.strength_id, claim: n.claim, confidence: n.confidence, lens_count: n.lens_count });
      if (items.length >= 3) break;
    }
  }
  return {
    items,
    counts: {
      new_knots: newKnots.length,
      gone_knots: goneKnots.length,
      drifted_knots: driftedKnots.length,
      new_strengths: newStrengths.length,
    },
    yesterday_run: diffJson.yesterday_run || null,
  };
}

function pickStrengthOfTheDay(peaksJson) {
  if (!peaksJson || !peaksJson.strengths || !peaksJson.strengths.length) return null;
  const ranked = [...peaksJson.strengths].sort((a, b) => {
    const conf = { high: 3, medium: 2, low: 1 };
    const aS = (conf[a.confidence] || 1) * (a.lens_count || 1);
    const bS = (conf[b.confidence] || 1) * (b.lens_count || 1);
    return bS - aS;
  });
  // Day-of-month deterministic offset by 3 so it doesn't always pair with the same knot
  const idx = (new Date().getDate() + 3) % ranked.length;
  const s = ranked[idx];
  return {
    strength_id: s.strength_id,
    label: s.label,
    claim: s.claim,
    confidence: s.confidence,
    lens_count: s.lens_count,
    amplification_move: s.amplification_move,
    presence_signature: s.presence_signature,
  };
}

async function main() {
  const knots = readJsonOrNull(path.join(LATEST, 'knots.json'));
  const peaks = readJsonOrNull(path.join(LATEST, 'peaks.json'));
  const gaps = readJsonOrNull(GAPS_PATH);
  const diff = readJsonOrNull(path.join(LATEST, 'diff.json'));

  const bundle = {
    generated_at: new Date().toISOString(),
    schema_version: 3,
    knot_of_the_day: pickKnotOfTheDay(knots),
    strength_of_the_day: pickStrengthOfTheDay(peaks),
    top_gap: pickTopGap(gaps),
    today_question: pickOpenQuestion(knots),
    whats_new: pickWhatsNew(diff),
    sources: {
      knots_run: knots?.generated_at || null,
      knots_model: knots?.model || null,
      peaks_run: peaks?.generated_at || null,
      peaks_model: peaks?.model || null,
      gaps_run: gaps?.generated_at || null,
      diff_run: diff?.generated_at || null,
    },
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(bundle, null, 2));
  const wn = bundle.whats_new ? `whats_new=${bundle.whats_new.items.length}` : 'whats_new=none';
  console.log(`[self-bundle] knot=${bundle.knot_of_the_day?.knot_id || 'none'} strength=${bundle.strength_of_the_day?.strength_id || 'none'} gap=${bundle.top_gap?.name || 'none'} ${wn} → ${path.relative(ROOT, OUT_PATH)}`);
}

main().catch(err => { console.error('[self-bundle] fatal:', err); process.exit(1); });
