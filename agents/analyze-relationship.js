/**
 * Multi-agent relationship analysis
 *
 * Agent 1 — claude-sonnet-4-6
 *   Loads Instagram export data and parses it into structured relationship signals.
 *
 * Agent 2 — claude-opus-4-7
 *   Takes the structured signals and synthesizes a deep understanding of the
 *   relationship with the target IG handle.
 *
 * Set TARGET and EXPORT_DIR via env, e.g.:
 *   TARGET=their.handle EXPORT_DIR=instagram-yourhandle-YYYY-MM-DD-xxxx \
 *     node agents/analyze-relationship.js
 *
 * NOTE: Superseded by ../pipeline/cli.js for full network analysis.
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TARGET = process.env.TARGET || 'their.handle';
const EXPORT_DIR = process.env.EXPORT_DIR || 'instagram-yourhandle-YYYY-MM-DD-xxxx';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// ─── Data Loading ─────────────────────────────────────────────────────────────

function readJSON(relPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf-8'));
  } catch {
    return null;
  }
}

function containsTarget(obj) {
  return JSON.stringify(obj).includes(TARGET);
}

function collectRawData() {
  // DM thread (two files cover the full history)
  const thread1 = readJSON(`${EXPORT_DIR}/your_instagram_activity/messages/inbox/1804085387649692/message_1.json`);
  const thread2 = readJSON(`${EXPORT_DIR}/your_instagram_activity/messages/inbox/1804085387649692/message_2.json`);

  const allMessages = [
    ...(thread1?.messages ?? []),
    ...(thread2?.messages ?? []),
  ].sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  // Summarise each message (drop heavy binary fields)
  const summarise = (m) => ({
    sender: m.sender_name,
    time: new Date(m.timestamp_ms).toISOString(),
    text: m.content ?? (m.photos ? `[${m.photos.length} photo(s)]` : m.videos ? '[video]' : m.audio_files ? '[audio]' : '[media]'),
    reactions: m.reactions?.map(r => `${r.actor}: ${r.reaction}`) ?? [],
  });

  // Sample: first 40, middle 40, last 40 — focus on text messages
  const textMessages = allMessages.filter(m => m.content);
  const sampleFrom = (arr, count) => arr.slice(0, count);
  const mid = Math.floor(textMessages.length / 2);

  const messageSample = [
    ...sampleFrom(textMessages, 40),
    ...textMessages.slice(mid - 20, mid + 20),
    ...textMessages.slice(-40),
  ].map(summarise);

  // Follow relationship
  const following = readJSON(`${EXPORT_DIR}/connections/followers_and_following/following.json`);
  const followers = readJSON(`${EXPORT_DIR}/connections/followers_and_following/followers_1.json`);

  // Story interactions (list format)
  const storyLikesRaw = readJSON(`${EXPORT_DIR}/your_instagram_activity/story_interactions/story_likes.json`);
  const storiesViewedRaw = readJSON(`${EXPORT_DIR}/your_instagram_activity/story_interactions/stories_viewed.json`);

  const countTargetInList = (arr) =>
    Array.isArray(arr) ? arr.filter(containsTarget).length : 0;

  const storyLikesOnTarget = countTargetInList(storyLikesRaw);
  const storiesViewedFromTarget = countTargetInList(storiesViewedRaw);

  // Posts liked
  const likedPosts = readJSON(`${EXPORT_DIR}/your_instagram_activity/likes/liked_posts.json`);
  const postsLikedFromTarget = countTargetInList(likedPosts?.likes_media_likes ?? likedPosts);

  // Recent profile searches
  const searches = readJSON(`${EXPORT_DIR}/logged_information/recent_searches/profile_searches.json`);
  const searchHistory = (Array.isArray(searches) ? searches : [])
    .filter(containsTarget)
    .map(s => ({
      searched_at: new Date((s.string_list_data?.[0]?.timestamp ?? 0) * 1000).toISOString(),
    }));

  return {
    target: TARGET,
    my_username: process.env.MY_HANDLE || 'your.handle',
    messages: {
      total_in_thread: allMessages.length,
      total_text_messages: textMessages.length,
      date_range: {
        first: allMessages.length ? new Date(allMessages[0].timestamp_ms).toISOString() : null,
        last: allMessages.length ? new Date(allMessages.at(-1).timestamp_ms).toISOString() : null,
      },
      sample: messageSample,
    },
    social: {
      i_follow_them: containsTarget(following),
      they_follow_me: containsTarget(followers),
    },
    engagement: {
      their_stories_i_liked: storyLikesOnTarget,
      their_stories_i_viewed: storiesViewedFromTarget,
      their_posts_i_liked: postsLikedFromTarget,
    },
    profile_searches: searchHistory,
  };
}

// ─── Agent 1: Sonnet — Parse & Structure ─────────────────────────────────────

async function parseWithSonnet(rawData) {
  console.log('Agent 1 (claude-sonnet-4-6) — parsing relationship data...\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: `You are a data analyst specialising in social relationship analysis.
Parse raw social media export data and extract structured, factual insights.
Be precise and grounded — only report what the data shows.
Return your output as valid JSON (no markdown fences).`,
    messages: [{
      role: 'user',
      content: `Analyse this Instagram data about the relationship between ${rawData.my_username} and ${rawData.target}.

Data:
${JSON.stringify(rawData, null, 2)}

Return a JSON object with:
{
  "relationship_timeline": { "started": "...", "duration_approx": "..." },
  "communication_volume": { "total_messages": ..., "assessment": "..." },
  "follow_status": "...",
  "communication_patterns": ["..."],
  "engagement_signals": { "story_likes": ..., "post_likes": ..., "profile_searches": ... },
  "conversation_themes": ["..."],
  "who_messages_more": "...",
  "key_observations": ["..."]
}`,
    }],
  });

  const text = response.content[0].text.trim();
  console.log('Sonnet structured output:\n' + text.slice(0, 400) + (text.length > 400 ? '…' : '') + '\n');

  try {
    // Strip markdown fences if present
    const clean = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(clean);
  } catch {
    return { raw: text };
  }
}

// ─── Agent 2: Opus 4.7 — Understand the Relationship ─────────────────────────

async function understandWithOpus(structuredData, rawData) {
  console.log('Agent 2 (claude-opus-4-7) — synthesising relationship understanding...\n');

  // Build a concise message context (avoid overloading context)
  const recentMessages = rawData.messages.sample.slice(-30);
  const earliestMessages = rawData.messages.sample.slice(0, 20);

  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'high' },
    system: `You are a thoughtful analyst helping someone understand their personal relationships through their digital footprint.
Be honest, specific, and grounded in the evidence. Avoid generic observations — every insight should reference the data.`,
    messages: [{
      role: 'user',
      content: `I want to understand my relationship with ${TARGET} on Instagram.

Structured data analysis (from Agent 1):
${JSON.stringify(structuredData, null, 2)}

Earliest messages (start of relationship):
${JSON.stringify(earliestMessages, null, 2)}

Most recent messages:
${JSON.stringify(recentMessages, null, 2)}

Please provide:

## Relationship Nature
What kind of relationship is this based on all signals?

## Depth & Closeness
How close are we, evidenced by the data?

## Communication Style
How do we typically communicate?

## Timeline
When did this relationship form and how has it evolved?

## What Stands Out
What's most notable or meaningful in this data?

## Summary
A 2-3 sentence human summary of who this person is to me and what this relationship means.`,
    }],
  });

  process.stdout.write('');
  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    if (event.delta.type === 'thinking_delta') {
      process.stdout.write('·'); // show thinking progress without flooding terminal
    } else if (event.delta.type === 'text_delta') {
      process.stdout.write(event.delta.text);
    }
  }

  const final = await stream.finalMessage();
  console.log('\n\n---');
  console.log(`Tokens used — input: ${final.usage.input_tokens}, output: ${final.usage.output_tokens}`);
  return final;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is not set.');
    process.exit(1);
  }

  console.log(`\nAnalysing relationship with: ${TARGET}\n${'─'.repeat(50)}\n`);
  console.log('Loading Instagram export data...');

  const rawData = collectRawData();
  console.log(
    `Loaded: ${rawData.messages.total_in_thread} messages total, ` +
    `mutual follow: ${rawData.social.i_follow_them && rawData.social.they_follow_me}\n`,
  );

  const structuredData = await parseWithSonnet(rawData);
  await understandWithOpus(structuredData, rawData);
}

main().catch((err) => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
