import { isMeaningfulMessage } from '../normalize/schema.js';

/**
 * Loaded-language scan. Surface the charged moments from a thread.
 *
 * Categories are designed to capture the kinds of content that show up
 * in real intimate communication — not generic sentiment, but the specific
 * words that signal relational charge, romantic feeling, conflict, vulnerability.
 */

export const PATTERNS = {
  declaration: /\b(i love you|i'?m in love|in love with you|love u georgey|i want you|date me|would you date|will you|marry me|be with me)\b/i,
  attraction: /\b(crush|attracted|hot|gorgeous|beautiful|sexy|fall(?:ing)? for|fell for|i fancy)\b/i,
  vulnerability: /\b(i'?m scared|i'?m afraid|i feel alone|lonely|i miss you|i'?m sorry|forgive me|ashamed|guilty|guilt|i was wrong)\b/i,
  conflict: /\b(we need to talk|i'?m angry|frustrat|fight|argument|hurt me|disappointed|breakup|broke up|broken up|over it|over you|done with this)\b/i,
  patterns: /\b(pattern|orbit|witness|cuck|core|substance|projection|projecting|attachment style|avoidant|anxious)\b/i,
  reflection: /\b(i think i|realize|realising|realizing|noticed that i|been thinking about|on my mind)\b/i,
  care: /\b(are you ok|you ok|are u ok|hope you|take care|here for you|i got you|i'?m here|sending love|thinking of you|proud of you|missed you)\b/i,
  body: /\b(sick|fever|surgery|hospital|injury|hurt my|broke my|sprain|tear|tendon)\b/i,
};

export function scanThread(messages, opts = {}) {
  const { perCategoryLimit = 12 } = opts;
  const results = {};
  for (const cat of Object.keys(PATTERNS)) results[cat] = [];

  for (const m of messages) {
    if (!isMeaningfulMessage(m)) continue;
    const body = m.body || '';
    if (body.length < 10 || body.length > 400) continue;
    for (const [cat, rx] of Object.entries(PATTERNS)) {
      if (rx.test(body)) {
        results[cat].push({
          ts: m.ts,
          from: m.from,
          senderName: m.senderName,
          body: body.slice(0, 280),
        });
      }
    }
  }

  // Trim to top-N per category, preferring chronologically-spread examples
  for (const cat of Object.keys(results)) {
    const arr = results[cat];
    if (arr.length <= perCategoryLimit) continue;
    const step = arr.length / perCategoryLimit;
    const sampled = [];
    for (let i = 0; i < perCategoryLimit; i++) {
      sampled.push(arr[Math.floor(i * step)]);
    }
    results[cat] = sampled;
  }

  return results;
}

export function lateNightSample(messages, n = 10) {
  const meaningful = messages.filter(isMeaningfulMessage).filter(m => {
    const h = new Date(m.ts).getHours();
    return (h >= 23 || h < 4) && m.body && m.body.length > 30 && m.body.length < 280;
  });
  if (meaningful.length <= n) return meaningful;
  const step = meaningful.length / n;
  return Array.from({ length: n }, (_, i) => meaningful[Math.floor(i * step)]);
}

export function chronologicalSample(messages, n = 80) {
  const meaningful = messages.filter(isMeaningfulMessage).filter(m => m.body && m.body.length > 15);
  if (meaningful.length <= n) return meaningful;
  // Sample first 25%, middle 50%, last 25%
  const out = [];
  const firstN = Math.floor(n * 0.25);
  const midN = Math.floor(n * 0.5);
  const lastN = n - firstN - midN;
  out.push(...meaningful.slice(0, firstN));
  const mid = Math.floor(meaningful.length / 2);
  out.push(...meaningful.slice(mid - Math.floor(midN / 2), mid + Math.ceil(midN / 2)));
  out.push(...meaningful.slice(-lastN));
  return out;
}
