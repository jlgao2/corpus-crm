#!/usr/bin/env node
/**
 * Pipeline orchestrator.
 *
 *   node pipeline/cli.js
 *
 * Reads from ./inputs/, writes to ./pipeline/output/.
 * Set ANTHROPIC_API_KEY in env to enable agent stages.
 *
 * Stages:
 *   1. ingest       — parse all sources into the common schema
 *   2. resolve      — cross-channel identity resolution
 *   3. analyze      — per-person stats, intimacy ranking, loaded-language scan
 *   4. extract      — Sonnet pass per top-N relationship (parallel)
 *   5. synthesize   — Opus pass over all extracted profiles
 *   6. letter       — Opus pass producing the therapy starting point
 *
 * Each stage writes to ./pipeline/output/raw/ for resumability.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Anthropic from '@anthropic-ai/sdk';

import { parseInstagramExport } from './ingest/instagram.js';
import { parseImessageExport } from './ingest/imessage.js';
import { parseWhatsappExport } from './ingest/whatsapp.js';
import { parseAllMessengerExports } from './ingest/messenger.js';
import { parseVcf } from './ingest/contacts.js';

import { resolveIdentities, mergeThreadsByIdentity } from './normalize/identity.js';
import { rankRelationships } from './analyze/network.js';
import { scanThread } from './analyze/keywords.js';

import { extractAllProfiles } from './agents/extract.js';
import { synthesizeArchitecture } from './agents/synthesize.js';
import { writeTherapyLetter } from './agents/therapy-letter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INPUTS = path.join(ROOT, 'inputs');
const OUTPUT = path.join(__dirname, 'output');
const RAW = path.join(OUTPUT, 'raw');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function loadJsonIfExists(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : null;
}

async function main() {
  ensureDir(OUTPUT);
  ensureDir(RAW);
  ensureDir(path.join(OUTPUT, 'profiles'));

  const max = parseInt(process.env.MAX_RELATIONSHIPS || '15', 10);
  const skipAgents = process.env.SKIP_AGENTS === '1';

  // ─── Stage 1: Ingest ──────────────────────────────────────────────────────
  console.log('\n[1/6] Ingest');
  const allThreads = [];

  // Instagram: prefer ./inputs/instagram, else autodetect ./instagram-*/
  let igRoot = path.join(INPUTS, 'instagram');
  if (!fs.existsSync(igRoot)) {
    const candidates = fs.readdirSync(ROOT).filter(d => d.startsWith('instagram-') && fs.statSync(path.join(ROOT, d)).isDirectory());
    if (candidates.length) {
      igRoot = path.join(ROOT, candidates.sort().reverse()[0]);
      console.log(`  using ${path.basename(igRoot)}`);
    } else igRoot = null;
  }
  if (igRoot && fs.existsSync(igRoot)) allThreads.push(...parseInstagramExport(igRoot));

  // iMessage: prefer ./inputs/imessage, else ./imessage-export/
  let imsgDir = path.join(INPUTS, 'imessage');
  if (!fs.existsSync(imsgDir) && fs.existsSync(path.join(ROOT, 'imessage-export'))) {
    imsgDir = path.join(ROOT, 'imessage-export');
    console.log(`  using ${path.basename(imsgDir)}`);
  }
  if (fs.existsSync(imsgDir)) allThreads.push(...parseImessageExport(imsgDir));

  const waDir = path.join(INPUTS, 'whatsapp');
  if (fs.existsSync(waDir)) allThreads.push(...parseWhatsappExport(waDir));

  // Messenger: scan all known locations (./inputs/messenger, ./inputs/facebook-*, ./facebook-*).
  allThreads.push(...parseAllMessengerExports(INPUTS, ROOT));

  console.log(`  Total threads: ${allThreads.length}`);
  const totalMessages = allThreads.reduce((s, t) => s + t.messages.length, 0);
  console.log(`  Total messages: ${totalMessages.toLocaleString()}`);

  // ─── Stage 2: Resolve identities ─────────────────────────────────────────
  console.log('\n[2/6] Resolve identities');
  let contactsPath = path.join(INPUTS, 'contacts.vcf');
  if (!fs.existsSync(contactsPath)) {
    // Autodetect ./contacts/*.vcf
    const cd = path.join(ROOT, 'contacts');
    if (fs.existsSync(cd)) {
      const vcfs = fs.readdirSync(cd).filter(f => f.endsWith('.vcf'));
      if (vcfs.length) contactsPath = path.join(cd, vcfs[0]);
    }
  }
  const contacts = parseVcf(contactsPath);
  const { identities } = resolveIdentities(allThreads, contacts);
  console.log(`  Resolved ${identities.length} identities`);
  writeJson(path.join(RAW, 'identities.json'), identities);

  // Group threads by identity (for 1-on-1 only)
  const byIdentity = mergeThreadsByIdentity(allThreads);
  console.log(`  ${byIdentity.size} 1-on-1 relationships`);

  // ─── Stage 3: Analyze network ────────────────────────────────────────────
  console.log('\n[3/6] Analyze network');
  const ranked = rankRelationships(byIdentity, 100);
  writeJson(path.join(RAW, 'ranked.json'), ranked);

  // Print top 25 to stdout
  console.log(`  Top 25 by intimacy score:`);
  for (const r of ranked.slice(0, 25)) {
    console.log(`    ${r.intimacyScore.toFixed(1).padStart(6)}  ${r.messages.toString().padStart(6)} msg  ${r.firstISO}→${r.lastISO}  ${r.displayName}`);
  }

  // Network markdown
  const networkMd = renderNetworkMd(ranked, totalMessages);
  fs.writeFileSync(path.join(OUTPUT, 'network.md'), networkMd);

  // Loaded-language scans for top relationships
  const scans = {};
  for (const r of ranked.slice(0, max)) {
    const entry = byIdentity.get(r.canonicalId);
    scans[r.canonicalId] = scanThread(entry.allMessages);
  }
  writeJson(path.join(RAW, 'scans.json'), scans);

  if (skipAgents) {
    console.log('\nSKIP_AGENTS=1, stopping before agent stages.');
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\nANTHROPIC_API_KEY not set. Stopping before agent stages.');
    console.error('Run with SKIP_AGENTS=1 to confirm you want to skip them.');
    process.exit(1);
  }

  // ─── Stage 4: Extract per-person profiles (Sonnet, parallel) ─────────────
  console.log(`\n[4/6] Extract profiles (top ${max}, Sonnet parallel)`);
  let profilesOut = loadJsonIfExists(path.join(RAW, 'profiles.json'));
  if (!profilesOut) {
    profilesOut = await extractAllProfiles(ranked, byIdentity, { max, concurrency: 4 });
    writeJson(path.join(RAW, 'profiles.json'), profilesOut);
  } else {
    console.log('  reusing cached profiles.json');
  }

  // Write per-profile markdown
  for (const p of profilesOut) {
    if (!p.profile || p.profile.error) continue;
    const fname = (p.stats.displayName || p.stats.canonicalId).replace(/[^\w\-]+/g, '_');
    fs.writeFileSync(
      path.join(OUTPUT, 'profiles', `${fname}.md`),
      renderProfileMd(p),
    );
  }

  // ─── Stage 5: Synthesize architecture (Opus) ─────────────────────────────
  console.log('\n[5/6] Synthesize architecture (Opus)');
  const synthPath = path.join(OUTPUT, 'patterns.md');
  let synthesis = fs.existsSync(synthPath) ? fs.readFileSync(synthPath, 'utf-8') : null;
  if (!synthesis) {
    const client = new Anthropic();
    const networkStats = {
      totalMessages,
      firstISO: ranked.reduce((m, r) => r.firstISO < m ? r.firstISO : m, '9999-99-99'),
      lastISO: ranked.reduce((m, r) => r.lastISO > m ? r.lastISO : m, '0000-00-00'),
    };
    synthesis = await synthesizeArchitecture(client, profilesOut, networkStats);
    fs.writeFileSync(synthPath, synthesis);
  } else {
    console.log('  reusing cached patterns.md');
  }

  // ─── Stage 6: Therapy starting point (Opus) ──────────────────────────────
  console.log('\n[6/6] Therapy starting point (Opus)');
  const letterPath = path.join(OUTPUT, 'THERAPY_STARTING_POINT.md');
  if (!fs.existsSync(letterPath)) {
    const client = new Anthropic();
    const networkStats = {
      totalMessages,
      firstISO: ranked.reduce((m, r) => r.firstISO < m ? r.firstISO : m, '9999-99-99'),
      lastISO: ranked.reduce((m, r) => r.lastISO > m ? r.lastISO : m, '0000-00-00'),
    };
    const letter = await writeTherapyLetter(client, profilesOut, synthesis, networkStats);
    fs.writeFileSync(letterPath, letter);
  } else {
    console.log('  cached. Delete output/THERAPY_STARTING_POINT.md to re-run.');
  }

  console.log('\nDone. Output is at pipeline/output/');
  console.log('  - THERAPY_STARTING_POINT.md  ← bring this to your therapist');
  console.log('  - patterns.md');
  console.log('  - network.md');
  console.log('  - profiles/<name>.md');
}

function renderNetworkMd(ranked, totalMessages) {
  let s = `# Network\n\n`;
  s += `**${ranked.length}** relationships analyzed across **${totalMessages.toLocaleString()}** messages.\n\n`;
  s += `## Ranked by intimacy signal\n\n`;
  s += `| Score | Messages | Range | Days since last | Reciprocity | Late-night | Name |\n`;
  s += `|------:|---------:|-------|----------------:|------------:|-----------:|------|\n`;
  for (const r of ranked) {
    s += `| ${r.intimacyScore.toFixed(1)} | ${r.messages.toLocaleString()} | ${r.firstISO} → ${r.lastISO} | ${r.daysSinceLast} | ${(r.reciprocity * 100).toFixed(0)}% | ${(r.lateNightRatio * 100).toFixed(0)}% | ${r.displayName} |\n`;
  }
  s += `\n*Score is a composite of volume, span, density, recency, reciprocity, and late-night ratio. Use as a sort key, not a verdict.*\n`;
  return s;
}

function renderProfileMd(p) {
  const s = p.stats;
  const pr = p.profile;
  if (pr.error) return `# ${s.displayName}\n\nFailed: ${pr.error}\n`;

  let md = `# ${pr.name}\n\n`;
  md += `**Kind:** ${pr.kind}  \n`;
  md += `**Messages:** ${s.messages.toLocaleString()} (${s.fromMe} from you, ${s.fromThem} from them)  \n`;
  md += `**Range:** ${s.firstISO} → ${s.lastISO} (${s.spanDays} days)  \n`;
  md += `**Sources:** ${s.sources.join(', ')}  \n`;
  md += `**Last message:** ${s.daysSinceLast} days ago  \n\n`;
  md += `## Summary\n\n${pr.summary}\n\n`;
  md += `## Shape\n\n`;
  md += `- **Trajectory:** ${pr.shape.trajectory}\n`;
  md += `- **Balance:** ${pr.shape.balance}\n`;
  md += `- **Register:** ${pr.shape.register}\n\n`;
  md += `## Peak period\n\n${pr.peak_period.from} → ${pr.peak_period.to}\n\n`;
  md += `## What you do here\n\n${pr.what_user_does_with_this_person}\n\n`;
  md += `## What they do here\n\n${pr.what_person_does_with_user}\n\n`;
  if (pr.unsaid && pr.unsaid.trim()) {
    md += `## What's unsaid\n\n${pr.unsaid}\n\n`;
  }
  if (pr.loaded_moments && pr.loaded_moments.length) {
    md += `## Loaded moments\n\n`;
    for (const m of pr.loaded_moments) md += `- **${m.date}** — ${m.summary}\n`;
    md += `\n`;
  }
  if (pr.concern_level && pr.concern_level !== 'low') {
    md += `## Concern: ${pr.concern_level}\n\n${pr.concern_note}\n`;
  }
  return md;
}

main().catch(err => {
  console.error('\nFatal:', err);
  process.exit(1);
});
