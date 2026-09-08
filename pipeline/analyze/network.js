import { isMeaningfulMessage } from '../normalize/schema.js';

const ONE_DAY = 86400 * 1000;
const ONE_HOUR = 3600 * 1000;

/**
 * Compute per-person stats and rank by intimacy signals.
 *
 * Signals (each contributes to a composite intimacy score):
 *   - Volume of meaningful messages
 *   - Span of relationship (days from first → last)
 *   - Density (messages per active day)
 *   - Late-night ratio (messages 11pm-4am)
 *   - Median response time (faster = closer)
 *   - Reciprocity (closer to 50/50 = more mutual)
 *   - Recency (last message within last 30 days)
 */

function isoDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function isLateNight(ts) {
  const h = new Date(ts).getHours();
  return h >= 23 || h < 4;
}

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function analyzeRelationship(entry) {
  const msgs = entry.allMessages.filter(isMeaningfulMessage);
  if (msgs.length === 0) return null;

  const first = msgs[0].ts;
  const last = msgs[msgs.length - 1].ts;
  const spanDays = Math.max(1, Math.round((last - first) / ONE_DAY));

  // Per-day buckets
  const byDay = new Map();
  for (const m of msgs) {
    const k = isoDate(m.ts);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }
  const activeDays = byDay.size;
  const density = msgs.length / activeDays;

  // Reciprocity
  const fromMe = msgs.filter(m => m.from === 'me').length;
  const fromThem = msgs.length - fromMe;
  const reciprocity = msgs.length > 0
    ? 1 - Math.abs(fromMe - fromThem) / msgs.length
    : 0;

  // Late-night ratio
  const lateNight = msgs.filter(m => isLateNight(m.ts)).length;
  const lateNightRatio = lateNight / msgs.length;

  // Response times: time between consecutive messages where sender flips
  const responseTimes = [];
  for (let i = 1; i < msgs.length; i++) {
    const a = msgs[i - 1], b = msgs[i];
    if (a.from !== b.from) {
      const dt = b.ts - a.ts;
      if (dt > 0 && dt < ONE_DAY) responseTimes.push(dt);
    }
  }
  const medianResponseMs = median(responseTimes);

  // Recency
  const now = Date.now();
  const daysSinceLast = (now - last) / ONE_DAY;
  const recencyBonus = daysSinceLast < 30 ? 1 : daysSinceLast < 180 ? 0.5 : 0.1;

  // By-year volume
  const byYear = {};
  for (const m of msgs) {
    const y = new Date(m.ts).getFullYear();
    byYear[y] = (byYear[y] || 0) + 1;
  }

  // Intimacy score (rough composite — used for ranking only)
  const score =
    Math.log10(msgs.length + 1) * 10 +
    Math.log10(spanDays + 1) * 5 +
    density * 0.5 +
    lateNightRatio * 20 +
    reciprocity * 15 +
    recencyBonus * 10 -
    (medianResponseMs ? Math.log10(medianResponseMs / 1000 + 1) : 0);

  return {
    canonicalId: entry.identity.canonicalId,
    displayName: entry.identity.displayName,
    aliases: entry.identity.aliases,
    sources: entry.sources,
    messages: msgs.length,
    fromMe,
    fromThem,
    reciprocity,
    spanDays,
    activeDays,
    density,
    lateNightRatio,
    medianResponseMin: medianResponseMs ? Math.round(medianResponseMs / 60000) : null,
    daysSinceLast: Math.round(daysSinceLast),
    firstISO: isoDate(first),
    lastISO: isoDate(last),
    byYear,
    intimacyScore: Math.round(score * 10) / 10,
  };
}

export function rankRelationships(byIdentity, limit = 30) {
  const profiles = [];
  for (const entry of byIdentity.values()) {
    const p = analyzeRelationship(entry);
    if (p) profiles.push(p);
  }
  profiles.sort((a, b) => b.intimacyScore - a.intimacyScore);
  return profiles.slice(0, limit);
}
