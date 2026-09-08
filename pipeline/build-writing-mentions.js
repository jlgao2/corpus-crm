#!/usr/bin/env node
/**
 * Scan first-person writing (inputs/writing/*.md) for mentions of known
 * identities, and emit per-person quote dumps alongside the existing
 * message-mentions output.
 *
 *   npm run build-writing-mentions
 *
 * Outputs: pipeline/output/portraits/writing-mentions/<slug>.md  (one per person)
 *
 * Designed to complement build-mentions.js — same slug convention, similar
 * markdown shape — so a downstream portrait synthesizer can fold writing
 * quotes alongside message quotes without special-casing the source.
 *
 * Matching rules:
 *   - For each identity, candidate "forms" = display_name + any alphabetic aliases
 *   - Drop forms that look like phone numbers, emails, emoji, or are <2 chars
 *   - Case-insensitive word-boundary match in line text
 *   - For 2-char forms (e.g. "JB") require uppercase context (line.includes(form))
 *     to suppress noise like "ej" inside other words
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const WRITING_DIR = path.join(__dirname, '..', 'inputs', 'writing');
const OUT_DIR = path.join(__dirname, 'output', 'portraits', 'writing-mentions');

function safeFilename(s) {
  return s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAlphabeticName(s) {
  // Accept letter runs (ASCII + unicode) joined by space/hyphen/apostrophe
  if (s.length < 2) return false;
  if (/@/.test(s)) return false;                // email
  if (/^\+?\d[\d\s\-]*$/.test(s)) return false; // phone
  if (!/^[\p{L}][\p{L} \-’']*$/u.test(s)) return false; // start with a letter, then letters/space/hyphen/apostrophe only
  // Reject all-lowercase forms — they're either common English words (care, three, wise)
  // or redundant with a properly-cased variant already in the identity's forms.
  // Case-insensitive regex still picks up "nina" / "JB" / "bill" via the uppercase form.
  if (s === s.toLowerCase() && !/[\p{Lu}]/u.test(s)) return false;
  return true;
}

function resolveAliases(rawAliases) {
  // DuckDB returns array column as { items: [...] } in some versions
  if (!rawAliases) return [];
  if (Array.isArray(rawAliases)) return rawAliases;
  if (rawAliases.items) return rawAliases.items;
  return [];
}

async function loadIdentityPatterns() {
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  const rows = (await conn.runAndReadAll(
    `SELECT canonical_id, display_name, aliases FROM identities WHERE display_name IS NOT NULL`
  )).getRows();

  const patterns = [];
  for (const [canonical_id, display_name, aliasesRaw] of rows) {
    const aliases = resolveAliases(aliasesRaw);
    const forms = Array.from(new Set([display_name, ...aliases].filter(isAlphabeticName)));
    if (forms.length === 0) continue;
    // Sort longest-first so "Jordan Blake" wins before "Jordan"
    forms.sort((a, b) => b.length - a.length);
    const longRe = new RegExp(`\\b(${forms.filter(f => f.length >= 3).map(escapeRegex).join('|')})\\b`, 'gi');
    const shortForms = forms.filter(f => f.length === 2); // case-sensitive
    patterns.push({ canonical_id, display_name, forms, longRe, shortForms });
  }
  return patterns;
}

function listMarkdownFiles(dir) {
  // Resolve through symlink, then glob .md files
  const real = fs.realpathSync(dir);
  if (!fs.existsSync(real)) return [];
  return fs.readdirSync(real)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, abs: path.join(real, f) }));
}

function findMentionsInFile(content, patterns) {
  const lines = content.split(/\r?\n/);
  const hits = []; // { canonical_id, display_name, form, line_no, line_text }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    for (const p of patterns) {
      // Long forms via regex
      if (p.forms.some(f => f.length >= 3)) {
        const matches = line.matchAll(p.longRe);
        for (const m of matches) {
          hits.push({
            canonical_id: p.canonical_id,
            display_name: p.display_name,
            form: m[1],
            line_no: i + 1,
            line_text: line.trim(),
          });
        }
      }
      // Short forms case-sensitive (e.g. "JB")
      for (const sf of p.shortForms) {
        const re = new RegExp(`\\b${escapeRegex(sf)}\\b`, 'g'); // case-SENSITIVE
        let m;
        while ((m = re.exec(line)) !== null) {
          hits.push({
            canonical_id: p.canonical_id,
            display_name: p.display_name,
            form: m[0],
            line_no: i + 1,
            line_text: line.trim(),
          });
        }
      }
    }
  }
  return hits;
}

async function main() {
  // Clear output dir for idempotency — stale per-person files from a previous run
  // with broader matching rules would otherwise leak into downstream synthesis.
  if (fs.existsSync(OUT_DIR)) {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (f.endsWith('.md')) fs.unlinkSync(path.join(OUT_DIR, f));
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const patterns = await loadIdentityPatterns();
  console.log(`Loaded ${patterns.length} identities with usable name forms.`);

  const files = listMarkdownFiles(WRITING_DIR);
  if (files.length === 0) {
    console.log(`No .md files found in ${WRITING_DIR}`);
    return;
  }
  console.log(`Scanning ${files.length} writing files...\n`);

  // canonical_id -> { display_name, perFile: { filename -> [hit, ...] } }
  const byPerson = new Map();

  for (const f of files) {
    const content = fs.readFileSync(f.abs, 'utf8');
    const hits = findMentionsInFile(content, patterns);
    // De-dup hits per (canonical_id, line_no) — one line shouldn't be quoted twice for same person
    const seen = new Set();
    for (const h of hits) {
      const key = `${h.canonical_id}|${f.name}|${h.line_no}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let entry = byPerson.get(h.canonical_id);
      if (!entry) {
        entry = { display_name: h.display_name, perFile: new Map() };
        byPerson.set(h.canonical_id, entry);
      }
      let arr = entry.perFile.get(f.name);
      if (!arr) { arr = []; entry.perFile.set(f.name, arr); }
      arr.push({ form: h.form, line_no: h.line_no, line_text: h.line_text });
    }
  }

  // Write one file per person
  let totalQuotes = 0;
  const summary = [];
  for (const [canonical_id, entry] of byPerson.entries()) {
    const slug = safeFilename(entry.display_name);
    const lines = [`# ${entry.display_name} — mentions in personal writing`, ''];
    const totalForPerson = Array.from(entry.perFile.values()).reduce((a, arr) => a + arr.length, 0);
    lines.push(`*${totalForPerson} quote${totalForPerson === 1 ? '' : 's'} across ${entry.perFile.size} piece${entry.perFile.size === 1 ? '' : 's'}.*`);
    lines.push('');
    for (const [fname, hits] of entry.perFile.entries()) {
      lines.push(`## In ${fname.replace(/\.md$/, '')} (${hits.length})`);
      lines.push('');
      for (const h of hits) {
        // Bold the matched form inside the line
        const boldedLine = h.line_text.replace(
          new RegExp(`\\b${escapeRegex(h.form)}\\b`, 'g'),
          `**${h.form}**`
        );
        lines.push(`- L${h.line_no}: > ${boldedLine}`);
      }
      lines.push('');
    }
    fs.writeFileSync(path.join(OUT_DIR, `${slug}.md`), lines.join('\n'));
    totalQuotes += totalForPerson;
    summary.push({ name: entry.display_name, quotes: totalForPerson, files: entry.perFile.size });
  }

  // Print summary, sorted by quotes desc
  summary.sort((a, b) => b.quotes - a.quotes);
  console.log(`Wrote ${byPerson.size} per-person mention files to ${path.relative(process.cwd(), OUT_DIR)}/`);
  console.log(`Total quotes captured: ${totalQuotes}\n`);
  console.log(`Top mentions:`);
  for (const s of summary.slice(0, 20)) {
    console.log(`  ${s.quotes.toString().padStart(3)} × ${s.name} (${s.files} piece${s.files === 1 ? '' : 's'})`);
  }
  if (summary.length > 20) console.log(`  … and ${summary.length - 20} more.`);
}

main().catch(err => { console.error(err); process.exit(1); });
