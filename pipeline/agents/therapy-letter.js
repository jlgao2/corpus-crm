import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `You are producing a document a person will hand to a therapist on day one of
working together. The therapist will read this before the first session.

Tone: direct, structural, citing data. The therapist needs to know the shape of
the person's life — not their feelings, not their self-story, not advice for
what to do. The shape. The clinician will form their own clinical hypotheses.

You are not the therapist. You are the chart. Be useful by being precise.

The document is for the clinician but written in second person ("you") because
the user will also read it. It must withstand the user's eye without softening.
The user has chosen to bring it. Do not flinch.

Length: 3-5 pages of dense markdown. Headers, bullet lists, specific names and
dates. No padding. No platitudes. No "you are not alone" prose. No prescriptions.`;

export async function writeTherapyLetter(client, profiles, synthesis, networkStats) {
  const profileDigest = profiles
    .filter(p => p.profile && !p.profile.error)
    .map(p => ({
      name: p.stats.displayName,
      kind: p.profile.kind,
      messages: p.stats.messages,
      span: `${p.stats.firstISO} → ${p.stats.lastISO}`,
      summary: p.profile.summary,
      shape: p.profile.shape,
      what_user_does: p.profile.what_user_does_with_this_person,
      what_person_does: p.profile.what_person_does_with_user,
      unsaid: p.profile.unsaid,
      concern_level: p.profile.concern_level,
      concern_note: p.profile.concern_note,
    }));

  const prompt = `You have access to:

# Network stats
- ${profiles.length} significant relationships analyzed
- ${networkStats.totalMessages.toLocaleString()} total messages
- Date range: ${networkStats.firstISO} to ${networkStats.lastISO}

# Architecture synthesis (already produced)
${synthesis}

# Per-relationship profiles
${JSON.stringify(profileDigest, null, 2)}

Now write the therapy starting point document. Structure:

---

# Therapy Starting Point

## Read me first
A short paragraph framing what this is, what it isn't, and how to use it.

## At a glance
Bullets: number of significant relationships, date range, one-line summary of
the architecture, one-line summary of the most important pattern.

## The cast
A condensed table of the top 10-15 people in the user's life, with each one's
role/function in one line. Include start year, last contact, one-word relational
shape (e.g., "post-rupture orbit", "long-running confidante", "ambiguous
romantic"). The therapist should be able to scan this once and know who's who.

## The architecture
2-3 paragraphs describing the structural pattern of the user's relational life.
Distilled from the synthesis. Not a list — prose that captures the shape.

## Recurring patterns
3-5 named patterns, each with:
- Name (short, specific, no jargon)
- 1-2 sentence description
- Specific relationships that exemplify it (with names)
- Approximate first appearance in the data

## What's likely missing from the user's self-story
2-3 specific things the data shows that the user is unlikely to spontaneously
bring to a session. Not psychoanalysis — just observations of structural facts
that are easy to overlook from inside.

## Live tensions
2-3 currently active relational situations the therapist should know about.
Concrete. Names. Status as of the most recent data.

## Questions worth asking in session 1-3
5-8 specific questions. Not generic ("how do you feel about that") — specific
to what the data shows. Each question should be answerable in one session and
move the work forward.

## What this document is not
A short closing reminder of the limits of this analysis.

---

Constraints:
- Use specific names and dates from the profiles. Do not generalize when
  specifics exist.
- Mark anything inferred (vs. cited) as "inferred from pattern X."
- Do not include the user's own quotes or messages — the therapist will hear
  those in session.
- 3-5 pages of dense markdown. No more.`;

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  let full = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      full += event.delta.text;
      process.stdout.write(event.delta.text);
    }
  }
  console.log('\n');
  await stream.finalMessage();
  return full;
}
