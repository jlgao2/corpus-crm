# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A personal social-media-graph + portrait pipeline. Ingests messages from iMessage, WhatsApp, Instagram, Messenger, plus a 14-year Google Docs writing archive, and produces synthesized friend portraits, cross-portrait patterns, knot hypotheses, and a daily-read "self" surface — all served as a static-ish browser UI from `pipeline/output/`.

There is no React app. (The old D3 force-directed CRM graph + the mobile annotation PWA were removed on 2026-05-12.) All UI is plain HTML rendered by `pipeline/serve.js`.

## Top-level layout

```
inputs/          raw exports — imessage (symlinked), whatsapp-ios, whatsapp-live, instagram, messenger, writing/
contacts/        VCard export(s) for name resolution
pipeline/        the entire ingest → synthesize → render → serve pipeline
  ingest/        per-source ingesters
  normalize/     identity merging, aliasing, group classification
  agents/        LLM-driven synthesis (portrait generator, self/knots, etc.)
  self/          layer-2 self-portrait pipeline (knots, peaks, cross-portrait)
  render/        static HTML rendering for events
  crm-server/    Express backend (port 8766) — orphaned from the deleted PWA but kept
  output/        all generated artifacts (portraits, clusters, raw duckdb, sqlite, etc.)
  lib/           shared utilities (e.g. local-time.js — local-time rendering, see "Timezones")
  serve.js       static + dynamic server for pipeline/output/ (port 8765)
  crm-server.js  Express CRM backend (port 8766, HTTPS via tailscale cert if CRM_CERT/KEY set)
  cli*.js        per-task CLIs (cli.js orchestrates the full pipeline, cli-portrait.js for one person)
docs/            hand-written docs surfaced under /docs/<slug> on the serve.js UI
agents/          a single root-level analyze-relationship.js — separate from pipeline/agents/
AGENT_CONTEXT.md richer personal/work context about the user (Demo)
```

## Commands

```bash
npm run serve              # portrait/self UI at http://127.0.0.1:8765/
npm run pipeline           # full pipeline (ingest → normalize → build-* → render → synthesize)
npm run pipeline:no-agents # same, but skip the LLM synthesis pass
npm run portrait -- <Name> # generate / regenerate a single portrait
npm run build-db           # rebuild pipeline/output/raw/messages.duckdb from inputs/

npm run build-events          # photo events: faces × places × messages × fb_events (additive; never run build-photos.js — it wipes photo_faces)
npm run build-inferred-events # meetups inferred from messages (LLM confirm via locallmm :8100; verdict cache makes reruns free)
npm run build-rhythm          # week × local-hour message grid for /rhythm
npm run build-thumbs          # 320px thumb cache into output/thumbs — ships in releases so the homelab serves photos
npm run refresh               # nightly chain: pull → build-db (geocache snapshot/restore) → all layers → publish

npm run sync:push          # publish an immutable release to the homelab + relink CRM annotations
npm run sync:raw           # one-way raw-archive backup to the homelab (--dry-run by default via sync:raw:dry-run)

npm run crm:start          # crm-server.js in foreground (port 8766)
npm run crm:dev            # same, with --watch
npm run crm:test           # node --test on pipeline/crm-server/test/*.test.js
npm run crm:install-launchd   # install ~/Library/LaunchAgents/com.demouser.crm.plist
npm run crm:uninstall-launchd # the inverse
```

No global test framework. Tests are colocated as `*.test.js` under `pipeline/` and run with `node --test`.

## Data flow

```
inputs/ (raw exports)
   ↓ pipeline/ingest/*
pipeline/output/raw/messages.duckdb   ← canonical message store; ts is UTC unix ms
   ↓ pipeline/normalize/*  (identity merge, aliases, groups)
pipeline/output/{graph.json, timeline.json, groups.json, cohorts.json, ...}
   ↓ pipeline/agents/portrait/*  (LLM synthesis, expensive)
pipeline/output/portraits/*.md  +  pipeline/output/clusters/<Name>/*.md
   ↓ pipeline/self/{knots,peaks,...}  (layer-2 self synthesis)
pipeline/output/self/runs/<date>/{knots.json, peaks.json, ...}
   ↓ pipeline/serve.js
http://127.0.0.1:8765/  (portraits, sit-with queue, writing archive, docs, self surface)
```

## Events + the memory-graph views

`events` (in the duckdb) binds place × time × people: 2,145 photo events clustered by
time+location (participants from face recognition, names from attended fb_events,
GPS centers) + ~555 meetups inferred from message evidence (source='messages',
mevt_* ids, LLM-confirmed, cached in output/inferred-events/). Person↔person edges
land in `links` (`co_present_event`, `met_up_inferred`, `person_event`). Design
research + view rationale: docs/memory-graph-design.md (served at /docs/memory-graph-design).

Six server-rendered views over the graph (no React, all HTML/SVG from serve.js):
/years (almanacs) · /threads (the braid) · /weeks + /rhythm · /atlas (year maps) ·
/field (depth-stacked particle mosh) · plus /person deepening (sparkline, gap story).
All resolve Demo by display_name — canonical ids renumber on every build-db.

## Homelab deploys

Code: git push origin, then fetch + `git merge origin/feat/...` on the homelab's
deploy/homelab-current (its live-only WIP gets committed locally there first — never
stash-dropped, never pushed). Data: `npm run sync:push` publishes an immutable
release under pipeline/releases/ and swaps the output symlink. The homelab holds no
raw google archive requirement: thumbs ship inside releases (/thumb serves
cache-first; /photo degrades to the thumb when full-res is absent).

## Timezones (recurring pitfall)

`messages.ts_iso` is **UTC**. Never quote it raw in narrative analysis. Convert to the sender's local time using `pipeline/lib/local-time.js`, which uses a rule table keyed by canonical_id × date-window (Demo: Melbourne pre-2023-06, Chicago after; Maya: Melbourne baseline + Taipei caregiving windows; JB: Auckland baseline; etc.). For ad-hoc message extraction use `node pipeline/lib/render-msgs.js`. The portrait generator (`pipeline/agents/portrait/curate.js`) already threads local-time into anchor-quote prep.

## CRM SQLite backend (`pipeline/crm-server.js`)

Express server on port 8766, with optional HTTPS when `CRM_CERT`/`CRM_KEY` env vars point at a tailscale cert+key. Binds 127.0.0.1 and the tailscale IP. Backed by `pipeline/output/crm.sqlite` (tables: people, connections, interactions, person_tags). Currently has no first-party client — the mobile PWA that consumed it was removed. Kept because the server, schema, tests, and launchd setup are still useful (e.g. for a future client, a CLI, or external annotation tools).

## Conventions

- ESM (`"type": "module"`). All `.js` files use `import`/`export`.
- Pipeline scripts are runnable directly (`node pipeline/<x>.js`) — most also have an `npm run <x>` alias.
- Heavy LLM steps gated behind `SKIP_AGENTS=1` env var for the full pipeline; per-step scripts have their own `--dry-run`.
- Don't add new top-level frontends. UI lives at `pipeline/serve.js` and is served as HTML strings — keep it that way.
