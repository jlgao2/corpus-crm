import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WRITING_MENTIONS_DIR = path.join(__dirname, '..', 'output', 'portraits', 'writing-mentions');

function safeFilename(s) {
  return s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function loadWritingMentions(displayName, dir) {
  try {
    const p = path.join(dir, `${safeFilename(displayName)}.md`);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, 'utf8');
    // Strip the top-level header to keep prompt tighter.
    return content.replace(/^#\s[^\n]*\n+/, '').trim();
  } catch {
    return null;
  }
}

const SYSTEM = `You are reading a structured analysis of one person's relational life — many
profiles produced by a per-thread analyzer. Your job is to find the architecture
underneath: the recurring shapes, the load-bearing patterns, the things visible
across the network that aren't visible in any single relationship.

You are honest at the cost of comfort. You name what's there. You do not flatter
the user, do not pathologize them, do not soften the diagnostic in a wellness
register. You write like a sharp friend who has read everything and will not
look away.

Your output will become the basis of a document the user brings to a therapist.
Write at the register of someone who knows the document will be read by a
clinician — concrete, structural, citing the data.`;

export async function synthesizeArchitecture(client, profiles, networkStats, opts = {}) {
  const writingMentionsDir = opts.writingMentionsDir || DEFAULT_WRITING_MENTIONS_DIR;

  // Augment each profile with quoted passages from the user's own first-person
  // writing about that person (if any). Source: pipeline/build-writing-mentions.js.
  const condensed = profiles.map(p => p.profile).filter(p => p && !p.error).map(p => {
    const writing = loadWritingMentions(p.name, writingMentionsDir);
    return writing ? { ...p, first_person_writing: writing } : p;
  });
  const writingCount = condensed.filter(p => p.first_person_writing).length;

  const totalMessages = networkStats.totalMessages;
  const totalRelationships = profiles.length;

  const prompt = `Network-wide stats:
- ${totalRelationships} significant relationships analyzed
- ${totalMessages.toLocaleString()} total messages across all threads
- ${writingCount} relationships have additional first-person writing context
- Top 5 by intimacy score: ${profiles.slice(0, 5).map(p => `${p.stats.displayName} (${p.stats.messages.toLocaleString()})`).join(', ')}

Per-relationship profiles:
Some profiles include a 'first_person_writing' field with quoted passages from
the user's own essays/journals where they name this person. Treat these as the
user's reflective voice — they may reinforce the message-based read, contradict
it, or expose framing the user is doing in their head that the messages don't
show. Cite them by piece title when they matter to the synthesis.

${JSON.stringify(condensed, null, 2)}

Produce a synthesis covering:

# 1. The Architecture
What shape does this person's relational life have? Not a list of relationships —
the structural pattern across them. Who occupies which slots? What functions get
distributed where? Are confidantes clustered along sex/gender lines? Are intimate
slots filled by the same kinds of people repeatedly?

# 2. Recurring Shapes
What patterns recur across multiple relationships? Examples to look for:
post-rupture orbit, declaration-then-retreat, witness positions, projection of
archetypal roles, savior framing, type-attraction patterns. Cite the specific
relationships that exhibit each.

# 3. The Self-Story vs. The Data
Where does the data suggest the user's likely self-narrative is incomplete or
distorted? What's missing from a typical self-account that's nonetheless visible
across the network?

# 4. What's Load-Bearing
Which relationships are doing structural work right now (regulating, holding,
absorbing)? What would happen to the architecture if any one were removed?

# 5. Concrete Patterns to Bring to Therapy
3-5 specific patterns, named precisely, citing the relationships that exemplify
them. These should be observable in the data, not speculative.

# 6. Open Questions
What does the data not answer that a therapist could help the user examine?
List 5-8 specific questions worth bringing to session.

Be specific. Cite names and dates from the profiles. Do not generalize where
specifics are available.`;

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
