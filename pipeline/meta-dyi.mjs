#!/usr/bin/env node
// Meta Download-Your-Information automation — runs ON THE HOMELAB.
//   node pipeline/meta-dyi.mjs setup     # headed browser; log into FB+IG once (Screen Sharing)
//   node pipeline/meta-dyi.mjs request   # weekly: request a messages-JSON export
//   node pipeline/meta-dyi.mjs poll      # daily: download ready exports → meta-drops/
//
// Philosophy: fail LOUD, never retry into a checkpoint. Any unexpected page
// → screenshot to logs + non-zero exit; the freshness nag surfaces it.
// Uses Meta's own export tool at weekly cadence — the gentlest automation
// there is — but still an unsanctioned logged-in bot session; see spec.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

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

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: !headed,
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] ?? await ctx.newPage();

if (mode === 'setup') {
  console.log('[meta-dyi] headed browser open. Log into facebook.com AND instagram.com,');
  console.log('then visit the DYI page to confirm it loads. Close the window when done.');
  await page.goto('https://facebook.com');
  await new Promise((resolve) => ctx.on('close', resolve));
  console.log('[meta-dyi] profile saved.');
  process.exit(0);
}

if (mode === 'request') {
  const state = loadState();
  const week = 7 * 86_400_000;
  if (state.lastRequest && Date.now() - state.lastRequest < week - 3_600_000) {
    console.log('[meta-dyi] last request < 1 week ago — skipping');
    await ctx.close(); process.exit(0);
  }
  await page.goto(DYI_URL, { waitUntil: 'networkidle', timeout: 60_000 });
  if (/login|checkpoint/i.test(page.url())) await bail(page, `not logged in (${page.url()})`);
  // The DYI flow's labels are stable-ish English; selectors here are the
  // expected-to-iterate part. First run MUST be supervised.
  try {
    await page.getByRole('button', { name: /download or transfer/i }).click({ timeout: 20_000 });
    await page.getByText(/specific types of information/i).click({ timeout: 20_000 });
    await page.getByText(/^messages$/i).first().click({ timeout: 20_000 });
    await page.getByRole('button', { name: /next/i }).click({ timeout: 20_000 });
    await page.getByText(/download to device/i).click({ timeout: 20_000 });
    await page.getByRole('button', { name: /next/i }).click({ timeout: 20_000 });
    // Format JSON + date range last 30 days when the options page offers them.
    const fmt = page.getByText(/format/i).first();
    if (await fmt.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await fmt.click();
      await page.getByText(/^json$/i).click({ timeout: 10_000 });
    }
    const range = page.getByText(/date range/i).first();
    if (await range.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await range.click();
      await page.getByText(/last 30 days|past 30 days/i).click({ timeout: 10_000 });
    }
    await page.getByRole('button', { name: /create files|submit request/i }).click({ timeout: 20_000 });
  } catch (e) {
    await bail(page, `request flow broke: ${e.message.slice(0, 120)}`);
  }
  fs.writeFileSync(STATE, JSON.stringify({ ...state, lastRequest: Date.now() }));
  console.log('[meta-dyi] export requested');
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
    const available = page.getByText(/available (files|downloads)/i).first();
    if (!(await available.isVisible({ timeout: 10_000 }).catch(() => false))) {
      console.log('[meta-dyi] no available-files section — nothing ready');
      await ctx.close(); process.exit(0);
    }
    await available.click();
    const buttons = await page.getByRole('button', { name: /^download$/i }).all();
    if (!buttons.length) {
      console.log('[meta-dyi] nothing ready to download');
      await ctx.close(); process.exit(0);
    }
    let saved = 0;
    for (const btn of buttons) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        btn.click(),
      ]);
      const name = `${Date.now()}-${download.suggestedFilename()}`;
      const zip = path.join(DROPS, name);
      await download.saveAs(zip);
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
