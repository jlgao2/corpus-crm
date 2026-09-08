const BLOCKQUOTE_RE = /^>\s*(Them|You|They|Me)\s*:\s*(.*)$/i;
// Match "..." or curly variants. 8-300 chars to avoid catching tiny words and overly long spans.
const PROSE_QUOTE_RE = /["“”]([^"“”]{8,300})["“”]/g;

export function extractQuotedLines(markdown) {
  const out = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = BLOCKQUOTE_RE.exec(line);
    if (m) {
      let speaker = m[1];
      if (/^Me$/i.test(speaker)) speaker = 'You';
      else if (/^They$/i.test(speaker)) speaker = 'Them';
      else speaker = speaker[0].toUpperCase() + speaker.slice(1).toLowerCase();
      out.push({ speaker, body: m[2].trim(), kind: 'blockquote' });
      continue;
    }
    // Prose quotes: scan within non-blockquote lines
    PROSE_QUOTE_RE.lastIndex = 0;
    let qm;
    while ((qm = PROSE_QUOTE_RE.exec(line)) !== null) {
      out.push({ speaker: null, body: qm[1].trim(), kind: 'prose' });
    }
  }
  return out;
}

function normalize(s) {
  return (s || '')
    // Strip iMessage exporter pollution that sometimes gets glued onto a message body:
    //   "...body text\nTapbacks:\nLoved by Me"  → keep only "...body text"
    //   "...body text\n    Jan 21, 2026  8:32:13 PM\n    Me\n..." → drop the timestamp continuation
    .replace(/\nTapbacks:[\s\S]*$/i, '')
    .replace(/\n[ \t]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}[\s\S]*$/i, '')
    // Curly quotes → straight (so Apple/iOS smart-quoted source matches portrait text and vice versa)
    .replace(/[‘’‚‛]/g, "'")    // ‘ ’ ‚ ‛
    .replace(/[“”„‟]/g, '"')    // “ ” „ ‟
    .replace(/[–—―]/g, '-')          // – — ―
    .replace(/[   ]/g, ' ')          // various non-breaking / narrow spaces
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Verify every quoted line in the portrait markdown appears verbatim
 * (whitespace-normalized) in the source messages.
 *
 * Blockquotes (`> Them: ...` / `> You: ...`) are speaker-checked.
 * Prose-embedded quotes (`"..."`) are checked speaker-agnostic — they must
 * appear in some message body, with any speaker.
 *
 * @param {string} markdown
 * @param {Array<{id: string, ts: number, from: 'me'|'them', body: string}>} messages
 * @returns {{ok: boolean, failures: Array<{speaker: string|null, body: string, kind: string}>}}
 */
export function verifyPortraitQuotes(markdown, messages) {
  const meIndex = new Set();
  const themIndex = new Set();
  const allIndex = new Set();
  for (const m of messages) {
    const k = normalize(m.body);
    if (m.from === 'me') meIndex.add(k);
    else themIndex.add(k);
    allIndex.add(k);
  }
  const quotes = extractQuotedLines(markdown);
  const failures = [];
  for (const q of quotes) {
    const k = normalize(q.body);
    if (!k) continue;
    let idx;
    if (q.kind === 'prose') idx = allIndex;
    else idx = q.speaker === 'You' ? meIndex : themIndex;
    if (!idx.has(k)) failures.push(q);
  }
  return { ok: failures.length === 0, failures };
}
