/**
 * Meetup-candidate detection over messages (heuristic half of the
 * message-inferred events layer — build-inferred-events.js owns the LLM
 * confirm + DuckDB writes).
 *
 * A candidate is a (thread, local-day) where someone said an
 * about-to-meet thing AND both sides were active that day. Precision comes
 * later from the confirm pass; this list just has to be cheap and not miss.
 */

// Word-bounded, matched against lowercased message text.
export const MEETUP_MARKERS = [
  /\bomw\b/, /\botw\b/, /\bon my way\b/,
  /\bi'?m here\b/, /\bwe'?re here\b/, /\bhere now\b/,
  /\bi'?m outside\b/, /\boutside now\b/, /\bout front\b/,
  /\bsee (?:you|u) (?:there|soon|at|in)\b/,
  /\bbe there (?:in|by|at)\b/,
  /\bleaving now\b/, /\bjust left\b/, /\balmost there\b/,
  /\bmins? away\b/, /\bminutes away\b/,
  /\bwhat'?s the address\b/, /\bsend (?:me )?the address\b/,
  /\brunning late\b/,
];

/**
 * @param {Array} messages - { id, ts, thread_id, from_me, body } (meaningful only)
 * @param {Object} opts
 * @param {(ts: number) => string} opts.dayKeyFn - ts -> local calendar day (YYYY-MM-DD).
 *   Callers bucket in Demo's local time (lib/local-time.js); tests inject UTC.
 * @returns {Array<{thread_id, day, start_ts, end_ts, message_ids, marker_ids, n_messages}>}
 */
/**
 * Window a candidate's messages around its first marker so a bounded prompt
 * always contains the meetup evidence (chatty days can bury an evening "omw"
 * hundreds of messages deep).
 */
export function confirmWindow(msgs, markerIds, cap = 60) {
  const markerSet = new Set(markerIds);
  const first = msgs.findIndex(m => markerSet.has(m.id));
  const start = first < 0 ? 0 : Math.max(0, Math.min(first - 20, msgs.length - cap));
  return msgs.slice(start, start + cap);
}

export function findMeetupCandidates(messages, { dayKeyFn } = {}) {
  if (typeof dayKeyFn !== 'function') throw new Error('findMeetupCandidates needs opts.dayKeyFn');

  const groups = new Map();
  for (const m of messages) {
    const key = `${m.thread_id}|${dayKeyFn(m.ts)}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(m);
  }

  const candidates = [];
  for (const [key, msgs] of groups) {
    msgs.sort((a, b) => a.ts - b.ts);
    const markers = msgs.filter(m => {
      // iOS smart punctuation sends U+2019 ("i’m here") — normalize before matching.
      const low = String(m.body || '').toLowerCase().replace(/[‘’]/g, "'");
      return MEETUP_MARKERS.some(re => re.test(low));
    });
    if (!markers.length) continue;
    if (!msgs.some(m => m.from_me) || !msgs.some(m => !m.from_me)) continue;

    const sep = key.lastIndexOf('|');
    candidates.push({
      thread_id: key.slice(0, sep),
      day: key.slice(sep + 1),
      start_ts: markers[0].ts,
      end_ts: msgs[msgs.length - 1].ts,
      message_ids: msgs.map(m => m.id),
      marker_ids: markers.map(m => m.id),
      n_messages: msgs.length,
    });
  }
  return candidates.sort((a, b) => a.start_ts - b.start_ts);
}
