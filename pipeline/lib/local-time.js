// Sender-local timestamp resolver.
//
// `ts_iso` in the messages table is plain UTC (built via `new Date(m.ts).toISOString()`).
// That's correct as a storage canonical form but useless to a human reader, because
// "11pm I'm going to sleep" sent from Melbourne shows up as "13:00 UTC" in the raw.
//
// This module maps (canonical_id, ts) → the IANA tz that identity was in at that
// moment, plus a formatted local-time string. The rule table encodes location
// windows per identity. Unknown identities fall back to UTC and are visibly
// labelled `UTC?` so the gap is obvious.
//
// Identities not in the table can still be added in one place — IDENTITY_TZ_RULES
// below — without touching any caller.

// Canonical IDs (verified against pipeline/output/raw/messages.duckdb identities table):
//   id-751  Demo User         (the user)
//   id-1233 Maya Torres
//   id-1716 Jordan Blake
//
// DRIFT WARNING: canonical ids are NOT stable across db rebuilds — identity
// folds renumber them. Re-verified 2026-07-26: Demo is now id-753, Maya
// id-1242, Jordan id-1725 (the old ids now point at bare phone-number
// identities). The current ids are added as extra keys below; the old keys
// stay because older pipeline scripts still pass them.

/**
 * Each rule is { from?: ISO-date-or-null, to?: ISO-date-or-null, tz: IANA-string, label?: string }.
 * Windows are half-open [from, to). A null `from` means "since the beginning of time";
 * a null `to` means "until now". The first matching rule wins, so order matters only
 * when windows overlap (we keep them non-overlapping by construction).
 */
export const IDENTITY_TZ_RULES = {
  // Demo User — Australia until mid-2023, Chicago after.
  // (Akuna Sydney 2018-2023, Chicago 2023→; Melbourne/Sydney both AEST/AEDT.)
  'id-751': [
    { to: '2023-06-01', tz: 'Australia/Melbourne', label: 'AU' },
    { from: '2023-06-01', tz: 'America/Chicago', label: 'CHI' },
  ],

  // Example: a person with a home baseline plus dated windows abroad.
  // Each window is [from, to) in local dates; the last entry is the fallback.
  'id-1233': [
    { from: '2021-11-15', to: '2022-02-15', tz: 'Asia/Taipei', label: 'TPE' },
    { from: '2024-01-18', to: '2024-02-29', tz: 'Asia/Taipei', label: 'TPE' },
    { from: '2025-06-15', to: '2025-08-15', tz: 'Asia/Taipei', label: 'TPE' },
    { from: '2025-12-20', to: '2026-01-05', tz: 'Asia/Taipei', label: 'TPE' },
    { tz: 'Australia/Melbourne', label: 'MEL' },
  ],

  // Example: a person with a single, unchanging timezone.
  'id-1716': [
    { tz: 'Pacific/Auckland', label: 'AKL' },
  ],
};

// Current ids after the 2026-07 rebuild (see DRIFT WARNING above).
IDENTITY_TZ_RULES['id-753'] = IDENTITY_TZ_RULES['id-751'];   // Demo
IDENTITY_TZ_RULES['id-1242'] = IDENTITY_TZ_RULES['id-1233']; // Maya
IDENTITY_TZ_RULES['id-1725'] = IDENTITY_TZ_RULES['id-1716']; // Jordan

// Who the rule table covers, name → the key currently believed current.
// crm-relink's tz verifier resolves each name against the live identities
// and flags drift with a paste-ready re-key line.
export const TZ_RULE_PEOPLE = {
  'Demo User': 'id-753',
  'Maya Torres': 'id-1242',
  'Jordan Blake': 'id-1725',
};

// "me" is shorthand for the user (Demo). Most callers handle from_me=true
// separately and pass canonical_id for the other side; aliasing keeps things ergonomic.
IDENTITY_TZ_RULES['me'] = IDENTITY_TZ_RULES['id-751'];

const ABBREV_CACHE = new Map();

function tzAbbrev(tz, date) {
  const key = `${tz}|${date.getUTCFullYear()}|${date.getUTCMonth()}`;
  const cached = ABBREV_CACHE.get(key);
  if (cached) return cached;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short', hour: 'numeric',
    }).formatToParts(date);
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    const abbrev = tzPart ? tzPart.value : tz;
    ABBREV_CACHE.set(key, abbrev);
    return abbrev;
  } catch {
    return tz;
  }
}

function toMillis(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  if (typeof ts === 'string') {
    // Accept either a numeric string of ms OR an ISO string.
    if (/^\d+$/.test(ts)) return Number(ts);
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (ts instanceof Date) return ts.getTime();
  return null;
}

/**
 * Resolve the IANA tz an identity was in at a given moment.
 * @param {string} canonicalId  e.g. 'id-1233' or 'me'
 * @param {number|string|Date} ts  unix ms, ISO string, or Date
 * @returns {{ tz: string, label: string, source: 'rule'|'fallback' }}
 */
export function resolveTz(canonicalId, ts) {
  const rules = IDENTITY_TZ_RULES[canonicalId];
  const ms = toMillis(ts);
  if (!rules || ms == null) {
    return { tz: 'UTC', label: 'UTC?', source: 'fallback' };
  }
  const iso = new Date(ms).toISOString().slice(0, 10);
  for (const r of rules) {
    if (r.from && iso < r.from) continue;
    if (r.to && iso >= r.to) continue;
    return { tz: r.tz, label: r.label || r.tz, source: 'rule' };
  }
  return { tz: 'UTC', label: 'UTC?', source: 'fallback' };
}

/**
 * Format a single moment in one identity's local time.
 * @param {string} canonicalId
 * @param {number|string|Date} ts
 * @param {object} [opts]
 * @param {boolean} [opts.withTz=true]   include the tz abbreviation (e.g. " CDT")
 * @param {boolean} [opts.withDate=true] include the YYYY-MM-DD date
 * @param {boolean} [opts.withSeconds=false]
 * @returns {{ formatted: string, tz: string, label: string, source: string, iso: string }}
 */
export function formatLocal(canonicalId, ts, opts = {}) {
  const { withTz = true, withDate = true, withSeconds = false } = opts;
  const { tz, label, source } = resolveTz(canonicalId, ts);
  const ms = toMillis(ts);
  if (ms == null) {
    return { formatted: '(invalid ts)', tz, label, source, iso: '' };
  }
  const date = new Date(ms);

  // Build via formatToParts so we can produce a stable "YYYY-MM-DD HH:MM" layout
  // regardless of locale defaults.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  const datePart = `${parts.year}-${parts.month}-${parts.day}`;
  const timePart = withSeconds
    ? `${parts.hour}:${parts.minute}:${parts.second}`
    : `${parts.hour}:${parts.minute}`;
  // en-CA renders midnight as "24:00" rather than "00:00"; normalise.
  const safeTime = timePart.replace(/^24:/, '00:');

  // Prefer the system-resolved short tz abbreviation (CDT/AEST/NZDT). For zones
  // where Intl falls back to a numeric offset (e.g. "GMT+8" for Asia/Taipei),
  // use the rule-table label (TPE) — more informative for the human reader.
  let tzTag = tzAbbrev(tz, date);
  if (/^GMT[+-]\d/.test(tzTag) && label && label !== tz) tzTag = label;
  const abbrev = withTz ? ` ${tzTag}` : '';
  const formatted = withDate ? `${datePart} ${safeTime}${abbrev}` : `${safeTime}${abbrev}`;
  return { formatted, tz, label, source, iso: `${datePart}T${safeTime}` };
}

/**
 * Format both sides of a message — useful when sender and receiver are in
 * different tz. Returns something like:
 *   "2025-07-08 07:19 CDT (Demo) / 20:19 AEST (Maya)"
 * If both sides resolve to the same wall-clock string, returns just one side.
 *
 * @param {object} args
 * @param {string} args.fromId            canonical_id of the sender
 * @param {string} args.toId              canonical_id of the receiver
 * @param {number|string|Date} args.ts
 * @param {string} [args.fromName]        display name for the sender (cosmetic)
 * @param {string} [args.toName]          display name for the receiver (cosmetic)
 */
export function formatBoth({ fromId, toId, ts, fromName, toName }) {
  const a = formatLocal(fromId, ts);
  const b = formatLocal(toId, ts, { withDate: false });
  // If the two sides have the same wall-clock hour:minute AND same tz label,
  // collapse to one rendering.
  const aTime = a.formatted.split(' ').slice(1).join(' ');
  if (aTime === b.formatted && a.label === b.label) {
    return `${a.formatted}${fromName ? ` (${fromName})` : ''}`;
  }
  const fromTag = fromName ? ` (${fromName})` : '';
  const toTag = toName ? ` (${toName})` : '';
  return `${a.formatted}${fromTag} / ${b.formatted}${toTag}`;
}

/**
 * For ad-hoc use: given a message row (with ts, from_me, and a counterparty id),
 * return the formatted sender-local string. `meId` defaults to 'id-751' (Demo).
 */
export function formatMessageLocal(row, counterpartyId, opts = {}) {
  const { meId = 'id-751' } = opts;
  const senderId = row.from_me ? meId : counterpartyId;
  return formatLocal(senderId, row.ts, opts);
}
