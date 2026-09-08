import { chunkByTimeWindow } from './chunks.js';
import { generateChunkNote } from './chunk.js';
import { curateAnchorQuotes } from './curate.js';
import { synthesizePortrait } from './synthesize.js';
import { verifyPortraitQuotes } from './verify.js';

const MAX_VERIFY_ATTEMPTS = 3;

/**
 * @param {Anthropic} client
 * @param {Object} args
 * @param {{displayName: string, sources: string[]}} args.identity
 * @param {Array} args.messages - all messages for this person, chronological
 * @param {string} args.userNotes
 * @returns {Promise<{markdown: string, chunkNotes: string[], allowlist: Object, attempts: number, verified: boolean}>}
 */
export async function buildPortrait(client, args) {
  const { identity, messages, userNotes = '' } = args;
  const name = identity.displayName;

  // 1) Chunk
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  if (chunks.length === 0) throw new Error(`No messages for ${name}`);

  // 2) Pass 1: chunk notes (sequential, each sees priors)
  const chunkNotes = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`    chunk ${i + 1}/${chunks.length}...`);
    const note = await generateChunkNote(client, chunks[i], chunkNotes);
    chunkNotes.push(note);
    process.stdout.write(' ✓\n');
  }

  // 3) Pass 2: anchor allowlist
  process.stdout.write('    curating anchors... ');
  const allowlist = await curateAnchorQuotes(client, chunks, chunkNotes, { counterpartyId: identity.canonicalId });
  process.stdout.write(`${allowlist.anchors.length} anchors\n`);

  // 4) Pass 3 + verify (with retry)
  const allMessages = chunks.flatMap(c => c.messages);
  const dateRange = `${new Date(messages[0].ts).toISOString().slice(0, 10)} → ${new Date(messages[messages.length - 1].ts).toISOString().slice(0, 10)}`;

  let markdown = '';
  let verified = false;
  let attempts = 0;
  let retryFeedback = '';

  while (!verified && attempts < MAX_VERIFY_ATTEMPTS) {
    attempts++;
    process.stdout.write(`    synthesis attempt ${attempts}... `);
    markdown = await synthesizePortrait(client, {
      name,
      sources: identity.sources || [],
      messageCount: messages.length,
      dateRange,
      chunkNotes,
      allowlist,
      userNotes,        // clean, untouched across retries — used in frontmatter
      retryFeedback,    // grows on retry — used only in prompt body
    });
    const result = verifyPortraitQuotes(markdown, allMessages);
    if (result.ok) {
      verified = true;
      process.stdout.write('verified ✓\n');
    } else {
      process.stdout.write(`${result.failures.length} unverified quotes\n`);
      const failedList = result.failures
        .map(f => `  - ${f.kind === 'prose' ? 'prose-embedded quote' : f.speaker}: "${f.body}"`)
        .join('\n');
      retryFeedback = `PRIOR ATTEMPT used quotes that do not exist in the source messages. DO NOT use these — they were fabricated:\n${failedList}\n\nUse only quotes from the allowlist, verbatim. Do not embed double-quoted phrases in prose.`;
    }
  }

  if (!verified) {
    throw new Error(`Verification failed after ${attempts} attempts for ${name}`);
  }

  return { markdown, chunkNotes, allowlist, attempts, verified };
}
