import { isMeaningfulMessage } from '../../normalize/schema.js';

const SYSTEM = `You are reading one chunk of an extended conversation between a user and one specific person in their life. Chunks are time-windowed (~3 months) and you receive prior chunk notes for context.

Your job: write a "chunk note" — 200-400 words capturing what this period of the relationship felt like.

Cover:
- Texture of this period: register, temperature, what kind of presence each person has in the other's life now.
- 2-4 specific moments that stand out, with verbatim quoted lines. Date each.
- What's shifting from prior chunks (if priors exist): new vocabulary, tone, in-jokes forming, things falling away.

You are a close reader. Not psychologizing. Describing texture, citing primary source. Write in the second person ("you" = the user).

Do not summarize messages. Do not list events. Capture what it FELT like to be in this conversation during this period, anchored in real quotes.`;

function formatMessage(m) {
  const date = new Date(m.ts).toISOString().slice(0, 10);
  const who = m.from === 'me' ? 'You' : 'Them';
  return `${date} ${who}: ${m.body.slice(0, 280).replace(/\n/g, ' ')}`;
}

/**
 * @param {Anthropic} client - Anthropic SDK instance
 * @param {{startTs: number, endTs: number, messages: Array}} chunk
 * @param {string[]} priorNotes - chunk notes from earlier chunks (chronological)
 * @returns {Promise<string>} the chunk note
 */
export async function generateChunkNote(client, chunk, priorNotes = []) {
  const meaningful = chunk.messages.filter(isMeaningfulMessage);
  if (meaningful.length === 0) return '';

  const fromUser = meaningful.filter(m => m.from === 'me').length;
  const fromThem = meaningful.length - fromUser;
  const periodFrom = new Date(chunk.startTs).toISOString().slice(0, 10);
  const periodTo = new Date(chunk.endTs).toISOString().slice(0, 10);

  // Cap input size: sample evenly if over 400 messages
  const sample = meaningful.length <= 400
    ? meaningful
    : Array.from({ length: 400 }, (_, i) => meaningful[Math.floor(i * meaningful.length / 400)]);

  const messageBlock = sample.map(formatMessage).join('\n');

  const priorBlock = priorNotes.length === 0
    ? '(this is the first chunk; no prior context)'
    : priorNotes.slice(-3)
        .map((n, i) => {
          const idx = priorNotes.length - Math.min(3, priorNotes.length) + i + 1;
          return `--- Prior chunk ${idx} ---\n${n}`;
        })
        .join('\n\n');

  const userMessage = `Period: ${periodFrom} → ${periodTo}
Messages this chunk: ${meaningful.length} (${fromUser} from you, ${fromThem} from them)

# Prior chunk notes
${priorBlock}

# Messages this chunk
${messageBlock}

# Output
Write the chunk note. Format:

Period: ${periodFrom} → ${periodTo}
Messages: ${meaningful.length} (${fromUser} from you, ${fromThem} from them)

Texture
<your description>

Standout moments
- YYYY-MM-DD — Them: "<exact line>" → You: "<exact line>" — <one-line context>

Shift from prior period
<one paragraph; or "first chunk" if no priors>`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text.trim();
}
