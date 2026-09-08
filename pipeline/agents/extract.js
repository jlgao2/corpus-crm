import Anthropic from '@anthropic-ai/sdk';
import { chronologicalSample, scanThread, lateNightSample } from '../analyze/keywords.js';

const SYSTEM = `You are a relationship analyst with a steady, honest register.
You read message data about one specific person in someone's life and produce a
structured profile that captures the truth of that relationship — not sentiment, not
flattery, not pathology. The shape and texture of how it actually functions.

You are direct. You name what you see including patterns the person under analysis
may not have wanted named. You do not psychologize about people who aren't in front
of you (the third party in the chat) — you describe behavior and signals only.

Return valid JSON only. No markdown fences. No commentary outside the JSON.`;

export async function extractProfile(client, profile, messages, scan) {
  const sample = chronologicalSample(messages, 80);
  const lateNight = lateNightSample(messages, 6);

  const prompt = `Analyze the relationship between the user and ${profile.displayName}.

# Stats
${JSON.stringify({
  messages: profile.messages,
  fromMe: profile.fromMe,
  fromThem: profile.fromThem,
  reciprocity: profile.reciprocity.toFixed(2),
  spanDays: profile.spanDays,
  density: profile.density.toFixed(1),
  lateNightRatio: profile.lateNightRatio.toFixed(2),
  daysSinceLast: profile.daysSinceLast,
  firstMessage: profile.firstISO,
  lastMessage: profile.lastISO,
  byYear: profile.byYear,
  sources: profile.sources,
}, null, 2)}

# Charged-language hits (categories: ${Object.keys(scan).join(', ')})
${Object.entries(scan)
  .filter(([, arr]) => arr.length > 0)
  .map(([cat, arr]) => `\n## ${cat} (${arr.length})\n` + arr.slice(0, 6).map(m => `  ${new Date(m.ts).toISOString().slice(0, 10)} ${m.from === 'me' ? 'ME' : 'THEM'}: ${m.body}`).join('\n'))
  .join('\n')}

# Late-night sample (${lateNight.length})
${lateNight.map(m => `  ${new Date(m.ts).toISOString().slice(0, 10)} ${m.from === 'me' ? 'ME' : 'THEM'}: ${m.body}`).join('\n')}

# Chronological sample (${sample.length} messages, first → middle → last)
${sample.map(m => `  ${new Date(m.ts).toISOString().slice(0, 10)} ${m.from === 'me' ? 'ME' : 'THEM'}: ${m.body.slice(0, 200)}`).join('\n')}

Produce JSON with this shape:
{
  "name": "${profile.displayName}",
  "kind": "<one of: partner-current, partner-past, romantic-interest, close-friend, confidante, family, casual-friend, professional, ambiguous>",
  "summary": "2-3 sentence honest description of who this person is in the user's life. Specific. No platitudes.",
  "shape": {
    "trajectory": "<one of: building, peak, plateau, declining, dormant, ended, reactivating, post-breakup-orbit>",
    "balance": "<one of: mutual, user-pursues-more, person-pursues-more, asymmetric-in-time, even-but-tense>",
    "register": "<one of: light-banter, intellectual-sparring, daily-domestic, vulnerable-confidante, romantic, post-romantic, professional>"
  },
  "peak_period": { "from": "YYYY-MM", "to": "YYYY-MM" },
  "loaded_moments": [
    { "date": "YYYY-MM-DD", "summary": "One-line description of a specific charged exchange, with date." }
  ],
  "what_user_does_with_this_person": "Behavioral pattern — what does the user TYPICALLY do in this relationship? E.g., 'processes other women's romantic patterns', 'goes hot-then-distant after intimate moments', etc.",
  "what_person_does_with_user": "Same, from the other side.",
  "unsaid": "What appears to be present but never directly named in the data. Empty string if nothing.",
  "concern_level": "<one of: low, moderate, high>",
  "concern_note": "If concern is non-low, one sentence on why. Else empty string."
}

Be specific. Cite the data. Do not flatter either party.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  try {
    return JSON.parse(clean);
  } catch (err) {
    return { error: err.message, raw: text };
  }
}

export async function extractAllProfiles(profiles, byIdentity, opts = {}) {
  const { concurrency = 4, max = 15 } = opts;
  const client = new Anthropic();
  const targets = profiles.slice(0, max);
  const results = [];

  // Run in chunks of `concurrency`
  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    const out = await Promise.all(batch.map(async (p) => {
      const entry = byIdentity.get(p.canonicalId);
      const scan = scanThread(entry.allMessages);
      console.log(`  extracting profile: ${p.displayName} (${p.messages} msgs)`);
      try {
        const profile = await extractProfile(client, p, entry.allMessages, scan);
        return { stats: p, profile };
      } catch (err) {
        console.error(`  failed for ${p.displayName}: ${err.message}`);
        return { stats: p, profile: { error: err.message } };
      }
    }));
    results.push(...out);
  }

  return results;
}
