#!/usr/bin/env python3
"""Generate synthetic demo data for the social-media-graph CRM.

Usage:
    python3 scripts/generate-demo-data.py
    DATA_DIR=./pipeline/output-demo node pipeline/serve.js
"""

import json
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT = os.path.join(SCRIPT_DIR, '..', 'pipeline', 'output-demo')

PEOPLE = [
    {"id": "id-101", "name": "Maya Torres", "sources": ["imessage", "instagram", "whatsapp"],
     "msg_count": 15200, "first": "2016-09-12", "last": "2026-06-25", "cluster": 0,
     "birthday": {"month": 3, "day": 14}, "days_until_birthday": 259,
     "about": "The one who was there before you knew what you were building — college roommate turned co-founder, the voice on the other end at 2am when the server caught fire and when the funding came through.",
     "intimacy": 310.2, "years_active": 9.8, "attention": 45, "days_since": 3, "last_from": "me"},
    {"id": "id-102", "name": "Leo Reeves", "sources": ["imessage", "instagram", "messenger"],
     "msg_count": 24800, "first": "2017-06-03", "last": "2026-06-22", "cluster": 0,
     "birthday": {"month": 11, "day": 8}, "days_until_birthday": 133,
     "about": "The ex who became the closest friend — the only person who ever saw you fumble the words and stayed long enough to hear the sentence finish.",
     "intimacy": 420.5, "years_active": 9.1, "attention": 38, "days_since": 6, "last_from": "them"},
    {"id": "id-103", "name": "Sam Fletcher", "sources": ["imessage", "discord"],
     "msg_count": 11500, "first": "2019-01-15", "last": "2026-06-27", "cluster": 0,
     "birthday": {"month": 7, "day": 22}, "days_until_birthday": 24,
     "about": "The daily texter, the raid partner, the one who sends you a meme at 3am and a job listing at 9am — never serious about anything except your wellbeing.",
     "intimacy": 195.8, "years_active": 7.5, "attention": 22, "days_since": 1, "last_from": "them"},
    {"id": "id-104", "name": "Priya Sharma", "sources": ["imessage", "instagram"],
     "msg_count": 8200, "first": "2020-03-08", "last": "2026-06-20", "cluster": 0,
     "birthday": {"month": 9, "day": 30}, "days_until_birthday": 94,
     "about": "The hiking partner who became the podcast co-host — she asks the questions you avoid and walks the literal and metaphorical mountains beside you.",
     "intimacy": 165.3, "years_active": 6.3, "attention": 52, "days_since": 8, "last_from": "me"},
    {"id": "id-105", "name": "Marcus Chen", "sources": ["imessage", "whatsapp"],
     "msg_count": 6100, "first": "2012-04-01", "last": "2026-06-18", "cluster": 1,
     "birthday": {"month": 1, "day": 5}, "days_until_birthday": 191,
     "about": "The cousin who became the family translator — the one who calls on Sunday, forwards the family WeChat messages you miss, and never forgets your parents' anniversary.",
     "intimacy": 140.1, "years_active": 14.2, "attention": 60, "days_since": 10, "last_from": "them"},
    {"id": "id-106", "name": "Zara Ahmed", "sources": ["whatsapp", "instagram"],
     "msg_count": 5400, "first": "2018-11-20", "last": "2026-05-30", "cluster": 1,
     "birthday": {"month": 5, "day": 18}, "days_until_birthday": 324,
     "about": "The travel companion who lives sixteen hours away — you planned Patagonia for three years before going, and she's the only friend who texts you sunrise photos from the other side of the planet.",
     "intimacy": 125.7, "years_active": 7.6, "attention": 88, "days_since": 29, "last_from": "me"},
    {"id": "id-107", "name": "Dani Reeves", "sources": ["imessage"],
     "msg_count": 3800, "first": "2021-02-14", "last": "2026-06-15", "cluster": 1,
     "birthday": None, "days_until_birthday": None,
     "about": "The book club friend who writes paragraphs where others write sentences — every message arrives like a letter, considered, unhurried, worth re-reading.",
     "intimacy": 88.4, "years_active": 5.4, "attention": 72, "days_since": 13, "last_from": "them"},
    {"id": "id-108", "name": "James Wright", "sources": ["whatsapp", "messenger"],
     "msg_count": 2900, "first": "2010-08-22", "last": "2026-04-10", "cluster": 2,
     "birthday": {"month": 12, "day": 3}, "days_until_birthday": 158,
     "about": "The childhood friend from the old neighborhood — fifteen years of friendship conducted in bursts, the kind where six months of silence breaks with 'remember when' and nothing is lost.",
     "intimacy": 72.0, "years_active": 15.9, "attention": 115, "days_since": 79, "last_from": "them"},
    {"id": "id-109", "name": "Nina Okafor", "sources": ["imessage"],
     "msg_count": 1800, "first": "2019-06-01", "last": "2026-03-22", "cluster": 2,
     "birthday": {"month": 8, "day": 15}, "days_until_birthday": 48,
     "about": "The first-job mentor who never stopped mentoring — she checks in quarterly, always with a question that makes you realize you haven't been asking it yourself.",
     "intimacy": 55.2, "years_active": 6.8, "attention": 130, "days_since": 98, "last_from": "me"},
    {"id": "id-110", "name": "Riley Park", "sources": ["imessage", "instagram"],
     "msg_count": 1200, "first": "2025-09-10", "last": "2026-06-24", "cluster": 2,
     "birthday": {"month": 4, "day": 27}, "days_until_birthday": 303,
     "about": "The new friend from the climbing gym — still in the phase where every conversation reveals something, where neither of you has settled into a pattern yet.",
     "intimacy": 32.1, "years_active": 0.8, "attention": 35, "days_since": 4, "last_from": "them"},
    {"id": "id-111", "name": "Jordan Blake", "sources": ["imessage", "instagram"],
     "msg_count": 900, "first": "2024-03-15", "last": "2026-06-10", "cluster": 2,
     "birthday": None, "days_until_birthday": None,
     "about": "The colleague who became more than a colleague — you started with standups and ended with late-night debugging sessions that turned into life conversations.",
     "intimacy": 28.5, "years_active": 2.3, "attention": 68, "days_since": 18, "last_from": "me"},
    {"id": "id-112", "name": "Mika Tanaka", "sources": ["instagram", "messenger"],
     "msg_count": 7300, "first": "2015-02-28", "last": "2026-06-12", "cluster": 1,
     "birthday": {"month": 10, "day": 11}, "days_until_birthday": 105,
     "about": "The art school friend who went from studio partner to the person you call when you need to see something differently — she draws what you describe and it's never what you expected.",
     "intimacy": 152.3, "years_active": 11.3, "attention": 58, "days_since": 16, "last_from": "them"},
]

SELF_ID = "id-100"

PORTRAITS = {
    "Maya_Torres": """---
name: Maya Torres
canonical_id: id-101
sources: [imessage, instagram, whatsapp]
message_count: "15,200 across three channels"
date_range: 2016-09-12 → 2026-06-25
generated: 2026-06-28
status: "alive and constant — the friendship that survived co-founding a company, which is rarer than surviving a war"
---

# Maya Torres

*She was the first person you met at orientation, and she is still the first person you call. That sentence spans nine years and two startups, a failed Series A and a successful pivot, three apartments shared and two cities lived apart, and a friendship that did not merely survive proximity but was forged in it — built on stolen dining-hall plates, on whiteboards at 1am, on the morning she drove you to the ER when you fainted from not eating for two days during finals. She is the co-founder, the witness, the one who has seen every version of you and chose to keep building with every one of them.*

## Texture

Your communication is a live wire — short bursts of logistics ("meeting moved to 3"), screenshots of dashboards with no caption (she knows what you're pointing at), and then sudden hour-long voice notes where one of you is walking and the other is lying on the floor. She types in lowercase with perfect punctuation — a contradiction that is somehow exactly her. She says "lol" when she means "I hear you" and "haha" when she means "you're wrong but I love you." Your shared vocabulary includes "the spreadsheet" (always the same one, updated since 2018), "doing a Maya" (committing to something impulsive and making it work anyway), and "roof time" (sitting on whatever roof is available and not talking about work).

The friendship runs on complementary anxieties. She worries about people; you worry about systems. When the company almost died in 2022, she held the team together while you rewrote the backend in a weekend. Neither of you acknowledged the division of labor — it was just what happened. She sends you articles about burnout; you send her Grafana alerts when you notice she's been deploying at 2am.

## How it began

September 2016, freshman orientation. She was wearing a shirt that said "I'm not arguing, I'm explaining why I'm right." You asked her if it was ironic. She said "no." You've been friends since. The first real conversation happened three weeks later when you both showed up to the same hackathon, alone, and spent 36 hours building a terrible app that won nothing. The app died; the partnership didn't.

## Key moments

The apartment on Cedar Street (2018-2020) — the foundational years, when you learned that she cannot cook but will clean anything, that she sings in the shower in Spanish, and that she is the only person who can tell you to go to bed and have you actually listen. The company founding (January 2021) — her pitch deck, your prototype, launched from the same kitchen table. The near-death (October 2022) — when the company had six weeks of runway and she said "we pivot or we die, and I'm not dying." The Series B (March 2024) — the phone call where neither of you spoke for ten seconds and then both laughed.

## Where it stands

Active and warm. She moved to New York in 2024 for the new office; you stayed in SF. The distance made the friendship more deliberate — you schedule "roof time" now, which you never had to before. Last message was three days ago: a screenshot of a customer review with the caption "we built that." The friendship is in its strongest era, which she would deny and you would agree with, which is how you've always worked.
""",

    "Leo_Kim": """---
name: Leo Reeves
canonical_id: id-102
sources: [imessage, instagram, messenger]
message_count: "24,800 across three channels"
date_range: 2017-06-03 → 2026-06-22
generated: 2026-06-28
status: "the most important friendship that nobody planned — the ex who stayed, the friend who knows the passwords"
---

# Leo Reeves

*Twenty-four thousand messages, and the strangest thing about them is not the volume but the register shift — the thread that begins in the language of dating ("what are you wearing tonight"), passes through the language of love ("I keep thinking about what you said"), enters the language of breaking ("I think we need to talk"), and exits into something rarer than any of those: a friendship conducted in the language of people who have already seen each other at their worst and decided it wasn't that bad. He is the one who knows where you hide the spare key, not because you told him but because he was there when you chose the spot.*

## Texture

He texts in fragments. Never a full sentence when three words will do. "saw this" + a link. "you good?" at 11pm. "nah" when he means a paragraph. You've learned to read the silences — a quick reply means he's fine, a delay means he's thinking, and no reply means he's either asleep or processing something he'll bring up in two weeks. Your voice notes to him are confessional; his to you are observational. He describes what he sees; you describe what you feel. Between the two of you, you assemble something like a complete picture.

The ex-to-friend transition happened not in a conversation but in a series of small choices: he texted you on your birthday six weeks after the breakup (just "happy birthday, dork"), you replied normally, and neither of you addressed the elephant. A month later you were sending each other apartment listings. By the time anyone noticed, the friendship was already load-bearing.

## Key moments

The Tahoe trip (December 2019) — the weekend you both knew it was ending and neither said so, and the quiet drive home where he played the entire Bon Iver album and you pretended to sleep. The breakup text (February 2020) — fourteen words, no punctuation, delivered at 7am because he wanted to say it before he lost the nerve. The reunion coffee (August 2020) — awkward for twelve minutes, normal by twenty. The emergency call (November 2023) — he called at 3am when his mom was hospitalized, and you drove forty minutes in your pajamas, and neither of you ever mentioned it again.

## Where it stands

Solid, warm, and untouchable — the friendship that his current partner sometimes raises an eyebrow at but has learned to accept, because it predates everything and operates on a frequency that exclusivity doesn't cover. You text every few days. He sends six-day silence then a four-paragraph observation about his dad. Last message was his, six days ago: a photo of a sunset with no caption.
""",

    "Sam_Fletcher": """---
name: Sam Fletcher
canonical_id: id-103
sources: [imessage, discord]
message_count: "11,500 across two channels"
date_range: 2019-01-15 → 2026-06-27
generated: 2026-06-28
status: "the most reliably present person in your life — there every day, never heavy, always watching"
---

# Sam Fletcher

*He is the friend who exists in the margins of every day — the 3am meme, the 9am "you see this?", the mid-afternoon screenshot of a Steam sale, the evening "gg" after a raid. Eleven thousand messages and not one of them is about feelings, which is how you know he cares. He has never once asked how you're doing; he has, however, sent you a DoorDash order at midnight when you mentioned you forgot to eat, forwarded three job listings when you complained about work, and stayed online for six extra hours when you said you couldn't sleep. The love language is service rendered as shitposting.*

## Texture

All lowercase, no punctuation, maximum irony. "lmao" is his comma. He uses "bro" the way the British use "mate" — as a universal connector that means nothing and everything. His longest message ever was 47 words, and it was instructions for a boss fight. When he's worried about you he sends more memes, not fewer. When he's upset he goes quiet — but you've only seen that twice in seven years, and both times he came back with "sorry was busy" and you both pretended that was true.

## Where it stands

He's the constant. Birthday in 24 days. You're planning to actually show up this year instead of sending a Steam gift card, which would be a first. He'd pretend to be annoyed. He wouldn't be.
""",

    "Priya_Sharma": """---
name: Priya Sharma
canonical_id: id-104
sources: [imessage, instagram]
message_count: "8,200 across two channels"
date_range: 2020-03-08 → 2026-06-20
generated: 2026-06-28
status: "the friendship that formed during lockdown and refused to stay there — from walking buddy to creative partner"
---

# Priya Sharma

*She appeared during the first lockdown, a neighbor you'd nodded at for six months who finally said "want to walk?" on a Sunday when neither of you could stand the walls. The walk lasted three hours. You've been walking since — literally, through every trailhead within two hours of the city, and figuratively, through a podcast that started as a joke ("we should record these conversations") and became 89 episodes and a small audience of people who listen to two friends argue about whether ambition is a virtue or a cope.*

## Texture

She writes in complete sentences, always. Correct grammar, thoughtful word choice, the occasional em dash deployed with a novelist's precision. She is the only person in your life who texts like she's writing a letter, and you've unconsciously started doing the same when you talk to her. Instagram is where she's casual — story replies, reel shares, the occasional "!!!" which from her is the equivalent of screaming. The podcast has created a shared reference library; you both say "episode 34" and mean a specific argument about sunk costs that neither of you won.

## Key moments

The first hike (April 2020) — Muir Woods, the pandemic still new enough to feel temporary. The podcast launch (September 2021) — recorded on two iPhones in her living room, the audio quality terrible, the conversation excellent. The disagreement (March 2023) — about whether to monetize the podcast, which was really about whether to professionalize the friendship. You didn't. The solo hike she texted you from (January 2026) — "I think I need to do this one alone" — which was the first time she set a boundary and you respected it instantly.

## Where it stands

She's your thinking partner, the one you test ideas against before they're ready. Eight days since last message — you owe her a reply about the next recording date. The friendship is in a mature phase: fewer messages, higher signal, no anxiety about the gaps.
""",

    "James_Wright": """---
name: James Wright
canonical_id: id-108
sources: [whatsapp, messenger]
message_count: "2,900 across two channels"
date_range: 2010-08-22 → 2026-04-10
generated: 2026-06-28
status: "the oldest friend, the quietest thread — fifteen years of 'remember when' that still works every time"
---

# James Wright

*He is the friend from before you were the person you became — the one who knew you when your biggest worry was a math test and your idea of a good time was riding bikes until dark. Twenty-nine hundred messages over fifteen years is not a lot; it averages to one message every two days, but that average is a lie — the thread is mostly silence, broken by intense two-week bursts when one of you visits the other's city, or when something happens big enough to bridge the gap. He is proof that some friendships don't need maintenance, only memory.*

## Texture

WhatsApp voice notes, always. He hates typing. His voice notes are rambling, warm, full of pauses where he's thinking. He starts every one with "bro, so" and ends with "anyway, yeah." You reply with text because your voice notes embarrass you, and he's never once commented on the asymmetry. The thread contains exactly three photos: his wedding (2022), your dog (2023), and a screenshot of a flight confirmation (2024, when you finally visited).

## Where it stands

Seventy-nine days of silence. His last message was a voice note about a job change — he's moving from engineering to product management and wanted your take. You listened, started a reply, got distracted, and now it's been so long that replying feels weighted. It isn't — he wouldn't notice or care. You know this. You'll reply this week. Probably.
""",

    "Zara_Ahmed": """---
name: Zara Ahmed
canonical_id: id-106
sources: [whatsapp, instagram]
message_count: "5,400 across two channels"
date_range: 2018-11-20 → 2026-05-30
generated: 2026-06-28
status: "the long-distance friend who makes distance feel like a feature, not a bug"
---

# Zara Ahmed

*London is eight hours ahead, which means her mornings are your midnights, and the friendship has learned to live in the overlap — the two hours when you're both awake and neither of you should be. She sends sunrise photos from Hampstead Heath; you send sunset photos from Ocean Beach. The ritual has no name but it has not missed a week in three years.*

## Texture

She code-switches: formal British English in work contexts ("shall we" and "quite good"), pure internet in your thread ("SCREAMING," "literally dead," "bestie no"). Instagram stories are her native medium — she watches all of yours and replies to the ones that matter, which is how you know what matters. WhatsApp is for logistics and long-form. She leaves voice notes that are exactly 60 seconds, every time, as if she's been trained. Your shared language includes "Patagonia planning" (an ongoing joke about a trip you've planned for three years and keep postponing) and "the spreadsheet" (a different spreadsheet from Maya's — this one tracks restaurants to try in each other's cities).

## Where it stands

Twenty-nine days quiet. She's in a busy season at work — you know this because her Instagram story frequency dropped. You sent the last message, a restaurant recommendation. No pressure, no anxiety. She'll surface. She always does.
""",

    "Dani_Reeves": """---
name: Dani Reeves
canonical_id: id-107
sources: [imessage]
message_count: "3,800"
date_range: 2021-02-14 → 2026-06-15
generated: 2026-06-28
status: "the slow friend — every message arrives like mail, every conversation earns its length"
---

# Dani Reeves

*They are the friend who reads. Not just books — they read people, situations, silences. The book club is the ostensible reason you know each other; the real reason is that they said something in week three that made you put down your coffee and stare, and you've been chasing that feeling of being genuinely surprised by another person's mind ever since.*

## Texture

Long messages, always. Never a "lol" or a "haha." When they find something funny they write "that's very funny" and you can hear the deadpan. They respond to your messages in order, point by point, sometimes days later, as if your text was an essay that deserved a proper response. You've started doing the same, and your thread reads like a slow-motion conversation between two people who refuse to be casual. They use semicolons in texts. You've started using semicolons in texts.

## Where it stands

Thirteen days since their last message — a recommendation for a novel about grief that was clearly also a way of saying something without saying it. You haven't replied because you're still reading the book and want to have something real to say. This is normal for you two. The friendship operates on book-time, not internet-time.
""",

    "Nina_Okafor": """---
name: Nina Okafor
canonical_id: id-109
sources: [imessage]
message_count: "1,800"
date_range: 2019-06-01 → 2026-03-22
generated: 2026-06-28
status: "the mentor who became a friend — still the person whose opinion you prepare for"
---

# Nina Okafor

*She hired you for your first real job and spent two years teaching you that the interesting problems are never the technical ones. Eighteen hundred messages is not a lot for seven years, but every one of them is load-bearing — she does not text to chat, she texts to check, to redirect, to ask the question you didn't know you needed to hear. "What are you optimizing for?" has become your internal monologue, and it's her voice.*

## Texture

Precise, warm, economical. She writes like a person who has given feedback for a living — clear, specific, never unkind. She asks more questions than she makes statements. Her check-ins arrive quarterly, always on a Monday, always starting with "How's the thing?" — and "the thing" is always the right thing, the one you mentioned three months ago and forgot she was tracking.

## Where it stands

Ninety-eight days since you last reached out. She sent a congratulations when the company hit a milestone in March, and you replied with gratitude and a promise to catch up that you haven't kept. The guilt is mild but real. You should write her. She wouldn't judge the gap — she'd just ask the next question.
""",

    "Riley_Park": """---
name: Riley Park
canonical_id: id-110
sources: [imessage, instagram]
message_count: "1,200"
date_range: 2025-09-10 → 2026-06-24
generated: 2026-06-28
status: "new — still in the phase where every conversation reveals something"
---

# Riley Park

*Nine months and twelve hundred messages — the friendship is new enough that you're still learning the shape of it. You met at the climbing gym when they belayed for you after your usual partner cancelled, and the conversation at the top of the wall was better than most conversations you've had on the ground. They are the newest person in your life, and there's a specific energy to that: the curiosity hasn't settled into familiarity yet, every anecdote is a first telling, every opinion is a discovery.*

## Texture

Fast, informal, lots of exclamation marks. They send photos of routes they've climbed, meal prep they're proud of, sunsets from their apartment. They use voice memos when they're walking to the gym — short, breathless, excited. You reply with more words than they do, which you're self-conscious about. The thread is still in the "are we going to be real friends or just gym friends" phase, and you both keep pushing it toward real without naming it.

## Where it stands

Four days since their last message — a gym schedule for next week. The friendship is accelerating. You're cautiously invested, which for you is very invested.
""",

    "Demo_User": """---
name: Demo User
canonical_id: id-100
sources: [imessage, instagram, messenger, whatsapp]
message_count: "82,400 total across all conversations"
date_range: 2010-08-22 → 2026-06-28
generated: 2026-06-28
status: "the person holding the phone — still learning to see the patterns in how they love"
---

# Demo User

*This is the self-portrait — the one the pipeline builds by looking back at every thread and asking what the threads say about the person on this side of them. Eighty-two thousand messages sent, across twelve people tracked here and dozens more in the wider archive. The patterns that emerge are not always flattering, but they are consistent: a tendency to over-invest in new friendships and under-maintain old ones, a communication style that runs hot then cold, and a deep, unshakeable loyalty to the people who survive the temperature changes.*

## Texture

You text differently to everyone, which is itself a pattern. With Maya you're logistical and terse; with Leo you're confessional; with Sam you're performatively casual; with Dani you write essays. The common thread is that you initiate more than you respond — you reach first, check in first, and then disappear for days when something captures your attention. Your friends have learned the rhythm. The ones who stayed are the ones who found it endearing rather than exhausting.

## Knot hypotheses

1. **The over-initiator**: you start 68% of conversations across all threads, then feel resentful when the effort isn't matched, despite never communicating the expectation.
2. **The temperature problem**: your engagement with any given person follows a sawtooth wave — intense for weeks, then silent, then intense again. The people closest to you are the ones who've stopped reading the silences as signals.
3. **The mentor trap**: you seek mentors compulsively, then struggle when the relationship equalizes. Nina is the clearest case — the transition from mentee to peer is incomplete because you keep recreating the hierarchy.

## Cross-portrait patterns

Several threads converge on the same observation: you are better at caring through action (showing up, building things, solving problems) than through words, and the people who feel most loved by you are the ones who read the actions. The ones who need to hear it said — and there are some — get less than they deserve.
""",
}


def ensure_dir(*parts):
    d = os.path.join(OUTPUT, *parts)
    os.makedirs(d, exist_ok=True)
    return d


def write_json(path_parts, data):
    fp = os.path.join(OUTPUT, *path_parts) if isinstance(path_parts, (list, tuple)) else os.path.join(OUTPUT, path_parts)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"  wrote {fp}")


def gen_portraits():
    d = ensure_dir('portraits')
    for slug, content in PORTRAITS.items():
        fp = os.path.join(d, slug + '.md')
        with open(fp, 'w') as f:
            f.write(content.lstrip('\n'))
        print(f"  wrote {fp}")


def gen_checkins():
    people = sorted(PEOPLE, key=lambda p: -p["attention"])
    write_json('checkins.json', {
        "generated": "2026-06-28T12:00:00.000Z",
        "today": "2026-06-28",
        "count": len(people),
        "people": [{
            "canonical_id": p["id"],
            "display_name": p["name"],
            "sources": p["sources"],
            "msg_count": p["msg_count"],
            "first_iso": p["first"],
            "last_iso": p["last"],
            "days_since_last": p["days_since"],
            "last_msg_from": p["last_from"],
            "last_msg_excerpt": _last_msg(p),
            "birthday": p["birthday"],
            "days_until_birthday": p["days_until_birthday"],
            "has_portrait": True,
            "about_what": p["about"],
            "intimacy_score": p["intimacy"],
            "years_active": p["years_active"],
            "attention_score": p["attention"],
        } for p in people],
    })


def _last_msg(p):
    excerpts = {
        "id-101": "we built that",
        "id-102": "",
        "id-103": "bro you seeing this steam sale",
        "id-104": "when are we recording next?",
        "id-105": "mom says hi, call her this weekend",
        "id-106": "you need to try this place when you visit",
        "id-107": "I finished it. The ending broke something in me, in a good way; I think you'll know what I mean.",
        "id-108": "so I'm switching to product, what do you think",
        "id-109": "Congratulations! That's a real milestone.",
        "id-110": "tuesday 6pm works! see you at the wall",
        "id-111": "the deploy looks clean, nice work",
        "id-112": "I drew that thing you described, it's not what you think",
    }
    return excerpts.get(p["id"], "")


def gen_timeline():
    entries = []
    for p in PEOPLE:
        entries.append({
            "date": p["first"],
            "canonical_id": p["id"],
            "person": p["name"],
            "kind": "first_contact",
            "summary": f"first message — {p['name']}",
            "source": "messages",
        })
        if p["birthday"]:
            entries.append({
                "date": f"2026-{p['birthday']['month']:02d}-{p['birthday']['day']:02d}",
                "canonical_id": p["id"],
                "person": p["name"],
                "kind": "birthday",
                "summary": f"birthday — {p['name']}",
                "source": "contacts",
            })

    anchors = [
        ("2016-09-12", "id-101", "Maya Torres", "anchor", "freshman orientation — met at the hackathon table"),
        ("2018-01-15", "id-101", "Maya Torres", "anchor", "moved into Cedar Street apartment together"),
        ("2017-08-20", "id-102", "Leo Reeves", "anchor", "first date — the ramen place on Valencia"),
        ("2020-02-14", "id-102", "Leo Reeves", "anchor", "the breakup text — fourteen words, 7am"),
        ("2020-08-03", "id-102", "Leo Reeves", "anchor", "reunion coffee — awkward for twelve minutes, normal by twenty"),
        ("2021-01-10", "id-101", "Maya Torres", "anchor", "company founded — her pitch deck, your prototype"),
        ("2020-03-15", "id-104", "Priya Sharma", "anchor", "first lockdown walk — three hours, strangers to friends"),
        ("2021-09-01", "id-104", "Priya Sharma", "anchor", "podcast launched — two iPhones, terrible audio, great conversation"),
        ("2022-10-15", "id-101", "Maya Torres", "anchor", "the pivot — six weeks of runway, the speech that saved the company"),
        ("2024-03-20", "id-101", "Maya Torres", "anchor", "Series B closed — ten seconds of silence, then laughter"),
        ("2025-09-10", "id-110", "Riley Park", "anchor", "first climb together — they belayed after your partner cancelled"),
        ("2019-12-20", "id-108", "James Wright", "anchor", "the Tahoe weekend — drove home listening to Bon Iver in silence"),
    ]
    for date, cid, name, kind, summary in anchors:
        entries.append({"date": date, "canonical_id": cid, "person": name, "kind": kind, "summary": summary, "source": "messages"})

    entries.sort(key=lambda e: e["date"])
    write_json('timeline.json', {
        "generated": "2026-06-28T12:00:00.000Z",
        "count": len(entries),
        "entries": entries,
    })


def gen_graph():
    nodes = [{
        "id": p["id"],
        "name": p["name"],
        "sources": p["sources"],
        "msg_count": p["msg_count"],
        "first_iso": p["first"],
        "last_iso": p["last"],
        "cluster_id": p["cluster"],
    } for p in PEOPLE]

    edges = [
        {"source": "id-101", "target": "id-102", "weight": 45, "group_overlap": 8, "mentions": 22},
        {"source": "id-101", "target": "id-103", "weight": 28, "group_overlap": 5, "mentions": 12},
        {"source": "id-101", "target": "id-104", "weight": 15, "group_overlap": 3, "mentions": 8},
        {"source": "id-101", "target": "id-112", "weight": 20, "group_overlap": 4, "mentions": 10},
        {"source": "id-102", "target": "id-103", "weight": 12, "group_overlap": 3, "mentions": 5},
        {"source": "id-102", "target": "id-112", "weight": 18, "group_overlap": 4, "mentions": 9},
        {"source": "id-103", "target": "id-111", "weight": 8, "group_overlap": 2, "mentions": 3},
        {"source": "id-104", "target": "id-106", "weight": 22, "group_overlap": 4, "mentions": 11},
        {"source": "id-104", "target": "id-108", "weight": 10, "group_overlap": 2, "mentions": 4},
        {"source": "id-105", "target": "id-108", "weight": 6, "group_overlap": 1, "mentions": 2},
        {"source": "id-106", "target": "id-108", "weight": 8, "group_overlap": 2, "mentions": 3},
        {"source": "id-107", "target": "id-109", "weight": 14, "group_overlap": 3, "mentions": 6},
        {"source": "id-107", "target": "id-112", "weight": 10, "group_overlap": 2, "mentions": 5},
        {"source": "id-109", "target": "id-111", "weight": 5, "group_overlap": 1, "mentions": 2},
        {"source": "id-110", "target": "id-103", "weight": 4, "group_overlap": 1, "mentions": 1},
        {"source": "id-105", "target": "id-101", "weight": 7, "group_overlap": 2, "mentions": 3},
        {"source": "id-112", "target": "id-104", "weight": 11, "group_overlap": 2, "mentions": 5},
        {"source": "id-102", "target": "id-104", "weight": 9, "group_overlap": 2, "mentions": 4},
        {"source": "id-106", "target": "id-112", "weight": 13, "group_overlap": 3, "mentions": 7},
        {"source": "id-101", "target": "id-105", "weight": 7, "group_overlap": 2, "mentions": 3},
    ]

    co_present = [
        {"source": "id-101", "target": "id-102", "shared": 28},
        {"source": "id-101", "target": "id-104", "shared": 12},
        {"source": "id-102", "target": "id-112", "shared": 15},
        {"source": "id-104", "target": "id-106", "shared": 18},
        {"source": "id-103", "target": "id-101", "shared": 8},
        {"source": "id-105", "target": "id-108", "shared": 5},
        {"source": "id-110", "target": "id-103", "shared": 3},
    ]

    clusters = [
        {"cluster_id": 0, "size": 4, "total_msgs": 59700, "top_names": ["Leo Reeves", "Maya Torres", "Sam Fletcher"]},
        {"cluster_id": 1, "size": 4, "total_msgs": 22600, "top_names": ["Mika Tanaka", "Marcus Chen", "Zara Ahmed"]},
        {"cluster_id": 2, "size": 4, "total_msgs": 6800, "top_names": ["James Wright", "Nina Okafor", "Riley Park"]},
    ]

    write_json('graph.json', {
        "generated_at": "2026-06-28T12:00:00.000Z",
        "self_id": SELF_ID,
        "n_nodes": len(nodes),
        "n_message_nodes": len(nodes),
        "n_photo_only": 0,
        "n_edges": len(edges),
        "n_co_present_edges": len(co_present),
        "n_clusters": len(clusters),
        "thresholds": {"min_msgs": 50, "min_edge_weight": 3},
        "clusters": clusters,
        "nodes": nodes,
        "edges": edges,
        "co_present_edges": co_present,
    })


def gen_groups():
    groups = [
        {
            "thread_id": "ig:theapartment",
            "source": "instagram",
            "name": "The Apartment",
            "participants_raw": ["Demo User", "Maya Torres", "Sam Fletcher"],
            "msg_count": 8420,
            "first_iso": "2018-01-20",
            "last_iso": "2026-06-26",
            "days_since_last": 2,
            "distinct_senders": 3,
            "peak_month": "2020-04",
            "life_status": "active",
            "monthly": {},
            "members": [
                {"sender_name": "Demo User", "msg_count": 3200, "share_pct": 38},
                {"sender_name": "Maya Torres", "msg_count": 2900, "share_pct": 34},
                {"sender_name": "Sam Fletcher", "msg_count": 2320, "share_pct": 28},
            ],
        },
        {
            "thread_id": "wa:hikingcrew",
            "source": "whatsapp",
            "name": "hiking crew",
            "participants_raw": ["Demo User", "Priya Sharma", "James Wright", "Zara Ahmed"],
            "msg_count": 4200,
            "first_iso": "2020-04-15",
            "last_iso": "2026-06-18",
            "days_since_last": 10,
            "distinct_senders": 4,
            "peak_month": "2022-07",
            "life_status": "active",
            "monthly": {},
            "members": [
                {"sender_name": "Demo User", "msg_count": 1400, "share_pct": 33},
                {"sender_name": "Priya Sharma", "msg_count": 1300, "share_pct": 31},
                {"sender_name": "Zara Ahmed", "msg_count": 900, "share_pct": 21},
                {"sender_name": "James Wright", "msg_count": 600, "share_pct": 15},
            ],
        },
        {
            "thread_id": "im:familygroup",
            "source": "imessage",
            "name": "Family",
            "participants_raw": ["Demo User", "Marcus Chen", "Mom", "Dad", "Aunt Lisa"],
            "msg_count": 3100,
            "first_iso": "2016-12-25",
            "last_iso": "2026-06-14",
            "days_since_last": 14,
            "distinct_senders": 5,
            "peak_month": "2021-02",
            "life_status": "cooling",
            "monthly": {},
            "members": [
                {"sender_name": "Mom", "msg_count": 1100, "share_pct": 35},
                {"sender_name": "Marcus Chen", "msg_count": 800, "share_pct": 26},
                {"sender_name": "Demo User", "msg_count": 600, "share_pct": 19},
                {"sender_name": "Dad", "msg_count": 400, "share_pct": 13},
                {"sender_name": "Aunt Lisa", "msg_count": 200, "share_pct": 7},
            ],
        },
        {
            "thread_id": "im:bookclub",
            "source": "imessage",
            "name": "Book Club",
            "participants_raw": ["Demo User", "Dani Reeves", "Nina Okafor", "Sophie Lane", "Tom Hardy"],
            "msg_count": 2800,
            "first_iso": "2021-03-01",
            "last_iso": "2026-06-20",
            "days_since_last": 8,
            "distinct_senders": 5,
            "peak_month": "2023-11",
            "life_status": "active",
            "monthly": {},
            "members": [
                {"sender_name": "Dani Reeves", "msg_count": 900, "share_pct": 32},
                {"sender_name": "Demo User", "msg_count": 700, "share_pct": 25},
                {"sender_name": "Nina Okafor", "msg_count": 500, "share_pct": 18},
                {"sender_name": "Sophie Lane", "msg_count": 400, "share_pct": 14},
                {"sender_name": "Tom Hardy", "msg_count": 300, "share_pct": 11},
            ],
        },
        {
            "thread_id": "fb:collegegang",
            "source": "messenger",
            "name": "College Gang",
            "participants_raw": ["Demo User", "Maya Torres", "Leo Reeves", "Amy Zhao", "Chris Ng", "Rachel Liu", "Kevin Park"],
            "msg_count": 12400,
            "first_iso": "2016-09-15",
            "last_iso": "2025-08-20",
            "days_since_last": 312,
            "distinct_senders": 7,
            "peak_month": "2017-11",
            "life_status": "dormant",
            "monthly": {},
            "members": [
                {"sender_name": "Maya Torres", "msg_count": 3100, "share_pct": 25},
                {"sender_name": "Leo Reeves", "msg_count": 2800, "share_pct": 23},
                {"sender_name": "Demo User", "msg_count": 2400, "share_pct": 19},
                {"sender_name": "Amy Zhao", "msg_count": 1800, "share_pct": 15},
                {"sender_name": "Chris Ng", "msg_count": 1200, "share_pct": 10},
                {"sender_name": "Rachel Liu", "msg_count": 700, "share_pct": 5},
                {"sender_name": "Kevin Park", "msg_count": 400, "share_pct": 3},
            ],
        },
        {
            "thread_id": "dc:gamingsquad",
            "source": "discord",
            "name": "Gaming Squad",
            "participants_raw": ["Demo User", "Sam Fletcher", "Jordan Blake", "Mike_D", "Ash"],
            "msg_count": 5600,
            "first_iso": "2019-02-01",
            "last_iso": "2026-06-27",
            "days_since_last": 1,
            "distinct_senders": 5,
            "peak_month": "2024-12",
            "life_status": "active",
            "monthly": {},
            "members": [
                {"sender_name": "Sam Fletcher", "msg_count": 2100, "share_pct": 38},
                {"sender_name": "Demo User", "msg_count": 1400, "share_pct": 25},
                {"sender_name": "Jordan Blake", "msg_count": 1000, "share_pct": 18},
                {"sender_name": "Mike_D", "msg_count": 700, "share_pct": 12},
                {"sender_name": "Ash", "msg_count": 400, "share_pct": 7},
            ],
        },
    ]
    write_json('groups.json', {
        "generated": "2026-06-28T12:00:00.000Z",
        "count": len(groups),
        "groups": groups,
    })


def gen_cohorts():
    cohorts = [
        {
            "cohort_label": "Inner Circle",
            "total_msgs": 51500,
            "member_count": 4,
            "first": "2016-09-12",
            "last": "2026-06-27",
            "members": [
                {"display_name": "Maya Torres", "is_primary": True},
                {"display_name": "Leo Reeves", "is_primary": True},
                {"display_name": "Sam Fletcher", "is_primary": True},
                {"display_name": "Priya Sharma", "is_primary": False},
            ],
        },
        {
            "cohort_label": "Creative Friends",
            "total_msgs": 21500,
            "member_count": 4,
            "first": "2015-02-28",
            "last": "2026-06-20",
            "members": [
                {"display_name": "Mika Tanaka", "is_primary": True},
                {"display_name": "Dani Reeves", "is_primary": True},
                {"display_name": "Priya Sharma", "is_primary": False},
                {"display_name": "Zara Ahmed", "is_primary": False},
            ],
        },
        {
            "cohort_label": "Roots",
            "total_msgs": 10800,
            "member_count": 3,
            "first": "2010-08-22",
            "last": "2026-06-18",
            "members": [
                {"display_name": "James Wright", "is_primary": True},
                {"display_name": "Marcus Chen", "is_primary": True},
                {"display_name": "Nina Okafor", "is_primary": False},
            ],
        },
    ]
    bridges = [
        {"display_name": "Maya Torres", "group_count": 3},
        {"display_name": "Sam Fletcher", "group_count": 2},
        {"display_name": "Priya Sharma", "group_count": 2},
        {"display_name": "Leo Reeves", "group_count": 2},
        {"display_name": "Dani Reeves", "group_count": 2},
        {"display_name": "Marcus Chen", "group_count": 2},
    ]
    graduation = [
        {"display_name": "Maya Torres", "sequence": "group_first", "lag_days": 45, "group_name": "College Gang", "first_group_iso": "2016-09-15", "first_dm_iso": "2016-10-30"},
        {"display_name": "Leo Reeves", "sequence": "group_first", "lag_days": 120, "group_name": "College Gang", "first_group_iso": "2016-09-15", "first_dm_iso": "2017-01-13"},
        {"display_name": "Sam Fletcher", "sequence": "group_first", "lag_days": 30, "group_name": "The Apartment", "first_group_iso": "2018-12-20", "first_dm_iso": "2019-01-15"},
        {"display_name": "Jordan Blake", "sequence": "dm_first", "lag_days": 60, "group_name": "Gaming Squad", "first_group_iso": "2024-05-15", "first_dm_iso": "2024-03-15"},
        {"display_name": "Dani Reeves", "sequence": "group_first", "lag_days": 21, "group_name": "Book Club", "first_group_iso": "2021-01-25", "first_dm_iso": "2021-02-14"},
    ]
    write_json('cohorts.json', {
        "generated": "2026-06-28T12:00:00.000Z",
        "cohorts": cohorts,
        "bridges": bridges,
        "graduation": graduation,
    })


def gen_storyline():
    months = []
    for yr in range(2016, 2027):
        for mo in range(1, 13):
            if yr == 2026 and mo > 6:
                break
            months.append(f"{yr}-{mo:02d}")

    people_list = [{
        "canonical_id": p["id"],
        "display_name": p["name"],
        "sources": p["sources"],
        "total_msgs": p["msg_count"],
        "has_portrait": True,
        "first_ts": f"{p['first']}T00:00:00.000Z",
        "last_ts": f"{p['last']}T00:00:00.000Z",
    } for p in PEOPLE]

    # Generate plausible monthly activity per person
    activity = {}
    import hashlib
    for p in PEOPLE:
        first_yr, first_mo = int(p["first"][:4]), int(p["first"][5:7])
        last_yr, last_mo = int(p["last"][:4]), int(p["last"][5:7])
        person_months = {}
        total = 0
        for m in months:
            yr, mo = int(m[:4]), int(m[5:7])
            if (yr < first_yr) or (yr == first_yr and mo < first_mo):
                continue
            if (yr > last_yr) or (yr == last_yr and mo > last_mo):
                continue
            # Deterministic pseudo-random based on person id + month
            h = int(hashlib.md5(f"{p['id']}-{m}".encode()).hexdigest()[:8], 16)
            base = p["msg_count"] / max(1, ((last_yr - first_yr) * 12 + (last_mo - first_mo)))
            scale = 0.3 + (h % 100) / 50.0  # 0.3 to 2.3
            msgs = max(1, int(base * scale))
            mentions = max(0, int(msgs * 0.05 * ((h >> 8) % 10) / 5))
            person_months[m] = {"msgs": msgs, "mentions": mentions}
            total += msgs
        if person_months:
            activity[p["id"]] = person_months

    # co_active: top co-mention pairs per month
    co_active = {}
    ids = [p["id"] for p in PEOPLE]
    for m in months[24:]:  # skip first 2 years for density
        pairs = []
        for i, a in enumerate(ids):
            for b in ids[i+1:]:
                if m in activity.get(a, {}) and m in activity.get(b, {}):
                    h = int(hashlib.md5(f"{a}-{b}-{m}".encode()).hexdigest()[:6], 16)
                    if h % 5 == 0:
                        pairs.append([a, b, 1 + h % 8])
        if pairs:
            co_active[m] = sorted(pairs, key=lambda x: -x[2])[:5]

    write_json('storyline.json', {
        "generated": "2026-06-28T12:00:00.000Z",
        "months": months,
        "people": people_list,
        "activity": activity,
        "co_active": co_active,
    })


def gen_self_bundle():
    write_json('self_bundle.json', {
        "generated_at": "2026-06-28T12:00:00.000Z",
        "schema_version": 3,
        "knot_of_the_day": {
            "knot_id": "over-initiator",
            "claim": "You start 68% of conversations and then feel quietly resentful when the effort isn't matched — but you've never once named the expectation.",
            "confidence": "high",
            "lens_count": 5,
            "operational_move": "Pick one person this week — Priya or James — and let them initiate. Sit with the discomfort of not reaching first. Notice what happens.",
            "open_question": "Is the initiating a form of care, or a form of control?",
        },
        "strength_of_the_day": {
            "strength_id": "service-love",
            "claim": "You express care through action — showing up, building things, solving problems — and the people who feel most loved by you are the ones who learned to read the doing.",
            "confidence": "high",
            "lens_count": 6,
            "presence_signature": "The midnight DoorDash from Sam's thread, the ER drive in Maya's, the forty-minute pajama drive in Leo's — service verbs are your love language across every thread.",
            "amplification_move": "Tell one person this week why you did the thing. The doing is the love; naming it lets them receive it fully.",
        },
        "top_gap": {
            "name": "Nina Okafor",
            "days_silent": 98,
            "historical_baseline_30d": 3.2,
            "last_initiator": "her",
            "texture": "She congratulated you on the milestone in March. You replied with gratitude and a promise to catch up. The promise is still outstanding. She wouldn't judge the gap; she'd just ask the next question — which is exactly why you owe her the call.",
        },
        "today_question": {
            "question": "If Leo's sunrise photo — no caption, no ask — is the purest form of reaching out, what would it mean to receive it the way it was sent?",
            "knot_id": "over-initiator",
        },
        "whats_new": {
            "items": [
                {"claim": "Riley Park crossed 1,000 messages — the fastest anyone has reached that threshold since Sam in 2019."},
                {"claim": "James Wright's silence crossed 60 days — the longest gap since the thread began in 2010."},
                {"claim": "Priya's initiation rate increased to 45% — up from 30% six months ago. She's reaching more."},
            ],
            "counts": {"new": 3, "gone": 0, "stayed": 8, "drifted": 1},
        },
        "sources": {
            "knots_run": "2026-06-28",
            "knots_model": "claude-opus-4",
            "gaps_run": "2026-06-28",
        },
    })


def gen_fb_events():
    events = [
        {"fbid": "e001", "name": "Startup Weekend SF", "start_ts": 1579305600000, "end_ts": 1579478400000, "place_name": "Galvanize SF", "response": "joined"},
        {"fbid": "e002", "name": "Maya's Birthday Party", "start_ts": 1584230400000, "end_ts": None, "place_name": "Cedar Street Apartment", "response": "hosted"},
        {"fbid": "e003", "name": "SF Marathon", "start_ts": 1595116800000, "end_ts": None, "place_name": "San Francisco", "response": "joined"},
        {"fbid": "e004", "name": "Indie Game Showcase", "start_ts": 1601424000000, "end_ts": None, "place_name": "The Moscone Center", "response": "joined"},
        {"fbid": "e005", "name": "Bay Area Hiking Meetup", "start_ts": 1618531200000, "end_ts": None, "place_name": "Muir Woods", "response": "joined"},
        {"fbid": "e006", "name": "Tech Talks: Building in Public", "start_ts": 1626393600000, "end_ts": None, "place_name": "GitHub HQ", "response": "joined"},
        {"fbid": "e007", "name": "Climbing Competition", "start_ts": 1634860800000, "end_ts": None, "place_name": "Dogpatch Boulders", "response": "joined"},
        {"fbid": "e008", "name": "New Year's Eve 2022", "start_ts": 1640995200000, "end_ts": None, "place_name": None, "response": "joined"},
        {"fbid": "e009", "name": "Company Launch Party", "start_ts": 1643673600000, "end_ts": None, "place_name": "The Mill SF", "response": "hosted"},
        {"fbid": "e010", "name": "Podcast Live Recording", "start_ts": 1664582400000, "end_ts": None, "place_name": "The Chapel SF", "response": "hosted"},
        {"fbid": "e011", "name": "Book Club Annual Dinner", "start_ts": 1670025600000, "end_ts": None, "place_name": "Zuni Cafe", "response": "joined"},
        {"fbid": "e012", "name": "Leo's Housewarming", "start_ts": 1678147200000, "end_ts": None, "place_name": None, "response": "joined"},
        {"fbid": "e013", "name": "SF Design Week", "start_ts": 1686700800000, "end_ts": None, "place_name": "SFMOMA", "response": "joined"},
        {"fbid": "e014", "name": "Summer BBQ", "start_ts": 1689292800000, "end_ts": None, "place_name": "Dolores Park", "response": "hosted"},
        {"fbid": "e015", "name": "Patagonia Trip Planning Dinner", "start_ts": 1697155200000, "end_ts": None, "place_name": "Zara's Place", "response": "joined"},
        {"fbid": "e016", "name": "Holiday Potluck", "start_ts": 1703030400000, "end_ts": None, "place_name": "The Apartment", "response": "hosted"},
        {"fbid": "e017", "name": "Company All-Hands", "start_ts": 1706745600000, "end_ts": None, "place_name": "WeWork Mission", "response": "joined"},
        {"fbid": "e018", "name": "Art Gallery Opening - Mika", "start_ts": 1711065600000, "end_ts": None, "place_name": "Minnesota Street Project", "response": "joined"},
        {"fbid": "e019", "name": "Trail Running Relay", "start_ts": 1715299200000, "end_ts": None, "place_name": "Marin Headlands", "response": "joined"},
        {"fbid": "e020", "name": "Board Game Night", "start_ts": 1719532800000, "end_ts": None, "place_name": None, "response": "joined"},
    ]
    for e in events:
        e.setdefault("lat", None)
        e.setdefault("lng", None)
        e.setdefault("address", None)
        e.setdefault("description", None)
        e.setdefault("response_time", None)

    topics = [
        {"topic": "tech & startups", "n": 6, "sample_events": ["Startup Weekend SF", "Tech Talks", "Company Launch Party"]},
        {"topic": "outdoor & fitness", "n": 5, "sample_events": ["SF Marathon", "Bay Area Hiking Meetup", "Trail Running Relay"]},
        {"topic": "social gatherings", "n": 5, "sample_events": ["Summer BBQ", "Holiday Potluck", "Board Game Night"]},
        {"topic": "arts & culture", "n": 3, "sample_events": ["Art Gallery Opening", "SF Design Week", "Podcast Live Recording"]},
        {"topic": "food & dining", "n": 2, "sample_events": ["Book Club Annual Dinner", "Patagonia Trip Planning Dinner"]},
    ]
    write_json('fb-events.json', {"events": events, "topics": topics})


def gen_youtube():
    write_json('youtube.json', {
        "generated": "2026-06-28T12:00:00.000Z",
        "channels": 1,
        "self_channel": "Demo User",
        "subscriptions": [
            {"title": "3Blue1Brown", "url": "https://youtube.com/@3blue1brown"},
            {"title": "Bon Appetit", "url": "https://youtube.com/@bonappetit"},
            {"title": "Fireship", "url": "https://youtube.com/@Fireship"},
            {"title": "CGP Grey", "url": "https://youtube.com/@CGPGrey"},
            {"title": "Nerdwriter1", "url": "https://youtube.com/@Nerdwriter1"},
        ],
        "videos": [],
        "songs": [
            {"title": "Skinny Love", "artist": "Bon Iver"},
            {"title": "Motion Sickness", "artist": "Phoebe Bridgers"},
            {"title": "Mykonos", "artist": "Fleet Foxes"},
            {"title": "Dissolve", "artist": "Absofacto"},
            {"title": "Electric Feel", "artist": "MGMT"},
        ],
        "playlists": [],
        "comments": [],
        "watch_entries": [],
        "search_entries": [],
    })


def gen_annotations():
    write_json(['self', 'annotations.json'], {
        "over-initiator": {
            "verdict": "landed",
            "note": "This one stings because it's true. I counted — it really is 68%.",
            "kind": "knot",
            "last_updated_iso": "2026-06-25T14:30:00.000Z",
            "history": [],
        },
        "service-love": {
            "verdict": "landed",
            "note": "",
            "kind": "strength",
            "last_updated_iso": "2026-06-26T09:00:00.000Z",
            "history": [],
        },
    })


def gen_gaps():
    write_json(['self', 'gaps.json'], {
        "generated": "2026-06-28T12:00:00.000Z",
        "gaps": [
            {
                "canonical_id": "id-109",
                "display_name": "Nina Okafor",
                "days_silent": 98,
                "historical_baseline_30d": 3.2,
                "last_initiator": "her",
                "last_iso": "2026-03-22",
                "texture": "Quarterly check-ins have lapsed. She congratulated you in March; you haven't followed up.",
            },
            {
                "canonical_id": "id-108",
                "display_name": "James Wright",
                "days_silent": 79,
                "historical_baseline_30d": 1.8,
                "last_initiator": "him",
                "last_iso": "2026-04-10",
                "texture": "He sent a voice note about his career change. You listened, started replying, got distracted. The reply is overdue but not fraught.",
            },
            {
                "canonical_id": "id-106",
                "display_name": "Zara Ahmed",
                "days_silent": 29,
                "historical_baseline_30d": 4.5,
                "last_initiator": "you",
                "last_iso": "2026-05-30",
                "texture": "Restaurant recommendation sent; she's in a busy season. Normal pattern — she surfaces when work eases.",
            },
        ],
    })


if __name__ == '__main__':
    print(f"Generating demo data in {os.path.abspath(OUTPUT)}")
    os.makedirs(OUTPUT, exist_ok=True)
    gen_portraits()
    gen_checkins()
    gen_timeline()
    gen_graph()
    gen_groups()
    gen_cohorts()
    gen_storyline()
    gen_self_bundle()
    gen_fb_events()
    gen_youtube()
    gen_annotations()
    gen_gaps()
    print(f"\nDone. Run with:\n  DATA_DIR=./pipeline/output-demo node pipeline/serve.js")
