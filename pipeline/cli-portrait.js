#!/usr/bin/env node
/**
 * Portrait CLI.
 *
 *   npm run portrait                       # top N (MAX_PORTRAITS, default 20)
 *   npm run portrait -- --only "Maya"     # single person
 *   MAX_PORTRAITS=5 npm run portrait
 *
 * Requires ANTHROPIC_API_KEY in env. Auto-detects exports the same way cli.js does.
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
import { buildPortrait } from './agents/portrait/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INPUTS = path.join(ROOT, 'inputs');
const OUTPUT = path.join(__dirname, 'output');
const PORTRAITS_DIR = path.join(OUTPUT, 'portraits');
const NOTES_DIR = path.join(PORTRAITS_DIR, 'notes');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function safeFilename(name) { return name.replace(/[^\w\-]+/g, '_'); }

function parseArgs(argv) {
  const args = { only: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i];
  }
  return args;
}

function readNotesFor(name) {
  const p = path.join(NOTES_DIR, `${safeFilename(name)}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function loadAllThreads() {
  const allThreads = [];

  // Instagram autodetect
  let igRoot = path.join(INPUTS, 'instagram');
  if (!fs.existsSync(igRoot)) {
    const candidates = fs.readdirSync(ROOT).filter(d => d.startsWith('instagram-') && fs.statSync(path.join(ROOT, d)).isDirectory());
    igRoot = candidates.length ? path.join(ROOT, candidates.sort().reverse()[0]) : null;
  }
  if (igRoot && fs.existsSync(igRoot)) allThreads.push(...parseInstagramExport(igRoot));

  // iMessage autodetect
  let imsgDir = path.join(INPUTS, 'imessage');
  if (!fs.existsSync(imsgDir) && fs.existsSync(path.join(ROOT, 'imessage-export'))) {
    imsgDir = path.join(ROOT, 'imessage-export');
  }
  if (fs.existsSync(imsgDir)) allThreads.push(...parseImessageExport(imsgDir));

  if (fs.existsSync(path.join(INPUTS, 'whatsapp'))) allThreads.push(...parseWhatsappExport(path.join(INPUTS, 'whatsapp')));

  allThreads.push(...parseAllMessengerExports(INPUTS, ROOT));

  // Contacts autodetect
  let contactsPath = path.join(INPUTS, 'contacts.vcf');
  if (!fs.existsSync(contactsPath)) {
    const cd = path.join(ROOT, 'contacts');
    if (fs.existsSync(cd)) {
      const vcfs = fs.readdirSync(cd).filter(f => f.endsWith('.vcf'));
      if (vcfs.length) contactsPath = path.join(cd, vcfs[0]);
    }
  }
  const contacts = parseVcf(contactsPath);

  resolveIdentities(allThreads, contacts);
  return mergeThreadsByIdentity(allThreads);
}

async function main() {
  ensureDir(PORTRAITS_DIR);
  ensureDir(NOTES_DIR);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const max = parseInt(process.env.MAX_PORTRAITS || '20', 10);

  console.log('Loading messages and resolving identities...');
  const byIdentity = loadAllThreads();
  const ranked = rankRelationships(byIdentity, 200);

  let targets;
  if (args.only) {
    const match = ranked.find(r => r.displayName.toLowerCase() === args.only.toLowerCase());
    if (!match) {
      console.error(`No relationship matching "${args.only}".`);
      console.error('Top 10 names:');
      for (const r of ranked.slice(0, 10)) console.error(`  - ${r.displayName}`);
      process.exit(1);
    }
    targets = [match];
  } else {
    targets = ranked.slice(0, max);
  }

  console.log(`Generating portraits for ${targets.length} ${targets.length === 1 ? 'person' : 'people'}.`);
  const client = new Anthropic();

  for (const t of targets) {
    const entry = byIdentity.get(t.canonicalId);
    console.log(`\n→ ${t.displayName} (${t.messages.toLocaleString()} messages)`);
    try {
      const userNotes = readNotesFor(t.displayName);
      const result = await buildPortrait(client, {
        identity: { displayName: t.displayName, sources: t.sources, canonicalId: t.canonicalId },
        messages: entry.allMessages,
        userNotes,
      });
      const outPath = path.join(PORTRAITS_DIR, `${safeFilename(t.displayName)}.md`);
      fs.writeFileSync(outPath, result.markdown);
      console.log(`  wrote ${path.relative(ROOT, outPath)} (${result.attempts} attempt${result.attempts > 1 ? 's' : ''})`);
    } catch (err) {
      console.error(`  failed: ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
