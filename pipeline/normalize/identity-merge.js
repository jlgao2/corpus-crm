/**
 * Cross-source identity merging.
 *
 * The base resolver in identity.js matches identities by alias-set overlap.
 * That misses cases where the same person has different aliases across
 * channels — e.g.
 *   id-115:  Robin         (instagram)
 *   id-1203: +155501001, Robin Vasquez  (imessage, vCard-resolved)
 *
 * This module runs as a post-pass against the DuckDB. It identifies
 * across-source identity pairs that almost certainly refer to the same
 * person, merges them, and rewrites all foreign-key tables.
 */

import fs from 'fs';
import path from 'path';

// Stop-words that should NEVER be the basis for a merge (too common, ambiguous).
const COMMON_FIRST_NAMES = new Set([
  'a', 'an', 'the', 'me', 'you', 'us', 'them', 'us', 'i',
  // single letters and short generic tokens
  'mom', 'dad', 'mum', 'son', 'wife', 'mr', 'mrs', 'dr', 'guy',
]);

function unwrapList(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.items)) return v.items;
  return [];
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  return normalize(s).split(' ').filter(t => t.length >= 2);
}

function isPhoneOrEmail(s) {
  if (!s) return false;
  const t = String(s).trim();
  return /^[+\d]/.test(t) || t.includes('@');
}

function isNamelike(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (isPhoneOrEmail(t)) return false;
  // Must have at least one letter
  if (!/\p{L}/u.test(t)) return false;
  return true;
}

/**
 * Score a candidate merge between two identities.
 *
 * Returns a number in [0, 1+] where higher means more confident:
 *   1.0 — display names share a full multi-token name (e.g., "Robin Vasquez" ↔ "Robin")
 *   0.7 — first-name match (single distinctive token)
 *   0   — no match
 */
function scorePair(a, b) {
  // Sources must be disjoint — only merge ACROSS channels
  const aSrc = new Set(unwrapList(a.sources));
  const bSrc = new Set(unwrapList(b.sources));
  for (const s of aSrc) if (bSrc.has(s)) return 0;

  const aNames = unwrapList(a.aliases).filter(isNamelike).concat(a.display_name).filter(Boolean);
  const bNames = unwrapList(b.aliases).filter(isNamelike).concat(b.display_name).filter(Boolean);
  if (!aNames.length || !bNames.length) return 0;

  // Multi-token containment — strong signal
  for (const an of aNames) {
    const aNorm = normalize(an);
    for (const bn of bNames) {
      const bNorm = normalize(bn);
      if (!aNorm || !bNorm) continue;
      const aToks = aNorm.split(' ').filter(t => t.length >= 2);
      const bToks = bNorm.split(' ').filter(t => t.length >= 2);
      if (aToks.length === 0 || bToks.length === 0) continue;

      // Exact equality
      if (aNorm === bNorm) return 1.0;

      // Multi-token: one is a contiguous prefix/suffix of the other
      // e.g., "robin vasquez" contains "robin"
      if (aToks.length >= 1 && bToks.length >= 1) {
        const longer = aToks.length >= bToks.length ? aToks : bToks;
        const shorter = aToks.length >= bToks.length ? bToks : aToks;
        // shorter must be a prefix of longer at the token level
        let ok = true;
        for (let i = 0; i < shorter.length; i++) {
          if (longer[i] !== shorter[i]) { ok = false; break; }
        }
        if (ok && shorter.length >= 1 && longer.length > shorter.length) {
          return 1.0;
        }
        if (ok && shorter.length >= 2) {
          return 1.0;
        }
      }
    }
  }

  // First-name only match — weaker signal. Require both sides to have
  // ONLY a single-token first name (or the first names match AND no last
  // name conflict).
  for (const an of aNames) {
    for (const bn of bNames) {
      const aT = tokens(an);
      const bT = tokens(bn);
      if (aT.length === 0 || bT.length === 0) continue;
      const aFirst = aT[0];
      const bFirst = bT[0];
      if (!aFirst || aFirst.length < 3) continue;
      if (COMMON_FIRST_NAMES.has(aFirst) || COMMON_FIRST_NAMES.has(bFirst)) continue;
      if (aFirst !== bFirst) continue;

      // First names match. If both sides have last names AND they conflict, reject.
      const aLast = aT.slice(1).join(' ');
      const bLast = bT.slice(1).join(' ');
      if (aLast && bLast && aLast !== bLast) continue;

      return 0.7;
    }
  }

  return 0;
}

/**
 * Pick the winner display name when merging two identities.
 *
 * Prefers the longer real name (more tokens, more letters).
 */
function chooseDisplayName(a, b) {
  const aN = a.display_name || '';
  const bN = b.display_name || '';
  if (isPhoneOrEmail(aN) && !isPhoneOrEmail(bN)) return bN;
  if (isPhoneOrEmail(bN) && !isPhoneOrEmail(aN)) return aN;
  const aTokens = tokens(aN).length;
  const bTokens = tokens(bN).length;
  if (aTokens !== bTokens) return aTokens > bTokens ? aN : bN;
  // Same token count — prefer longer
  return aN.length >= bN.length ? aN : bN;
}

/**
 * Determine the "best" full name for an identity — longest namelike alias.
 * Returns null if the identity has no namelike multi-token form.
 */
function bestFullName(id) {
  const all = unwrapList(id.aliases).filter(isNamelike).concat(id.display_name).filter(Boolean);
  let best = null;
  let bestTokens = 0;
  for (const n of all) {
    const t = tokens(n);
    if (t.length > bestTokens) { best = n; bestTokens = t.length; }
  }
  return { name: best, tokenCount: bestTokens };
}

/**
 * Find candidate merges across the full identity table.
 *
 * Disambiguation: within each first-name bucket, count how many distinct
 * multi-token full-name variants exist. If more than one (e.g., Alex Nguyen,
 * Alex Romero, Alex Petrakis), single-token identities ("Alex") in
 * the same bucket are AMBIGUOUS — we can't tell which one they refer to.
 *
 * @param {Array} identities - rows from `SELECT canonical_id, display_name, aliases, sources`
 * @param {object} opts
 * @param {number} opts.minMessages - require at least this many meaningful msgs
 *   on the smaller side (to filter out junk identities). Default 5.
 * @param {Map<string, number>} opts.messageCounts - canonical_id → message count
 * @returns {{ confident: Array, ambiguous: Array }}
 */
export function findMergeCandidates(identities, opts = {}) {
  const { minMessages = 5, messageCounts = new Map() } = opts;

  const sorted = [...identities].sort((a, b) => {
    const aN = messageCounts.get(a.canonical_id) || 0;
    const bN = messageCounts.get(b.canonical_id) || 0;
    return bN - aN;
  });

  const confident = [];
  const ambiguous = [];

  // Bucket by first-name token
  const buckets = new Map();
  for (const id of sorted) {
    const allNames = unwrapList(id.aliases).filter(isNamelike).concat(id.display_name).filter(Boolean);
    const firstTokens = new Set();
    for (const n of allNames) {
      const t = tokens(n);
      if (t[0] && t[0].length >= 3) firstTokens.add(t[0]);
    }
    for (const ft of firstTokens) {
      if (!buckets.has(ft)) buckets.set(ft, []);
      buckets.get(ft).push(id);
    }
  }

  const seenPairs = new Set();
  for (const [first, group] of buckets) {
    if (group.length < 2) continue;
    if (COMMON_FIRST_NAMES.has(first)) continue;

    // Categorize bucket members by whether they have a distinct full-name form
    // matching this first-name. A "multi-token" identity has a multi-word name
    // that starts with `first`. There may be multiple such identities in the
    // same bucket — that's the disambiguation problem.
    const fullNameVariants = new Set(); // unique full-name strings (e.g., "alex pham")
    for (const id of group) {
      const fn = bestFullName(id);
      if (fn.name && fn.tokenCount >= 2) {
        const norm = normalize(fn.name);
        if (norm.split(' ')[0] === first) fullNameVariants.add(norm);
      }
    }
    const multipleFullNames = fullNameVariants.size > 1;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (a.canonical_id === b.canonical_id) continue;
        const pairKey = [a.canonical_id, b.canonical_id].sort().join('|');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const aN = messageCounts.get(a.canonical_id) || 0;
        const bN = messageCounts.get(b.canonical_id) || 0;
        if (Math.min(aN, bN) < minMessages) continue;

        const score = scorePair(a, b);
        if (score === 0) continue;

        // Disambiguation: if the bucket has multiple distinct full-name variants
        // AND this pair involves a single-token side (i.e., one identity has only
        // a first-name with no last name distinguishing it from the others) →
        // demote to ambiguous.
        const aFn = bestFullName(a);
        const bFn = bestFullName(b);
        const eitherSingleToken = aFn.tokenCount < 2 || bFn.tokenCount < 2;
        const ambiguousByBucket = multipleFullNames && eitherSingleToken;

        // Also: if both sides have multi-token names but the LAST names differ →
        // not the same person despite first-name match.
        let lastNameConflict = false;
        if (aFn.tokenCount >= 2 && bFn.tokenCount >= 2) {
          const aLast = normalize(aFn.name).split(' ').slice(1).join(' ');
          const bLast = normalize(bFn.name).split(' ').slice(1).join(' ');
          if (aLast && bLast && aLast !== bLast) lastNameConflict = true;
        }
        if (lastNameConflict) continue;  // skip entirely

        const winner = aN >= bN ? a : b;
        const loser  = aN >= bN ? b : a;
        const merge = {
          winner_id: winner.canonical_id,
          loser_id: loser.canonical_id,
          winner_name: winner.display_name,
          loser_name: loser.display_name,
          winner_msgs: messageCounts.get(winner.canonical_id) || 0,
          loser_msgs: messageCounts.get(loser.canonical_id) || 0,
          winner_sources: unwrapList(winner.sources),
          loser_sources: unwrapList(loser.sources),
          score,
          merged_display_name: chooseDisplayName(winner, loser),
        };
        if (score >= 1.0 && !ambiguousByBucket) confident.push(merge);
        else ambiguous.push(merge);
      }
    }
  }
  return { confident, ambiguous };
}

/**
 * Apply explicit merges from a manual override file.
 *
 * Format:
 *   { "merges": [ { "canonical": "Display Name", "aliases": ["...","..."] } ] }
 *
 * For each merges[i]:
 *   - Find the identity with display_name OR alias matching `canonical`
 *   - For each `alias` in aliases, find any other identity matching it
 *   - Merge each match into the canonical (canonical wins display_name)
 *
 * @returns {Array} pseudo-merge records compatible with applyMerges
 */
export function manualMerges(identities, manualConfig) {
  if (!manualConfig || !Array.isArray(manualConfig.merges)) return [];
  const out = [];
  const findByName = (name) => {
    const lc = String(name || '').toLowerCase();
    return identities.find(id =>
      (id.display_name || '').toLowerCase() === lc
      || unwrapList(id.aliases).some(a => String(a).toLowerCase() === lc)
    );
  };
  for (const m of manualConfig.merges) {
    const canonical = findByName(m.canonical);
    if (!canonical) continue;
    for (const alias of (m.aliases || [])) {
      const other = findByName(alias);
      if (!other || other.canonical_id === canonical.canonical_id) continue;
      out.push({
        winner_id: canonical.canonical_id,
        loser_id: other.canonical_id,
        winner_name: canonical.display_name,
        loser_name: other.display_name,
        winner_sources: unwrapList(canonical.sources),
        loser_sources: unwrapList(other.sources),
        score: 999,  // manual override — always wins
        merged_display_name: m.canonical,
        manual: true,
      });
    }
  }
  return out;
}
