# Social Graph → Therapy Starting Point

A pipeline that turns your social media history into a document you can hand to a therapist on day one.

## What this is for

You have years of conversations sitting in iMessage, Instagram, WhatsApp, Facebook Messenger. Patterns are visible there that you can't see from inside. Therapists charge by the hour and start from scratch every time. This pipeline ingests your message archive, runs structural analysis across the whole network, and produces a starting-point document — patterns, questions, blind spots — that a therapist can use to skip the first 6 sessions of orientation.

The output is not therapy. It's the dossier you'd want a smart, brutal friend to write about you before you walk into a session.

## The journey

```
[your exports] → ingest → normalize → analyze → agent synthesis → therapy starting point
```

Three to four hours of compute and disk; output is one document plus supporting data.

---

## Stage 1 — Get your data

You'll need exports from the platforms you actually use. Skip what's irrelevant.

### iMessage (macOS)

The Messages database lives at `~/Library/Messages/chat.db`. Make a working copy:

```bash
cp ~/Library/Messages/chat.db ./inputs/chat.db
cp ~/Library/Messages/chat.db-wal ./inputs/chat.db-wal 2>/dev/null
cp ~/Library/Messages/chat.db-shm ./inputs/chat.db-shm 2>/dev/null
```

Then export to plaintext with [imessage-exporter](https://github.com/ReagentX/imessage-exporter):

```bash
brew install imessage-exporter
imessage-exporter -f txt -o ./inputs/imessage -p ./inputs/chat.db
```

This gives you a directory of per-thread `.txt` files named by phone or email.

### Instagram

Request your data at [instagram.com/download/request](https://www.instagram.com/download/request). Choose **JSON** format, **All time**. Wait 24–72 hours for the email link. Unzip into `./inputs/instagram/`. The conversations live at `your_instagram_activity/messages/inbox/`.

**Optional HTML supplement:** if you only have an *HTML*-format export (e.g. a recent, date-limited one), unzip it into `./inputs/instagram-html/`. build-db merges it per-thread, appending only messages newer than each thread's latest JSON message (so it captures the recent tail without duplicating history). Delete this dir once a fresh JSON all-time export supersedes it.

### WhatsApp

In each chat: ⋮ → More → Export chat → Without media. You'll get one `.txt` file per chat. Drop them in `./inputs/whatsapp/`.

For bulk export, [whatsapp-chat-parser](https://github.com/Pustur/whatsapp-chat-parser) handles common formats.

### Facebook Messenger

Request at [facebook.com/dyi](https://www.facebook.com/dyi). Choose **JSON** + **Messages only**. Drops into `./inputs/messenger/`.

### Contacts (for name mapping + birthdays)

Open Contacts.app → File → Export → Export vCard → save to `./inputs/contacts.vcf`.

This lets the pipeline turn raw phone numbers (e.g., `+155501001`) into the names from your contacts everywhere downstream. The vCard's `BDAY:` field (when present) populates the `birthdays` table.

### Birthdays from Facebook (optional)

Facebook removes the birthday API/feed from time to time, so we don't ship a Facebook-scraping integration. Instead, run [fb2cal](https://github.com/mobeigi/fb2cal) yourself (it handles your FB credentials in their tool, not ours), then drop the resulting `.ics` file into `./inputs/birthdays/`. The pipeline will ingest any `*.ics` files there alongside vCard birthdays:

```bash
# Once: install fb2cal per their README (Python, requires your FB login)
pipx install fb2cal  # or follow their setup

# Each refresh:
fb2cal --output ./inputs/birthdays/facebook.ics
npm run build-db
```

ICS-derived birthdays don't have year information (FB doesn't expose real birth year). vCard birthdays take precedence when the same name exists in both sources.

---

## Stage 2 — Run the pipeline

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...
node pipeline/cli.js
```

Stages, in order:

1. **Ingest.** Parse each format into a common schema. Strip mojibake, attachments, system messages.
2. **Resolve identities.** Match phone → name (vcf), email → name, Instagram handle → name. The same person across iMessage/Instagram/WhatsApp gets one canonical ID.
3. **Build the network.** Per-thread stats (volume, range, density). Cross-thread graph. Rank by intimacy signals (volume, response time, late-night messages, vulnerability markers).
4. **Loaded-language scan.** Surface charged words: love, miss, breakup, crush, attracted, afraid, ashamed, sorry, regret, cheat, lie. Per-person frequency. Time-series.
5. **Agent extraction (Sonnet, parallel).** For each top-N relationship (default 15), produce a structured profile: nature of the bond, peak periods, charged moments, the person's shape in your life.
6. **Agent synthesis (Opus, deep).** Cross-thread pattern recognition. The architecture. Recurring shapes. What's load-bearing. What's missing from your self-narrative.
7. **Therapy letter (Opus, single document).** The starting point — a 3–5 page document organized for a clinician's first read.

Each stage writes intermediate output so you can stop, inspect, and resume.

---

## Stage 3 — What you get

`output/profiles/<name>.md` — one per significant person  
`output/network.md` — the architecture of your relational life  
`output/patterns.md` — the recurring shapes  
`output/THERAPY_STARTING_POINT.md` — the document you bring  
`output/questions.md` — questions worth asking yourself before session 1  
`output/raw/` — normalized data, indexable, queryable

See `SAMPLE_OUTPUT.md` for an example therapy starting point.

---

## What this pipeline is *not*

- **Not a substitute for therapy.** This produces a starting document. The work happens in a chair across from another person, repeatedly, over months.
- **Not a love-life calculator.** It will not tell you whether someone loves you back. It will tell you what your pattern of falling in love looks like across years.
- **Not private.** Run it locally. The agent calls send chunks of your messages to Anthropic's API. Read the cost note below.

## Privacy

Your raw data never leaves your machine *except* the message samples sent to the Anthropic API during agent stages. The pipeline samples (default 80 messages per thread) rather than uploading everything; raw archives stay local. If you want zero external calls, run the ingest/normalize/analyze stages and skip the agent stages — you'll still get the network and patterns reports, just without the synthesis.

## Cost

Roughly $5–20 in API calls for a typical archive (30+ significant relationships, 100K+ messages). Mostly Sonnet calls in parallel. The two Opus calls (synthesis + therapy letter) are the deepest. Set `MAX_RELATIONSHIPS=N` in env to cap the agent stage.

## What to do with the output before session 1

1. Read `THERAPY_STARTING_POINT.md` once, slowly.
2. Don't show it to anyone in your life.
3. Don't quote it in conversations.
4. Bring it to your therapist, not as a deliverable to discuss but as material to inform their reading of you. Hand it over. Let them read it on their own.
5. Notice which sections you want to argue with. Those are usually the load-bearing ones.

## A note on tone

The agent prompts are tuned to push, not to mirror. The output will name patterns you may not have wanted named. If you want soft, get a coach. This is the opposite shape of that.

Built from work-in-anger, by someone who needed it. Use as you find useful.
