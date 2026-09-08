const SYSTEM = `You are the user's oldest, sharpest friend. They've described this person to you over years. You've now read field notes from a long conversation between them. Your job is to tell them back who this person is.

Texture first, structure later. Be the friend who reminds them of what's true. Don't psychoanalyze. Don't list patterns. Don't summarize the chat.

You may ONLY use quotes from the anchor allowlist provided. Do not paraphrase. Do not compose new quotes. If a quote isn't in the allowlist, do not use it.

CRITICAL: Quoted phrases anywhere in the portrait — including inside prose paragraphs — must come verbatim from the allowlist or from messages visible in the chunk notes. Do NOT use double-quote characters (" or ") around any phrase that you have invented or paraphrased. The verifier checks both blockquote-formatted lines AND any text appearing in double quotes anywhere in the document. A fabricated quote in prose will fail the same as a fabricated blockquote.

Quotes appear in the portrait formatted as:
> Them: <exact body from allowlist>
> You: <exact body from allowlist>

If you want to gesture at a phrase without quoting verbatim, use italics (single asterisks) or no markup at all — but never double quotes around invented language.

Output strictly the markdown portrait, no preamble or commentary.`;

function formatAnchor(a) {
  const lines = a.messages.map(m => {
    const speaker = m.from === 'me' ? 'You' : 'Them';
    return `> ${speaker}: ${m.body}`;
  }).join('\n');
  return `**${a.date}** — ${a.context}\n${lines}`;
}

/**
 * @param {Anthropic} client
 * @param {Object} args
 * @param {string} args.name
 * @param {string[]} args.sources
 * @param {number} args.messageCount
 * @param {string} args.dateRange - "YYYY-MM-DD → YYYY-MM-DD"
 * @param {string[]} args.chunkNotes
 * @param {{anchors: Array}} args.allowlist
 * @param {string} args.userNotes
 * @returns {Promise<string>} the portrait markdown
 */
export async function synthesizePortrait(client, args) {
  const { name, sources, messageCount, dateRange, chunkNotes, allowlist, userNotes = '', retryFeedback = '' } = args;

  const anchorBlock = allowlist.anchors.map(formatAnchor).join('\n\n');
  const notesBlock = chunkNotes.map((n, i) => `--- Chunk ${i + 1} ---\n${n}`).join('\n\n');
  const allFeedback = [userNotes.trim(), retryFeedback.trim()].filter(Boolean).join('\n\n');
  const userNotesBlock = allFeedback
    ? `\n# User feedback to incorporate this round\n${allFeedback}\n`
    : '';

  const today = new Date().toISOString().slice(0, 10);
  const anchorIds = allowlist.anchors.flatMap(a => a.messages.map(m => m.id));
  const anchorIdsYaml = '[' + anchorIds.map(id => `"${id}"`).join(', ') + ']';

  const frontmatter = `---
name: ${name}
generated: ${today}
sources: ${JSON.stringify(sources)}
message_count: ${messageCount}
date_range: ${dateRange}
chunks_synthesized: ${chunkNotes.length}
anchor_quote_ids: ${anchorIdsYaml}
user_notes: ${JSON.stringify((userNotes || '').slice(0, 500))}
---`;

  const userMessage = `# Person
${name}

# Anchor allowlist (the ONLY quotes you may use, verbatim)
${anchorBlock}

# Chunk notes
${notesBlock}
${userNotesBlock}

# Output
Produce the portrait markdown. Begin with this frontmatter exactly:

${frontmatter}

Then render these sections in order:

# ${name}
*<one-sentence essence — felt, not labelling>*

## Texture
<400-600 words on the music of being in this relationship — how they talk, what they care about, the temperature. Not how they function in your life — the quality.>

## Anchor moments
<5-10 dated quoted exchanges in chronological order. Each formatted as:

**YYYY-MM-DD**
> Them: <exact verbatim from allowlist>
> You: <exact verbatim from allowlist>
<one-line context if needed>

You may use only quotes from the allowlist. Pick the most resonant 5-10 from the list.>

## Recurring threads
<3-5 motifs (not patterns). E.g. "you've been talking about X since YEAR.">

## What care looks like with them
<200-300 words on the grammar of how care actually shows up between you two, specifically.>

## A line for them
<One sentence drawn from the portrait — recognizable, not invented.>`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text.trim();
}
