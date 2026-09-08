#!/usr/bin/env node
// Meta Download-Your-Information automation — runs ON THE HOMELAB.
//   node pipeline/meta-dyi.mjs setup     # headed browser; log into FB+IG once (Screen Sharing)
//   node pipeline/meta-dyi.mjs request   # weekly: request messages JSON since the corpus's last message
//   node pipeline/meta-dyi.mjs poll      # daily: download ready exports → meta-drops/
//
// META_DYI_DRYRUN=1 with `request` configures the export but screenshots the
// confirm screen instead of submitting — use it to supervise the first run.
//
// Philosophy: fail LOUD, never retry into a checkpoint. Any unexpected page
// → screenshot to logs + non-zero exit; the freshness nag surfaces it.
// Uses Meta's own export tool at weekly cadence — the gentlest automation
// there is — but still an unsanctioned logged-in bot session; see spec.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { getMaxTs, computeSinceMs, pickPreset } from './meta-dyi-dates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(os.homedir(), '.meta-dyi-profile');
const safeDataDir = (configured, fallback, label) => {
  const resolved = path.resolve(configured || fallback);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} cannot be a filesystem root: ${resolved}`);
  }
  return resolved;
};
// The browser job may run from a disposable code checkout, but downloaded and
// unpacked exports must not. The launchd installer points both paths at the
// homelab data lake; these fallbacks preserve ad-hoc workstation behavior.
const INPUTS = safeDataDir(process.env.META_DYI_INPUTS_DIR, path.join(ROOT, 'inputs'), 'META_DYI_INPUTS_DIR');
const DROPS = safeDataDir(process.env.META_DYI_DROPS_DIR, path.join(ROOT, 'meta-drops'), 'META_DYI_DROPS_DIR');
const LOGS = path.join(ROOT, 'pipeline', 'output', 'logs');
const STATE = path.join(DROPS, 'state.json');
const DYI_URL = 'https://accountscenter.facebook.com/info_and_permissions/dyi';

fs.mkdirSync(DROPS, { recursive: true });
fs.mkdirSync(INPUTS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const mode = process.argv[2];
const headed = mode === 'setup';

async function bail(page, why) {
  const shot = path.join(LOGS, `meta-dyi-fail-${Date.now()}.png`);
  try { await page.screenshot({ path: shot, fullPage: true }); } catch {}
  console.error(`[meta-dyi] FAIL: ${why} — screenshot: ${shot}`);
  process.exit(1);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

// Meta blocks/checkpoints logins from an obviously-automated browser, so the
// session never persists. Launch real Chrome (not Chrome-for-Testing), drop the
// automation switches, and null navigator.webdriver — the flag Meta reads. Set
// META_DYI_CHANNEL=chromium on a box without Google Chrome (e.g. headless Linux).
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !headed,
  channel: process.env.META_DYI_CHANNEL === 'chromium' ? undefined : 'chrome',
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = ctx.pages()[0] ?? await ctx.newPage();

// Meta's SPA leaves every prior sheet mounted, so a locator often resolves to
// several stacked (mostly hidden) copies. Always act on the visible one.
const vClick = (loc) => loc.filter({ visible: true }).first().click({ timeout: 20_000 });

// Both submitting an export and downloading one are gated behind a password
// re-auth ("Please re-enter your password"). Until it clears, the action does
// nothing at all — so an unanswered prompt must fail, never pass silently.
async function clearPasswordGate() {
  const prompt = page.getByText(/re-enter your password/i).filter({ visible: true }).first();
  // isVisible() does not wait — the prompt renders a beat after the click.
  if (!(await prompt.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) return;
  // Env var wins; unattended launchd runs read the login Keychain
  // (security add-generic-password -s meta-dyi -a you -w '...').
  const pw = process.env.META_DYI_PASSWORD || (() => {
    try { return execSync('security find-generic-password -s meta-dyi -w', { encoding: 'utf8' }).trim(); }
    catch { return ''; }
  })();
  if (!pw) throw new Error('Meta wants the password re-entered; set META_DYI_PASSWORD or add Keychain item "meta-dyi"');
  await page.getByRole('textbox').filter({ visible: true }).first().fill(pw);
  await vClick(page.getByRole('button', { name: /^continue$/i }));
  for (let i = 0; i < 60; i++) {
    if (!(await prompt.isVisible().catch(() => false))) return;
    await page.waitForTimeout(500);
  }
  throw new Error('password re-auth did not clear');
}

if (mode === 'setup') {
  console.log('[meta-dyi] headed browser open. Log into facebook.com AND instagram.com,');
  console.log('then visit the DYI page to confirm it loads. Close the window when done.');
  await page.goto('https://facebook.com');
  await new Promise((resolve) => ctx.on('close', resolve));
  console.log('[meta-dyi] profile saved.');
  process.exit(0);
}

// Accounts Center keeps one profile per app, each needing its own export.
// Facebook carries Messenger; Instagram carries IG DMs.
//
// Both ingesters now merge many export roots, so short date ranges are additive
// for either profile: messenger scans inputs/messenger/*, instagram layers
// inputs/instagram-dyi-* over the inputs/instagram base and dedupes on message
// identity. Force a full history with META_DYI_IG_PRESET=all when re-baselining.
const PROFILES = [
  { key: 'facebook', label: 'Facebook', source: 'messenger', incremental: true },
  {
    key: 'instagram',
    label: 'Instagram',
    source: 'instagram',
    incremental: !process.env.META_DYI_IG_PRESET,
    preset: process.env.META_DYI_IG_PRESET,
  },
];

if (mode === 'request') {
  const state = loadState();
  const week = 7 * 86_400_000;
  // Per-profile timestamps so one profile's success never suppresses the
  // other's retry (older builds stored a single scalar — migrate it).
  const last = typeof state.lastRequest === 'object' && state.lastRequest !== null
    ? { ...state.lastRequest }
    : (state.lastRequest ? { facebook: state.lastRequest } : {});

  const only = process.env.META_DYI_PROFILE;
  const due = PROFILES.filter((p) => (!only || only === p.key)
    && !(last[p.key] && Date.now() - last[p.key] < week - 3_600_000));
  if (!due.length) {
    console.log('[meta-dyi] all profiles requested < 1 week ago — skipping');
    await ctx.close(); process.exit(0);
  }

  // How far back to ask: the corpus knows. Request everything since the last
  // message we already have for that source (minus a safety margin), mapped to
  // the smallest date preset that covers the gap.
  for (const p of due) {
    if (p.incremental) {
      try {
        const maxTs = await getMaxTs(p.source);
        const sinceMs = computeSinceMs({ maxTsMs: maxTs });
        p.preset = pickPreset(sinceMs, Date.now());
        console.log(
          `[meta-dyi] corpus max(${p.source})=${maxTs ? new Date(maxTs).toISOString().slice(0, 10) : 'none'}` +
          ` → since ${sinceMs ? new Date(sinceMs).toISOString().slice(0, 10) : 'all time'} (preset: ${p.preset})`,
        );
      } catch (e) {
        console.error(`[meta-dyi] FAIL: cannot read corpus for since-date: ${e.message}`);
        await ctx.close(); process.exit(1);
      }
    } else {
      console.log(`[meta-dyi] ${p.label}: preset ${p.preset} (ingester needs one self-contained root)`);
    }
  }
  const PRESET_LABELS = {
    'last-week': /^Last week$/i,
    'last-month': /^Last month$/i,
    'last-3-months': /^Last 3 months$/i,
    'last-6-months': /^Last 6 months$/i,
    'last-year': /^Last year$/i,
    'last-3-years': /^Last 3 years$/i,
    'all': /^All time$/i,
  };

  const dryRun = process.env.META_DYI_DRYRUN === '1';
  // The DYI flow is: Create export → choose profile → export destination →
  // a "Confirm your export" hub. From the hub each option (Customize / Format /
  // Date range) opens a sub-sheet with its own Save. Selectors are the
  // expected-to-iterate part; bail() screenshots any drift. First run MUST be
  // supervised — use META_DYI_DRYRUN=1 to configure but stop before submitting.
  // Treat the visible "Start export" button as the signal we're back on the hub
  // (a sub-sheet overlays it; closing the sheet reveals it again).
  const waitHub = () => page.getByRole('button', { name: /start export/i })
    .filter({ visible: true }).first().waitFor({ timeout: 20_000 });
  // A sub-sheet is open iff a "Save" button is visible (the hub has none). Wait
  // on that rather than on the hub, which stays laid-out (merely occluded) under
  // an open sheet and so always reads as "visible".
  const saveAndReturn = async () => {
    await vClick(page.getByRole('button', { name: /^save$/i }));
    const openSheet = page.getByRole('button', { name: /^save$/i }).filter({ visible: true });
    for (let i = 0; i < 60; i++) {
      if ((await openSheet.count()) === 0) return;
      await page.waitForTimeout(250);
    }
    throw new Error('sub-sheet stayed open after Save');
  };
  for (const p of due) {
    // Each profile is a fresh pass through the wizard — reload so no sheet from
    // the previous profile is still mounted.
    await page.goto(DYI_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    if (/login|checkpoint/i.test(page.url())) await bail(page, `not logged in (${page.url()})`);
    try {
      await vClick(page.getByRole('button', { name: /create export|download or transfer/i }));
      await vClick(page.getByText(p.label, { exact: true }));              // choose profile
      await vClick(page.getByText(/export to device/i));                   // destination
      await waitHub();

      // Leave "Customize information" at its default (all available information
      // excluding data logs) — we want the heavy categories too (photos, posts,
      // media), not just messages. Only format and date range need changing.

      // Format → JSON (default HTML can't be ingested).
      await vClick(page.getByText(/^format$/i));
      await vClick(page.getByText(/^json$/i));
      await saveAndReturn();

      // Date range → the preset chosen for this profile above.
      await vClick(page.getByText(/^date range$/i));
      await vClick(page.getByText(PRESET_LABELS[p.preset]));
      await saveAndReturn();

      if (dryRun) {
        const cfg = await page.evaluate(() => {
          const out = {};
          for (const el of document.querySelectorAll('[role="button"]')) {
            if (!el.checkVisibility?.()) continue;
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (/^Format/.test(t)) out.format = t;
            else if (/^Date range/.test(t)) out.dateRange = t;
            else if (/^Customize information/.test(t)) out.customize = t;
          }
          return out;
        });
        const shot = path.join(LOGS, `meta-dyi-dryrun-${p.key}-${Date.now()}.png`);
        await page.screenshot({ path: shot });
        console.log(`[meta-dyi] DRY RUN ${p.label} config: ${JSON.stringify(cfg)}`);
        console.log(`[meta-dyi] DRY RUN — configured but NOT submitted. Review: ${shot}`);
        continue;
      }
      await vClick(page.getByRole('button', { name: /start export/i }));
      await clearPasswordGate();
    } catch (e) {
      await bail(page, `request flow broke (${p.label}): ${e.message.slice(0, 120)}`);
    }
    last[p.key] = Date.now();
    fs.writeFileSync(STATE, JSON.stringify({ ...state, lastRequest: last }));
    console.log(`[meta-dyi] export requested: ${p.label}`);
  }
  await ctx.close(); process.exit(0);
}

// Unpack a drop straight into durable corpus inputs so it is ingestable here,
// not only after the laptop copies it. The zip is deliberately LEFT in place
// as the immutable source artifact.
function ensureLocalInputLink(name, target) {
  const localInputs = path.join(ROOT, 'inputs');
  const link = path.join(localInputs, name);
  if (path.resolve(INPUTS) === path.resolve(localInputs)) return;
  fs.mkdirSync(localInputs, { recursive: true });
  if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
    if (fs.lstatSync(link).isSymbolicLink()) {
      const current = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (current === path.resolve(target)) return;
    }
    throw new Error(`refusing to replace existing ingest path: ${link}`);
  }
  const next = path.join(localInputs, `.${name}.next-${process.pid}`);
  if (fs.existsSync(next) || fs.lstatSync(next, { throwIfNoEntry: false })) {
    throw new Error(`staging link already exists: ${next}`);
  }
  fs.symlinkSync(target, next, 'dir');
  try {
    fs.renameSync(next, link);
  } catch (error) {
    fs.unlinkSync(next);
    throw error;
  }
}

function unpackDrop(zip) {
  const listing = execFileSync('unzip', ['-l', zip], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const base = path.basename(zip);
  const stamp = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${base.split('-')[0]}`;
  const unzipTo = (dest) => {
    if (fs.existsSync(dest)) {
      console.log(`[meta-dyi] immutable export already exists, leaving it unchanged: ${dest}`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const partial = path.join(path.dirname(dest), `.${path.basename(dest)}.partial-${process.pid}`);
    if (fs.existsSync(partial)) throw new Error(`staging path already exists: ${partial}`);
    fs.mkdirSync(partial);
    try {
      execFileSync('unzip', ['-q', '-o', zip, '-d', partial], { stdio: 'inherit' });
      fs.renameSync(partial, dest);
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw error;
    }
  };

  // Instagram incremental roots layer beside the all-time base; they never
  // replace it because newer Meta exports are not guaranteed supersets.
  if (/your_instagram_activity\/messages\/inbox\//.test(listing)) {
    const dest = path.join(INPUTS, `instagram-dyi-${stamp}`);
    unzipTo(dest);
    ensureLocalInputLink(path.basename(dest), dest);
    console.log(`[meta-dyi] unpacked → ${dest}`);
    return;
  }
  // Messenger: the ingester scans many roots under inputs/messenger, so
  // dropping another one in is additive and safe.
  if (/(your_facebook_activity\/)?messages\/(inbox|e2ee_cutover)\//.test(listing)) {
    const dest = path.join(INPUTS, 'messenger', `dyi-${stamp}`);
    unzipTo(dest);
    ensureLocalInputLink('messenger', path.join(INPUTS, 'messenger'));
    console.log(`[meta-dyi] unpacked → ${dest}`);
    return;
  }
  console.log(`[meta-dyi] ${base} has no messages tree — left for manual routing`);
}

if (mode === 'poll') {
  await page.goto(DYI_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  if (/login|checkpoint/i.test(page.url())) await bail(page, `not logged in (${page.url()})`);
  try {
    const available = page.getByText(/available (files|downloads)/i).filter({ visible: true }).first();
    // isVisible() does not wait; without a real wait a slow render reads as
    // "nothing ready" and the export is silently missed.
    if (!(await available.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false))) {
      console.log('[meta-dyi] no available-files section — nothing ready');
      await ctx.close(); process.exit(0);
    }
    await available.click();

    // Two buttons both read "Download": the one on the job card only navigates
    // to the "Download your files" screen; the one there starts the transfer,
    // behind the same password gate as Start export.
    const dlButtons = () => page.getByRole('button', { name: /^download$/i }).filter({ visible: true });
    if (!(await dlButtons().count())) {
      console.log('[meta-dyi] nothing ready to download');
      await ctx.close(); process.exit(0);
    }
    await vClick(dlButtons());
    await page.getByText(/download your files/i).filter({ visible: true }).first()
      .waitFor({ timeout: 20_000 });

    const count = await dlButtons().count();
    let saved = 0;
    for (let i = 0; i < count; i++) {
      // Arm the listener before the click — the transfer starts as soon as the
      // password clears, and a 100MB+ export is slow.
      const download = page.waitForEvent('download', { timeout: 900_000 });
      await dlButtons().nth(i).click({ timeout: 20_000 });
      await clearPasswordGate();
      const d = await download;
      const name = `${Date.now()}-${d.suggestedFilename()}`;
      const zip = path.join(DROPS, name);
      await d.saveAs(zip);
      console.log(`[meta-dyi] saved ${name}`);
      unpackDrop(zip);
      saved++;
    }
    console.log(`[meta-dyi] ${saved} file(s) → ${DROPS}`);
  } catch (e) {
    await bail(page, `poll flow broke: ${e.message.slice(0, 120)}`);
  }
  await ctx.close(); process.exit(0);
}

console.error('usage: meta-dyi.mjs <setup|request|poll>');
process.exit(1);
