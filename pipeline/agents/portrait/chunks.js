const ONE_DAY_MS = 86400 * 1000;

/**
 * Split messages into time-window chunks.
 *
 * @param {Array} messages - Sorted by ts ascending.
 * @param {Object} opts
 * @param {number} opts.windowDays - Target window size (default 90 = ~3 months).
 * @param {number} opts.maxPerChunk - If a window has more, split it (default 600).
 * @param {number} opts.minPerChunk - If fewer, merge with previous (default 5).
 * @returns {Array<{startTs: number, endTs: number, messages: Array}>}
 */
export function chunkByTimeWindow(messages, opts = {}) {
  const { windowDays = 90, maxPerChunk = 600, minPerChunk = 5 } = opts;
  if (messages.length === 0) return [];

  const windowMs = windowDays * ONE_DAY_MS;

  // 1) Bucket by fixed time windows aligned to first message
  const start = messages[0].ts;
  const buckets = [];
  for (const m of messages) {
    const idx = Math.floor((m.ts - start) / windowMs);
    while (buckets.length <= idx) {
      const ws = start + buckets.length * windowMs;
      buckets.push({ startTs: ws, endTs: ws + windowMs, messages: [] });
    }
    buckets[idx].messages.push(m);
  }

  // 2) Split dense buckets that exceed maxPerChunk
  const split = [];
  for (const b of buckets) {
    if (b.messages.length === 0) continue;
    if (b.messages.length <= maxPerChunk) {
      split.push(b);
      continue;
    }
    const parts = Math.ceil(b.messages.length / maxPerChunk);
    const partSize = Math.ceil(b.messages.length / parts);
    for (let i = 0; i < parts; i++) {
      const sub = b.messages.slice(i * partSize, (i + 1) * partSize);
      if (sub.length === 0) continue;
      split.push({
        startTs: sub[0].ts,
        endTs: sub[sub.length - 1].ts + 1,
        messages: sub,
      });
    }
  }

  // 3) Merge sparse chunks: if the *current* chunk is below threshold and a
  //    previous chunk exists, fold it into the previous one. This handles
  //    both chronic sparseness and a sparse tail after dense periods.
  const merged = [];
  for (const b of split) {
    if (merged.length > 0 && b.messages.length < minPerChunk) {
      const prev = merged[merged.length - 1];
      prev.messages.push(...b.messages);
      prev.endTs = b.endTs;
    } else {
      merged.push({ ...b, messages: [...b.messages] });
    }
  }

  return merged;
}
