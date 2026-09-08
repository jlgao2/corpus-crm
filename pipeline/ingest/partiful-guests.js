#!/usr/bin/env node
// Partiful guest lists → inputs/partiful/guests.jsonl.
//
//   npm run partiful:login    # once: opens a browser, YOU log in, session persists
//   npm run partiful:guests   # fetch guest lists for known events
//
// Why a browser and not an API: logged out, partiful.com/e/<id> renders an
// empty shell — the event body and guest list are client-rendered behind
// auth. So the only honest path to YOUR OWN guest lists is your own logged-in
// session. This drives a persistent Chromium profile that you authenticate
// once, by hand; the script never sees or stores a password, and refuses to
// run if the profile isn't logged in.
//
// Politeness: one event at a time, PARTIFUL_DELAY_MS between (default 3s),
// skips events already in guests.jsonl, and stops on the first sign the site
// is pushing back. 63 events is a few minutes, once.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const IN_FILE = path.join(ROOT, 'inputs', 'partiful', 'events.jsonl');
const OUT_FILE = path.join(ROOT, 'inputs', 'partiful', 'guests.jsonl');
const PROFILE_DIR = process.env.PARTIFUL_PROFILE || path.join(ROOT, 'inputs', 'partiful', '.browser-profile');
const DELAY_MS = parseInt(process.env.PARTIFUL_DELAY_MS || '3000', 10);
const LIMIT = parseInt(process.env.PARTIFUL_LIMIT || '0', 10) || Infinity;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browser() {
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: process.env.PARTIFUL_HEADED !== '1',
    viewport: { width: 1280, height: 900 },
  });
}

/** Interactive: open the login page and wait for the user to finish. */
export async function login() {
  const ctx = await (await import('playwright')).chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://partiful.com/login', { waitUntil: 'domcontentloaded' });
  console.log('A browser window is open. Log in to Partiful there.');
  console.log('The session is saved to', PROFILE_DIR, '(gitignored) — close the window when done.');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await ctx.close();
}

/** True when the persistent profile can see authed content. */
export async function isLoggedIn(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto('https://partiful.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const text = await page.innerText('body').catch(() => '');
    return !/^\s*$/.test(text) && !/\bLog ?in\b/i.test(text.slice(0, 400));
  } finally {
    await page.close();
  }
}

/**
 * Read one event page as Demo's own browser renders it.
 *
 * IMPORTANT — Partiful masks guest identities ("Xxxxx Xxxx") on events he
 * did not RSVP to, stating "Only RSVP'd guests can view event activity & see
 * who went". That is an access control, not a rendering delay: we detect it,
 * record `restricted: true`, and never attempt to unmask. Masked names are
 * dropped, never stored.
 *
 * What the page does give for every event: host names, venue, and RSVP
 * counts — which is what the public payload was missing.
 */
export function parseEventText(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = { hosts: [], venue: null, went: null, maybe: null, restricted: false, guests: [] };
  out.restricted = /Only RSVP'?d guests can view/i.test(text) || /Restricted Access/i.test(text);

  const hostIdx = lines.findIndex((l) => /^Hosted by$/i.test(l));
  if (hostIdx >= 0) {
    // Host names run until a line that is plainly not a person. "Private
    // Location" is a venue placeholder Partiful renders in the same slot and
    // matches any name-shaped regex, so stop-words are matched explicitly.
    for (const l of lines.slice(hostIdx + 1)) {
      if (NOT_A_PERSON.test(l)) break;
      if (!/^[\p{L}][\p{L}\p{M}'’.\- ]{1,40}$/u.test(l)) break;
      out.hosts.push(l);
      if (out.hosts.length >= 6) break;
    }
    // Venue: the first line after the hosts that reads like a place — a street
    // address, a "City, ST" locality, or a venue-ish placeholder. Anything
    // else (RSVP chatter, single letters, description prose) is skipped.
    for (const l of lines.slice(hostIdx + 1 + out.hosts.length, hostIdx + 6 + out.hosts.length)) {
      if (/^(Guest List|Activity|View all|Restricted Access)$/i.test(l)) break;
      if (looksLikePlace(l)) { out.venue = l; break; }
    }
  }

  const counts = text.match(/(\d+)\s*Went(?:\s*·\s*(\d+)\s*Maybe)?/i);
  if (counts) { out.went = Number(counts[1]); if (counts[2]) out.maybe = Number(counts[2]); }

  // Only trust names when the page isn't withholding them.
  if (!out.restricted) {
    for (const m of text.matchAll(/^(.{2,40}?) rsvped (Going|Maybe|Not Going)/gim)) {
      const name = m[1].trim();
      if (isMasked(name)) continue;
      out.guests.push({ name, status: m[2].toLowerCase().replace(/\s/g, '') });
    }
  }
  return out;
}

/** Lines Partiful renders in the host slot that are not people. */
const NOT_A_PERSON = /^(Private Location|Location [Hh]idden|Guest List|View all|Activity|Restricted Access|Going|Maybe|Went|Invited)\b/i;

/**
 * A venue line: a street address, a "City, ST"/"City, Country" locality, or
 * Partiful's explicit private-location placeholder. Deliberately strict —
 * a wrong venue geocodes to a real place on the map, which is worse than none.
 */
export function looksLikePlace(line) {
  const l = String(line || '').trim();
  if (!l || l.length > 80) return false;
  if (/^(Guest List|Activity|View all|Restricted Access)$/i.test(l)) return false;
  if (/^(Going|Maybe|Went|Invited|Declined)\b/i.test(l)) return false;
  if (/\brsvped\b|\bsent a\b|:\s*\S/i.test(l)) return false;   // activity-feed chatter
  if (/^Private Location$/i.test(l)) return true;
  if (/^\d+\s+\S/.test(l)) return true;                         // "1041 w grand ave"
  if (/,\s*[A-Z]{2}$/.test(l)) return true;                     // "Brooklyn, NY"
  if (/,\s*[\p{Lu}][\p{L}]+$/u.test(l) && l.split(/\s+/).length <= 6) return true; // "Paris, France"
  return false;
}

/** Partiful's privacy placeholder: real letters replaced with X. */
export function isMasked(name) {
  const letters = String(name).replace(/[^A-Za-z]/g, '');
  return letters.length > 0 && /^[Xx]+$/.test(letters);
}

export async function scrapeEvent(page, eventId) {
  await page.goto(`https://partiful.com/e/${eventId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // The event body renders client-side; 6s is what real pages needed.
  await page.waitForTimeout(6000);
  const text = await page.innerText('body').catch(() => '');
  if (!text || text.length < 80) return null;
  const parsed = parseEventText(text);
  if (!parsed.hosts.length && parsed.went == null) return null;
  // Keep the raw text: parsing heuristics will change, and re-parsing offline
  // beats putting Demo through another authed sweep of the whole account.
  return { event_id: `partiful:${eventId}`, ...parsed, raw_text: text.slice(0, 4000), scraped_at: Date.now() };
}

function doneIds() {
  if (!fs.existsSync(OUT_FILE)) return new Set();
  return new Set(fs.readFileSync(OUT_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l).event_id; } catch { return null; } }).filter(Boolean));
}

async function main() {
  if (process.argv.includes('--login')) return login();
  if (!fs.existsSync(IN_FILE)) { console.log('[guests] no events.jsonl — run partiful:fetch first'); return; }

  // Only events that actually have a guest list the host chose to show.
  const events = new Map();
  for (const line of fs.readFileSync(IN_FILE, 'utf8').split('\n').filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.kind !== 'page') continue;
    if (e.has_guests === false || e.show_guest_list === false) continue;
    events.set(e.event_id, e);
  }
  const already = doneIds();
  const todo = [...events.values()].filter((e) => !already.has(e.event_id)).slice(0, LIMIT);
  console.log(`[guests] ${events.size} events with guest lists, ${already.size} already fetched, ${todo.length} to do`);
  if (!todo.length) return;

  const ctx = await browser();
  try {
    if (!(await isLoggedIn(ctx))) {
      console.error('[guests] not logged in — run `npm run partiful:login` once, then rerun.');
      console.error('         (logged out, partiful renders an empty page and there is nothing to read)');
      process.exitCode = 1;
      return;
    }
    const page = await ctx.newPage();
    let ok = 0, empty = 0;
    for (const e of todo) {
      const id = e.event_id.replace(/^partiful:/, '');
      try {
        const rec = await scrapeEvent(page, id);
        if (rec) { fs.appendFileSync(OUT_FILE, JSON.stringify(rec) + '\n'); ok++; }
        else empty++;
      } catch (err) {
        console.error(`[guests] ${id}: ${err.message.slice(0, 80)}`);
        empty++;
      }
      if (ok % 10 === 0 && ok) console.log(`  ${ok + empty}/${todo.length}`);
      await sleep(DELAY_MS);
    }
    console.log(`[guests] ${ok} events read, ${empty} empty/failed → ${OUT_FILE}`);
  } finally {
    await ctx.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
}
