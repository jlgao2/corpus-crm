import { isMeaningfulMessage } from '../../normalize/schema.js';
import { formatLocal } from '../../lib/local-time.js';

const SYSTEM = `You are curating an anchor-quote allowlist for a relationship portrait. You have:
- All chunk notes for one relationship (chronological).
- A sampled source message log (each line tagged with an ID and date).

Your job: pick 8-15 anchor moments that capture the most resonant quotes — the ones that reveal who this person is, how they care, what makes the relationship specific. Spread chronologically (don't cluster all in one period).

Each anchor moment may contain 1-2 messages (a quote + its reply, or just one decisive line). Use ONLY messages from the source log — verbatim, with their real IDs. The schema is forward-compatible with photos and location data; for now, only the messages field is required.

Return JSON only, no markdown fences. Schema:

{
  "anchors": [
    {
      "date": "YYYY-MM-DD",
      "context": "one-line context — what was happening",
      "messages": [
        { "id": "<exact id from source>", "ts": <unix-ms>, "from": "me|them", "body": "<verbatim>" }
      ]
    }
  ]
}

Rules:
- Prefer quotes that surprise or reveal. Avoid generic banter.
- Spread across years/seasons.
- Verbatim only — no paraphrasing, no edits.
- IDs must come from the source log. Do not invent.`;

function formatLogLine(m, counterpartyId) {
  // Tag each line with the sender's local time, so anchor quotes the curator
  // picks can be cited at the actual hour the message was sent (e.g. an 11pm
  // goodnight rather than its UTC mid-afternoon shadow). Falls back to UTC if
  // we don't have a rule for the identity.
  const senderId = m.from === 'me' ? 'id-751' : counterpartyId;
  const { formatted, label } = formatLocal(senderId, m.ts);
  const who = m.from === 'me' ? 'YOU' : 'THEM';
  const tag = label === 'UTC?' ? `${formatted}Z` : formatted;
  return `[${m.id}] ${tag} ${who}: ${m.body.slice(0, 280).replace(/\n/g, ' ')}`;
}

/**
 * @param {Anthropic} client
 * @param {Array<{startTs, endTs, messages}>} chunks
 * @param {string[]} chunkNotes - notes from Pass 1
 * @param {{counterpartyId?: string}} [opts]  canonical_id of the non-user party — drives sender-local time formatting
 * @returns {Promise<{anchors: Array}>}
 */
export async function curateAnchorQuotes(client, chunks, chunkNotes, opts = {}) {
  const { counterpartyId } = opts;
  const allMessages = chunks.flatMap(c => c.messages).filter(isMeaningfulMessage);

  // Cap source log to ~600 lines for context budget; sample evenly
  const sampleSize = Math.min(allMessages.length, 600);
  const step = allMessages.length / sampleSize;
  const sampled = Array.from({ length: sampleSize }, (_, i) => allMessages[Math.floor(i * step)]);
  const sourceLog = sampled.map(m => formatLogLine(m, counterpartyId)).join('\n');

  const notesBlock = chunkNotes.map((n, i) => `--- Chunk ${i + 1} ---\n${n}`).join('\n\n');

  const userMessage = `# Chunk notes (${chunkNotes.length})
${notesBlock}

# Source message log (sampled, ${sampled.length} of ${allMessages.length})
${sourceLog}

# Output
Return the anchor allowlist as JSON.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text.trim();
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Curator returned non-JSON: ${err.message}\nRaw: ${text.slice(0, 200)}`);
  }
  if (!parsed.anchors || !Array.isArray(parsed.anchors)) {
    throw new Error('Curator JSON missing anchors array');
  }
  return parsed;
}
