#!/usr/bin/env node
/**
 * Tiny static file server for pipeline/output/.
 *
 *   npm run serve              # default port 8765
 *   PORT=4242 npm run serve    # custom port
 *
 * Serves pipeline/output/ at the root. Also exposes:
 *   /photo/<base64url-encoded-absolute-path>   → the photo bytes
 *
 * The /photo/ endpoint is needed because the rendered event HTML uses
 * file:// URLs to reference photos by absolute path, and browsers block
 * file:// from http://localhost. The server can rewrite those URLs at
 * request time, OR you can pre-render with a flag (not done here).
 *
 * Bind to 127.0.0.1 only — no network exposure.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { filterRedacted } from './lib/redactions.js';

let _DuckDBInstance;
async function loadDuckDB() {
  if (!_DuckDBInstance) {
    const mod = await import('@duckdb/node-api');
    _DuckDBInstance = mod.DuckDBInstance;
  }
  return _DuckDBInstance;
}
let _findDupIdentities;
async function loadFindDups() {
  if (!_findDupIdentities) {
    const mod = await import('./find-dup-identities.js');
    _findDupIdentities = mod.findDupIdentities;
  }
  return _findDupIdentities;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'output');
const DB_PATH = path.join(ROOT, 'raw', 'messages.duckdb');
const MERGES_PATH = path.join(__dirname, 'identity-merges.json');
const PORT = parseInt(process.env.PORT || '8765', 10);

// The /thumb and /photo routes decode a client-supplied absolute path. Confine
// it to the photo archive so they can't be abused to read arbitrary files on
// the host (SSH keys, .env, the SQLite DB, source — all outside this root).
let PHOTO_ROOT;
try { PHOTO_ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..', 'social-media-archive')); }
catch { PHOTO_ROOT = path.resolve(__dirname, '..', '..', 'social-media-archive'); }
function isAllowedPhotoPath(abs) {
  if (typeof abs !== 'string' || !abs.startsWith('/')) return false;
  try {
    const real = fs.realpathSync(abs);  // also confirms existence
    return real === PHOTO_ROOT || real.startsWith(PHOTO_ROOT + path.sep);
  } catch { return false; }
}

// Singleton DuckDB connection used by /api/edge.
// The file lock is held by the *instance* (the underlying duckdb.Database),
// not the connection — so we must keep a reference to the instance to be able
// to release the lock fully (see closeDb) before a child writer runs.
let _dbConn = null;
let _dbInst = null;
async function getDb() {
  if (_dbConn) return _dbConn;
  const DuckDBInstance = await loadDuckDB();
  _dbInst = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
  _dbConn = await _dbInst.connect();
  // Harden: block DuckDB read-side file/http table functions (read_text/glob/
  // read_csv_auto/httpfs). READ_ONLY only blocks WRITES, not these — so without
  // this the LLM-driven /ask route could read local files / exfiltrate via SQL.
  // No route legitimately uses external access through SQL.
  try { await _dbConn.run('SET enable_external_access=false'); } catch (e) { console.error('[getDb] hardening failed:', e.message); }
  return _dbConn;
}

// True while a merge-apply is folding + rebuilding. Blocks DB-backed routes.
let applying = false;

// Fully release the DuckDB file lock so a child writer can open it read-write.
// Disconnecting the connection alone does NOT drop the lock — the lock lives on
// the instance, so we close that too and null both singletons so the next
// getDb() reopens fresh.
async function closeDb() {
  try { if (_dbConn) _dbConn.disconnectSync(); } catch {}
  _dbConn = null;
  try { if (_dbInst) _dbInst.closeSync(); } catch {}
  _dbInst = null;
}

// Run a pipeline script as a child process from the repo root.
function runStep(scriptRelPath, args = []) {
  return new Promise((resolve, reject) => {
    execFile('node', [scriptRelPath, ...args], { cwd: path.join(__dirname, '..'), maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

async function fetchCoPhotos(aId, bId) {
  const conn = await getDb();
  const esc = s => String(s).replace(/'/g, "''");
  const rows = (await conn.runAndReadAll(`
    SELECT DISTINCT p.id AS id, p.asset_path AS asset_path, p.ts_iso AS ts_iso
    FROM photo_faces pf1
    JOIN photo_faces pf2 ON pf1.photo_id = pf2.photo_id
    JOIN photos p ON p.id = pf1.photo_id
    WHERE pf1.canonical_id = '${esc(aId)}' AND pf2.canonical_id = '${esc(bId)}' AND p.asset_path IS NOT NULL
    ORDER BY p.ts_iso DESC
    LIMIT 200
  `)).getRowObjectsJson();
  return { photos: rows.map(r => ({ asset_path: r.asset_path, iso: (r.ts_iso || '').slice(0, 10) })) };
}

async function fetchEdgeDetails(aId, bId) {
  const conn = await getDb();
  // Shared groups: threads where both A and B appear in group_membership.
  const sharedReader = await conn.runAndReadAll(`
    SELECT DISTINCT a.thread_id AS thread_id, t.participants
    FROM group_membership a
    JOIN group_membership b ON a.thread_id = b.thread_id
    JOIN threads t ON t.thread_id = a.thread_id
    WHERE a.canonical_id = '${aId.replace(/'/g, "''")}'
      AND b.canonical_id = '${bId.replace(/'/g, "''")}'
    LIMIT 30
  `);
  const sharedGroups = sharedReader.getRowObjectsJson().map(r => ({
    thread_id: r.thread_id,
    participants: r.participants,
  }));

  // Sample co-mentions: messages in Demo's 1-on-1 thread with B that mention A,
  // and messages in Demo's 1-on-1 thread with A that mention B. Limit to ~12 each side.
  const aMentionedInBThreadReader = await conn.runAndReadAll(`
    SELECT m.body, m.ts, m.thread_id, mn.mentioned_form
    FROM mentions mn
    JOIN messages m ON m.id = mn.message_id
    JOIN thread_identity ti ON ti.thread_id = mn.thread_id
    JOIN threads t ON t.thread_id = mn.thread_id
    WHERE t.is_group = FALSE
      AND ti.canonical_id = '${bId.replace(/'/g, "''")}'
      AND mn.mentioned_canonical_id = '${aId.replace(/'/g, "''")}'
    ORDER BY m.ts DESC
    LIMIT 12
  `);
  const bMentionedInAThreadReader = await conn.runAndReadAll(`
    SELECT m.body, m.ts, m.thread_id, mn.mentioned_form
    FROM mentions mn
    JOIN messages m ON m.id = mn.message_id
    JOIN thread_identity ti ON ti.thread_id = mn.thread_id
    JOIN threads t ON t.thread_id = mn.thread_id
    WHERE t.is_group = FALSE
      AND ti.canonical_id = '${aId.replace(/'/g, "''")}'
      AND mn.mentioned_canonical_id = '${bId.replace(/'/g, "''")}'
    ORDER BY m.ts DESC
    LIMIT 12
  `);
  const aInB = aMentionedInBThreadReader.getRowObjectsJson().map(r => ({
    body: (r.body || '').slice(0, 240),
    ts: Number(r.ts),
    iso: new Date(Number(r.ts)).toISOString().slice(0, 10),
    form: r.mentioned_form,
  }));
  const bInA = bMentionedInAThreadReader.getRowObjectsJson().map(r => ({
    body: (r.body || '').slice(0, 240),
    ts: Number(r.ts),
    iso: new Date(Number(r.ts)).toISOString().slice(0, 10),
    form: r.mentioned_form,
  }));

  return {
    a_id: aId,
    b_id: bId,
    shared_groups: sharedGroups,
    a_mentioned_in_b_thread: aInB,
    b_mentioned_in_a_thread: bInA,
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif':  'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4':  'video/mp4',
  '.mov':  'video/quicktime',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// ---- Annotations (knot/strength/reflection feedback) ----
const ANNOTATIONS_PATH = path.join(ROOT, 'self', 'annotations.json');
// Verdict vocabulary is per-kind so the sit-with reflection workflow can use
// loosened / true / wrong / unsure / retire while the daily-read knot/strength
// blocks keep their existing landed / missed / resolved / partial / skip set.
const VERDICTS_BY_KIND = {
  knot:       ['landed', 'missed', 'resolved', 'partial', 'null'],
  strength:   ['landed', 'missed', 'resolved', 'partial', 'null'],
  reflection: ['loosened', 'true', 'wrong', 'unsure', 'retire'],
};
const VERDICT_LABELS = {
  null: 'skip',
};
const VALID_KINDS = new Set(Object.keys(VERDICTS_BY_KIND));
function verdictsFor(kind) { return VERDICTS_BY_KIND[kind] || []; }
function isValidVerdict(kind, verdict) { return verdictsFor(kind).includes(verdict); }

function readAnnotations() {
  try {
    if (fs.existsSync(ANNOTATIONS_PATH)) {
      return JSON.parse(fs.readFileSync(ANNOTATIONS_PATH, 'utf-8'));
    }
  } catch (err) {
    console.error('[annotations] read failed:', err.message);
  }
  return {};
}

function writeAnnotations(obj) {
  const dir = path.dirname(ANNOTATIONS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic-ish write: write to tmp, rename.
  const tmp = ANNOTATIONS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, ANNOTATIONS_PATH);
}

function readMerges() {
  try { return JSON.parse(fs.readFileSync(MERGES_PATH, 'utf-8')); }
  catch { return { merges: [] }; }
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw) return resolve({});
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleAnnotationPost(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': MIME['.json'], 'Allow': 'POST' });
    res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: false, error: 'bad json: ' + err.message }));
    return;
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
  const verdict = typeof body.verdict === 'string' ? body.verdict.trim() : '';
  const note = typeof body.note === 'string' ? body.note : '';
  if (!id || !VALID_KINDS.has(kind) || !isValidVerdict(kind, verdict)) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({
      ok: false,
      error: `invalid input: require id (str), kind (${[...VALID_KINDS].join('|')}), verdict (one of: ${verdictsFor(kind).join('|') || '<unknown kind>'})`,
    }));
    return;
  }
  // ID must look like one of the expected forms; mild guard.
  if (!/^[a-zA-Z0-9_\-]+$/.test(id) || id.length > 128) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: false, error: 'invalid id' }));
    return;
  }
  if (note.length > 4000) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: false, error: 'note too long (max 4000)' }));
    return;
  }
  const all = readAnnotations();
  const now = new Date().toISOString();
  const prev = all[id];
  const history = Array.isArray(prev?.history) ? [...prev.history] : [];
  if (prev && (prev.verdict !== verdict || (prev.note || '') !== note)) {
    history.push({
      verdict: prev.verdict,
      note: prev.note || '',
      kind: prev.kind,
      last_updated_iso: prev.last_updated_iso,
    });
  }
  const record = {
    verdict,
    note,
    kind,
    last_updated_iso: now,
    history,
  };
  all[id] = record;
  try {
    writeAnnotations(all);
  } catch (err) {
    console.error('[annotations] write failed:', err.message);
    res.writeHead(500, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ ok: false, error: 'write failed' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ ok: true, record }));
}

async function handleFaceLabelsPost(req, res) {
  const FACE_LABELS_PATH = path.join(__dirname, 'face-labels.json');
  let body;
  try {
    body = await readJsonBody(req, 1024 * 1024);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: 'bad json: ' + err.message }));
    return;
  }
  if (!body || !Array.isArray(body.clusters)) {
    res.writeHead(400, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: 'invalid payload: must be {clusters:[...]}' }));
    return;
  }
  const sanitized = body.clusters.filter(c =>
    Number.isFinite(Number(c.cluster_id)) &&
    typeof c.label === 'string' && c.label.trim() !== ''
  ).map(c => ({ cluster_id: Number(c.cluster_id), label: c.label }));
  try {
    fs.writeFileSync(FACE_LABELS_PATH, JSON.stringify({ clusters: sanitized }, null, 2));
  } catch (err) {
    console.error('[api/face-labels] write failed:', err.message);
    res.writeHead(500, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ error: 'write failed' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ ok: true, n: sanitized.length }));
}

function listDirHtml(reqPath, absDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
    .sort((a, b) => {
      // dirs first, then files, alpha
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const items = entries
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const slash = e.isDirectory() ? '/' : '';
      const href = encodeURIComponent(e.name) + slash;
      return `<li><a href="${href}">${e.name}${slash}</a></li>`;
    }).join('\n');
  const parent = reqPath === '/' ? '' : '<li><a href="../">..</a></li>';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${reqPath}</title>
<style>body{font-family:ui-monospace,monospace;max-width:720px;margin:2rem auto;padding:0 1.5rem;line-height:1.7}h1{font-size:1.1rem}ul{list-style:none;padding:0}li{padding:0.1rem 0}a{text-decoration:none;color:#0066cc}a:hover{text-decoration:underline}</style>
</head><body><h1>Index of ${reqPath}</h1><ul>${parent}${items}</ul></body></html>`;
}

function rewriteHtmlFileUrls(html) {
  // Legacy path: older rendered artifacts embed file:// URLs. Match to the
  // closing quote of the attribute, NOT to whitespace — real asset paths
  // contain spaces ("…/Google Photos/Photos from 2013/…") and a whitespace
  // stop truncates the path and shreds the attribute. Current renderers emit
  // /thumb and /photo URLs directly and never rely on this.
  return html.replace(/(src|href)=(["'])file:\/\/([^"']+)\2/g, (_, attr, q, absPath) =>
    `${attr}=${q}/photo/${Buffer.from(absPath).toString('base64url')}${q}`);
}

const PORTRAIT_CSS = `
:root {
  --bg: #fafaf7; --fg: #1c1c1c; --muted: #6a6a6a; --rule: #e0ddd5;
  --quote-bg: #f1ede4; --quote-rule: #c8c0a8; --accent: #5a5044;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14130f; --fg: #e8e6e0; --muted: #a09b8e; --rule: #2a2825;
    --quote-bg: #1d1b16; --quote-rule: #4a4538; --accent: #c8bea8;
  }
}
* { box-sizing: border-box; }
body {
  font-family: 'Iowan Old Style', Georgia, 'Times New Roman', serif;
  max-width: 720px; margin: 4rem auto; padding: 0 2rem 6rem;
  background: var(--bg); color: var(--fg); line-height: 1.7; font-size: 18px;
}
@media (max-width: 600px) {
  body { margin: 1.5rem auto; padding: 0 1.2rem 3rem; font-size: 17px; }
}
h1 { font-size: 2.2rem; line-height: 1.15; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
h2 { font-size: 1.35rem; margin: 3rem 0 1rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--rule); }
h3 { font-size: 1.1rem; margin: 2.2rem 0 0.6rem; color: var(--accent); }
p.essence { font-style: italic; color: var(--muted); font-size: 1.1rem; margin: 0 0 2.5rem; }
blockquote {
  margin: 1rem 0; padding: 0.6rem 1rem; background: var(--quote-bg);
  border-left: 3px solid var(--quote-rule); border-radius: 0 4px 4px 0;
  font-style: normal; color: var(--fg);
}
blockquote p { margin: 0.2rem 0; }
.meta {
  font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.78rem; color: var(--muted);
  padding: 0.8rem 1rem; margin: 0 0 2.5rem; border: 1px solid var(--rule);
  border-radius: 4px; background: var(--quote-bg); white-space: pre-wrap; word-break: break-word;
}
hr { border: none; border-top: 1px solid var(--rule); margin: 3rem 0; }
a { color: var(--accent); }
nav.crumbs { font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.85rem; margin-bottom: 2rem; color: var(--muted); }
nav.crumbs a { color: var(--accent); text-decoration: none; }
nav.crumbs a:hover { text-decoration: underline; }
ul.portrait-index { list-style: none; padding: 0; }
ul.portrait-index li { padding: 0.5rem 0; border-bottom: 1px solid var(--rule); }
ul.portrait-index a { font-size: 1.1rem; text-decoration: none; }
ul.portrait-index a:hover { text-decoration: underline; }
`;

// Build a list of (display_name → portrait slug) for cross-portrait auto-linking.
// Names that match a portrait file get linked to that portrait when they appear
// in any other portrait's prose. Matched in length-desc order so longer names win
// (e.g. "Maya Torres" before "Maya").
function getPortraitSlugMap(portraitsDir) {
  if (!fs.existsSync(portraitsDir)) return [];
  const entries = [];
  for (const f of fs.readdirSync(portraitsDir)) {
    if (!f.endsWith('.md') || f.startsWith('group_')) continue;
    const slug = f.replace(/\.md$/, '');
    const display = slug.replace(/_/g, ' ');
    entries.push({ slug, display });
    // Also alias common short forms — first name only
    const first = display.split(' ')[0];
    if (first.length >= 4 && first !== display) {
      entries.push({ slug, display: first });
    }
  }
  // Length-desc so "Maya Torres" matches before "Maya"
  return entries.sort((a, b) => b.display.length - a.display.length);
}

function renderPortraitHtml(displayName, md, portraitsDir, opts = {}) {
  const title = `${displayName} — portrait`;
  // Build a JSON-encoded slug map for the client-side auto-linker
  const slugMap = (portraitsDir ? getPortraitSlugMap(portraitsDir) : []).filter(e => e.display !== displayName);
  // Show "trajectory" crumb only if a trajectory exists for this person.
  const trajSlug = displayName.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
  const trajIdx = loadTrajectoryIndex();
  const hasTrajectory = trajIdx ? trajIdx.bySlug.has(trajSlug) : false;
  const trajCrumb = hasTrajectory
    ? ` · <a href="/trajectory/${trajSlug}">trajectory →</a>`
    : '';
  // Inline reflection editor: docs (markup-up surfaces) get annotation widgets
  // injected after every h2/h3 so you can mark "loosened / true / wrong / unsure
  // / retire" + a free-text note at section granularity.
  const reflectionDocId = opts.reflectionDocId || '';
  const reflectionVerdicts = JSON.stringify(verdictsFor('reflection'));
  const verdictLabels = JSON.stringify(VERDICT_LABELS);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<style>${PORTRAIT_CSS}
a.xref { color: var(--accent); text-decoration: none; border-bottom: 1px dashed var(--rule); }
a.xref:hover { border-bottom-style: solid; }
/* inline reflection widgets */
.refl { margin: 0.4rem 0 1.4rem; padding: 0.5rem 0.7rem; border: 1px dashed var(--rule); border-radius: 4px; background: transparent; font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.78rem; color: var(--muted); }
.refl .row { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
.refl .lbl { margin-right: 0.4rem; }
.refl button { font-family: inherit; font-size: 0.78rem; padding: 0.15rem 0.55rem; border: 1px solid var(--rule); background: var(--bg); color: var(--muted); border-radius: 3px; cursor: pointer; }
.refl button:hover { color: var(--fg); border-color: var(--accent); }
.refl button.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.refl textarea { width: 100%; min-height: 2.4rem; margin-top: 0.45rem; padding: 0.4rem 0.55rem; font-family: inherit; font-size: 0.82rem; background: var(--quote-bg); color: var(--fg); border: 1px solid var(--rule); border-radius: 3px; resize: vertical; box-sizing: border-box; }
.refl textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
.refl .saved { color: var(--accent); opacity: 0; transition: opacity 0.2s; margin-left: 0.4rem; font-size: 0.74rem; }
.refl .saved.show { opacity: 1; }
.refl .note-disp { margin-top: 0.35rem; padding: 0.35rem 0.55rem; border-left: 2px solid var(--accent); background: var(--quote-bg); color: var(--fg); font-family: 'Iowan Old Style', Georgia, serif; font-size: 0.92rem; font-style: italic; white-space: pre-wrap; display: none; }
.refl .note-disp.show { display: block; }
h2, h3 { scroll-margin-top: 1rem; }
h2 .anchor, h3 .anchor { opacity: 0; margin-left: 0.4rem; font-family: ui-monospace, monospace; font-size: 0.7em; color: var(--muted); text-decoration: none; }
h2:hover .anchor, h3:hover .anchor { opacity: 1; }
</style>
</head>
<body>
<nav class="crumbs"><a href="/portraits/">← all portraits</a>${trajCrumb}${reflectionDocId ? ` · <a href="/sit-with">sit-with queue →</a>` : ''}</nav>
<div id="meta" class="meta"></div>
<article id="content"></article>
<script id="src" type="text/markdown">${md.replace(/<\/script>/gi, '<\\/script>')}</script>
<script>
window._SLUGMAP_ = ${JSON.stringify(slugMap)};
window._REFLECTION_DOC_ID_ = ${JSON.stringify(reflectionDocId)};
window._REFLECTION_VERDICTS_ = ${reflectionVerdicts};
window._VERDICT_LABELS_ = ${verdictLabels};
(() => {
  const raw = document.getElementById('src').textContent;
  const fm = raw.match(/^---\\n([\\s\\S]*?)\\n---\\n([\\s\\S]*)$/);
  let meta = '', body = raw;
  if (fm) { meta = fm[1]; body = fm[2]; }
  body = body.replace(
    /^(# [^\\n]+)\\n\\n\\*([^*\\n][^\\n]+?)\\*\\n/m,
    (_, h1, essence) => h1 + '\\n\\n<p class="essence">' + essence + '</p>\\n'
  );
  document.getElementById('meta').textContent = meta;
  const article = document.getElementById('content');
  article.innerHTML = marked.parse(body);
  // Auto-link person names to their portraits, walking text nodes only (skip code/links/headings)
  const slugs = window._SLUGMAP_;
  if (slugs && slugs.length) {
    const escape = (s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const re = new RegExp('\\\\b(' + slugs.map(s => escape(s.display)).join('|') + ')\\\\b', 'g');
    const slugMap = new Map();
    for (const s of slugs) if (!slugMap.has(s.display)) slugMap.set(s.display, s.slug);
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        let p = n.parentNode;
        while (p && p !== article) {
          if (['A','CODE','PRE','H1'].includes(p.tagName)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const seenLinks = new Set();
    const targets = [];
    let n; while ((n = walker.nextNode())) targets.push(n);
    for (const node of targets) {
      const text = node.nodeValue;
      if (!re.test(text)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0; let m;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const slug = slugMap.get(m[1]);
        if (seenLinks.has(slug)) {
          // Already linked once in this portrait; subsequent mentions stay plain text to avoid noise
          frag.appendChild(document.createTextNode(m[1]));
        } else {
          seenLinks.add(slug);
          const a = document.createElement('a');
          a.className = 'xref';
          a.href = '/portraits/' + slug;
          a.textContent = m[1];
          frag.appendChild(a);
        }
        last = m.index + m[1].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // Inline reflection editor — only on /docs/* (when _REFLECTION_DOC_ID_ is set).
  // Inject a verdict-bar + textarea after every h2 and h3. Each block has a
  // stable annotation id of <doc-id>__<heading-slug>. State persists via the
  // existing /api/annotation backend (kind='reflection').
  const docId = window._REFLECTION_DOC_ID_;
  if (docId) {
    const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    const verdicts = window._REFLECTION_VERDICTS_ || [];
    const labels = window._VERDICT_LABELS_ || {};
    const escHtml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');
    const headings = article.querySelectorAll('h2, h3');
    const seenIds = new Set();
    headings.forEach((h) => {
      const text = h.textContent.trim();
      if (!text) return;
      let base = slugify(text);
      let id = base;
      let n = 1;
      while (seenIds.has(id)) { id = base + '-' + (++n); }
      seenIds.add(id);
      const annotId = docId + '__' + id;
      // Anchor link on the heading itself.
      h.id = id;
      const anchor = document.createElement('a');
      anchor.className = 'anchor';
      anchor.href = '#' + id;
      anchor.textContent = '#';
      h.appendChild(anchor);
      // Build the widget.
      const block = document.createElement('div');
      block.className = 'refl annot';
      block.setAttribute('data-annot-id', annotId);
      block.setAttribute('data-annot-kind', 'reflection');
      const buttons = verdicts.map(v => {
        const label = labels[v] || v;
        return '<button type=\"button\" data-verdict=\"' + v + '\">' + escHtml(label) + '</button>';
      }).join('\\n');
      block.innerHTML = '<div class=\"row\"><span class=\"lbl\">mark:</span>' + buttons + '<span class=\"saved\">✓ saved</span></div>'
        + '<textarea data-note placeholder=\"note (saves on blur — only with a verdict)\"></textarea>'
        + '<div class=\"note-disp\"></div>';
      // Insert after the heading.
      h.parentNode.insertBefore(block, h.nextSibling);
    });
    // Wire each block + pre-load existing annotations using the same shared
    // logic as the /self page. We inline a minimal version here so /docs/*
    // pages don't need to import the larger annotation script.
    function applyState(block, record) {
      const verdict = record && record.verdict;
      block.querySelectorAll('button[data-verdict]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-verdict') === verdict);
      });
      const ta = block.querySelector('textarea[data-note]');
      if (ta && record && typeof record.note === 'string' && document.activeElement !== ta) {
        ta.value = record.note;
      }
      const disp = block.querySelector('.note-disp');
      if (disp) {
        const note = record && record.note;
        if (note && note.trim()) { disp.textContent = note; disp.classList.add('show'); }
        else { disp.classList.remove('show'); }
      }
    }
    function flashSaved(block) {
      const s = block.querySelector('.saved');
      if (!s) return;
      s.classList.add('show');
      setTimeout(() => s.classList.remove('show'), 1200);
    }
    async function postAnnot(payload) {
      const res = await fetch('/api/annotation', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('http ' + res.status);
      return res.json();
    }
    const blocks = Array.from(article.querySelectorAll('.refl[data-annot-id]'));
    blocks.forEach(block => {
      const id = block.getAttribute('data-annot-id');
      const kind = block.getAttribute('data-annot-kind');
      block.querySelectorAll('button[data-verdict]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const verdict = btn.getAttribute('data-verdict');
          const ta = block.querySelector('textarea[data-note]');
          const note = ta ? ta.value : '';
          try {
            const r = await postAnnot({ id, kind, verdict, note });
            if (r && r.ok) { applyState(block, r.record); flashSaved(block); }
          } catch (e) { console.error('save fail', e); }
        });
      });
      const ta = block.querySelector('textarea[data-note]');
      if (ta) {
        ta.addEventListener('blur', async () => {
          const active = block.querySelector('button[data-verdict].active');
          if (!active) return;
          const verdict = active.getAttribute('data-verdict');
          try {
            const r = await postAnnot({ id, kind, verdict, note: ta.value });
            if (r && r.ok) { applyState(block, r.record); flashSaved(block); }
          } catch (e) { console.error('save fail', e); }
        });
      }
    });
    fetch('/api/annotations.json').then(r => r.json()).then(all => {
      blocks.forEach(b => {
        const id = b.getAttribute('data-annot-id');
        if (all && all[id]) applyState(b, all[id]);
      });
    }).catch(e => console.error('preload fail', e));
  }
})();
</script>
</body></html>`;
}

function renderTimelinePage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>relational timeline</title>
<style>${PORTRAIT_CSS}
.entry { display: grid; grid-template-columns: 7rem 1fr; gap: 0.8rem; padding: 0.5rem 0; border-bottom: 1px solid var(--rule); align-items: baseline; }
.entry .date { font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--muted); }
.entry .body { font-size: 0.95rem; }
.entry .person { font-weight: 600; color: var(--accent); }
.entry .kind { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-left: 0.5rem; }
.entry.kind-birthday .kind { color: #c97a4a; }
.entry.kind-first_contact .kind, .entry.kind-last_contact .kind { color: #6e8e6a; }
.year-header { font-family: ui-monospace, monospace; font-size: 1.4rem; margin: 2rem 0 0.5rem; color: var(--fg); border-top: 2px solid var(--rule); padding-top: 1rem; }
.controls { font-family: ui-monospace, monospace; font-size: 0.85rem; margin-bottom: 1.5rem; }
.controls input { padding: 0.3rem 0.6rem; font: inherit; background: var(--quote-bg); border: 1px solid var(--rule); color: var(--fg); border-radius: 3px; width: 200px; }
.controls a { margin-left: 1rem; color: var(--accent); text-decoration: none; }
@media (max-width: 600px) { .entry { grid-template-columns: 5rem 1fr; gap: 0.5rem; } }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>timeline</h1>
<p class="essence">Cross-relationship chronological view — anchor moments, birthdays, first/last contact.</p>
<div class="controls">
  <input id="filter" placeholder="filter by name or word…">
  <a href="/api/timeline.json">json export</a>
  <a href="/api/timeline.ndjson">ndjson</a>
</div>
<div id="entries"></div>
<script>
fetch('/api/timeline.json').then(r => r.json()).then(data => {
  const root = document.getElementById('entries');
  const filter = document.getElementById('filter');
  function render(q) {
    root.innerHTML = '';
    const ql = (q || '').toLowerCase();
    let lastYear = '';
    for (const e of data.entries) {
      if (ql && !(e.person.toLowerCase().includes(ql) || e.summary.toLowerCase().includes(ql) || e.kind.includes(ql))) continue;
      const yr = e.date.slice(0, 4);
      if (yr !== lastYear) {
        const h = document.createElement('div'); h.className = 'year-header'; h.textContent = yr;
        root.appendChild(h); lastYear = yr;
      }
      const div = document.createElement('div'); div.className = 'entry kind-' + e.kind;
      div.innerHTML = '<div class="date">' + e.date + '</div>'
        + '<div class="body"><span class="person">' + e.person + '</span> '
        + '<span class="kind">' + e.kind.replace('_', ' ') + '</span><br>'
        + e.summary.replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c])) + '</div>';
      root.appendChild(div);
    }
  }
  filter.addEventListener('input', () => render(filter.value));
  render('');
});
</script>
</body></html>`;
}

function renderCheckinsPage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>check-ins</title>
<style>${PORTRAIT_CSS}
.row { padding: 0.9rem 0; border-bottom: 1px solid var(--rule); }
.row .name { font-weight: 600; font-size: 1.1rem; color: var(--fg); }
.row .meta { font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--muted); margin-top: 0.2rem; }
.row .about { font-size: 0.95rem; margin-top: 0.4rem; }
.row .excerpt { font-size: 0.85rem; color: var(--muted); margin-top: 0.3rem; font-style: italic; }
.tag { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 3px; background: var(--quote-bg); font-size: 0.7rem; margin-right: 0.3rem; }
.tag.urgent { background: #c97a4a; color: white; }
.tag.unanswered { background: #6e8e6a; color: white; }
.tag.bday { background: #c4a44a; color: white; }
.controls { font-family: ui-monospace, monospace; font-size: 0.85rem; margin-bottom: 1.5rem; }
.controls a { margin-right: 1rem; color: var(--accent); text-decoration: none; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>check-ins</h1>
<p class="essence">Top by attention-needed (silence + unanswered + birthday-soon) or by intimacy (volume × years × recency).</p>
<div class="controls">
  <label><input type="radio" name="sort" value="attention" checked> attention</label>
  <label><input type="radio" name="sort" value="intimacy"> intimacy</label>
  <span style="flex:1"></span>
  <a href="/api/checkins.json">json export</a>
  <a href="/api/checkins.ndjson">ndjson</a>
</div>
<div id="rows"></div>
<script>
let _data;
function render(sort) {
  const root = document.getElementById('rows');
  root.innerHTML = '';
  const sorted = sort === 'intimacy'
    ? [..._data.people].sort((a, b) => (b.intimacy_score || 0) - (a.intimacy_score || 0))
    : _data.people; // already attention-sorted from build
  for (const p of sorted) {
    const tags = [];
    if (sort === 'intimacy') {
      tags.push('<span class="tag" style="background:#5a5044;color:white">int ' + (p.intimacy_score||0).toFixed(0) + '</span>');
    }
    if (p.days_until_birthday != null && p.days_until_birthday <= 14) {
      tags.push('<span class="tag bday">birthday in ' + p.days_until_birthday + 'd</span>');
    }
    if (p.last_msg_from === 'them') tags.push('<span class="tag unanswered">last msg theirs</span>');
    if (p.days_since_last >= 30) tags.push('<span class="tag urgent">' + p.days_since_last + 'd quiet</span>');
    const portraitLink = p.has_portrait
      ? '<a href="/portraits/' + p.display_name.replace(/[^\\w\\-]+/g, '_') + '">portrait</a>'
      : '';
    const div = document.createElement('div'); div.className = 'row';
    div.innerHTML = '<div class="name">' + p.display_name + ' ' + portraitLink + '</div>'
      + '<div class="meta">' + tags.join(' ')
      + ' &middot; ' + p.msg_count.toLocaleString() + ' msgs'
      + (p.years_active ? ' &middot; ' + p.years_active + ' yr' : '')
      + ' &middot; last ' + p.last_iso + ' (' + p.days_since_last + 'd ago)'
      + (p.birthday ? ' &middot; bday ' + String(p.birthday.month).padStart(2,'0') + '-' + String(p.birthday.day).padStart(2,'0') : '')
      + '</div>'
      + (p.about_what ? '<div class="about">→ ' + p.about_what.replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c])) + '</div>' : '')
      + (p.last_msg_excerpt ? '<div class="excerpt">' + (p.last_msg_from === 'me' ? 'you: ' : 'them: ') + p.last_msg_excerpt.replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c])) + '</div>' : '');
    root.appendChild(div);
  }
}
fetch('/api/checkins.json').then(r => r.json()).then(data => {
  _data = data;
  document.querySelectorAll('input[name="sort"]').forEach(el => el.addEventListener('change', e => render(e.target.value)));
  render('attention');
});
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A view failed. Most often that means the DuckDB corpus is absent (the demo
// dataset ships JSON artifacts only). Never echo the raw exception to the
// client — it discloses absolute filesystem paths. Log it, show a hint.
function viewError(res, view, e, html = true) {
  console.error(`[${view}]`, (e && e.stack) || e);
  const msg = `This view needs the full message corpus (pipeline/output/raw/messages.duckdb), which the demo dataset does not include. See the README for building one.`;
  try {
    if (html) { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>${view}</title>`
        + `<div style="font:16px/1.6 system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">`
        + `<h1 style="font-size:1.1rem">${view} is unavailable</h1><p>${msg}</p></div>`); }
    else { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg, view })); }
  } catch {}
}

function renderFbEventsPage(data) {
  const events = Array.isArray(data.events) ? data.events : [];
  const topics = Array.isArray(data.topics) ? data.topics : [];

  // Count by response
  const counts = {};
  for (const e of events) {
    const r = e.response || 'unknown';
    counts[r] = (counts[r] || 0) + 1;
  }
  const countParts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${n} ${r}`)
    .join(' · ');

  // Topics panel
  let topicsHtml = '';
  if (topics.length) {
    const chips = topics.map(t => {
      const samples = Array.isArray(t.sample_events) ? t.sample_events.slice(0, 3).map(escapeHtml).join(', ') : '';
      return `<span class="chip" title="${samples}">${escapeHtml(t.topic)} <span class="chip-n">${t.n}</span></span>`;
    }).join('\n');
    topicsHtml = `<section class="topics-panel">
<h2>interest topics</h2>
<div class="chips">${chips}</div>
</section>`;
  }

  // Timeline: events with start_ts, sorted DESC, grouped by year
  const dated = events.filter(e => e.start_ts != null).sort((a, b) => b.start_ts - a.start_ts);
  const undated = events.filter(e => e.start_ts == null);

  // Group by year
  const byYear = new Map();
  for (const e of dated) {
    const yr = new Date(e.start_ts).getFullYear();
    if (!byYear.has(yr)) byYear.set(yr, []);
    byYear.get(yr).push(e);
  }

  function responseClass(r) {
    if (r === 'joined' || r === 'hosted' || r === 'ticket' || r === 'created') return 'tag-bright';
    if (r === 'declined') return 'tag-dim';
    return 'tag-normal';
  }

  function renderEventRow(e) {
    const iso = e.start_ts != null ? new Date(e.start_ts).toISOString().slice(0, 10) : '';
    const place = e.place_name ? ` <span class="place">· ${escapeHtml(e.place_name)}</span>` : '';
    const resp = e.response || '';
    return `<div class="ev-row">
  <span class="ev-date">${escapeHtml(iso)}</span>
  <span class="ev-name">${escapeHtml(e.name || '')}${place}</span>
  <span class="ev-tag ${responseClass(resp)}">${escapeHtml(resp)}</span>
</div>`;
  }

  let timelineHtml = '';
  if (dated.length) {
    const yearBlocks = [];
    for (const [yr, evs] of byYear) {
      const rows = evs.map(renderEventRow).join('\n');
      yearBlocks.push(`<div class="year-block">
<div class="year-header">${yr}</div>
${rows}
</div>`);
    }
    timelineHtml = `<section class="timeline">
<h2>timeline</h2>
${yearBlocks.join('\n')}
</section>`;
  }

  let undatedHtml = '';
  if (undated.length) {
    const rows = undated.map(renderEventRow).join('\n');
    undatedHtml = `<section class="undated">
<h2>undated (${undated.length})</h2>
${rows}
</section>`;
  }

  if (!dated.length && !undated.length) {
    timelineHtml = `<p class="muted">No events yet — run the Facebook events build step.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>facebook events</title>
<style>${PORTRAIT_CSS}
.header-counts { font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.82rem; color: var(--muted); margin: 0 0 2rem; }
.topics-panel { margin-bottom: 2.5rem; }
.chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.7rem; }
.chip { font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.78rem; padding: 0.2rem 0.6rem; background: var(--quote-bg); border: 1px solid var(--rule); border-radius: 3px; cursor: default; }
.chip-n { color: var(--accent); font-weight: 600; margin-left: 0.3rem; }
.year-block { margin-bottom: 1.5rem; }
.year-header { font-family: ui-monospace, 'SF Mono', monospace; font-size: 1.1rem; font-weight: 600; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 0.6rem; margin-bottom: 0.4rem; }
.ev-row { display: grid; grid-template-columns: 7rem 1fr auto; gap: 0.5rem; padding: 0.3rem 0; border-bottom: 1px solid var(--rule); align-items: baseline; font-size: 0.88rem; }
.ev-date { font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.75rem; color: var(--muted); }
.ev-name { color: var(--fg); }
.place { color: var(--muted); font-size: 0.8rem; }
.ev-tag { font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 3px; white-space: nowrap; }
.tag-bright { background: #5a8a5a; color: #fff; }
.tag-normal { background: var(--quote-bg); color: var(--muted); border: 1px solid var(--rule); }
.tag-dim { background: var(--bg); color: var(--muted); opacity: 0.55; border: 1px solid var(--rule); }
.muted { color: var(--muted); }
@media (max-width: 600px) { .ev-row { grid-template-columns: 5.5rem 1fr; } .ev-tag { display: none; } }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>facebook events</h1>
<p class="header-counts">${events.length} total · ${escapeHtml(countParts)}</p>
${topicsHtml}
${timelineHtml}
${undatedHtml}
</body></html>`;
}

function renderRootIndex() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>social graph</title>
<style>${PORTRAIT_CSS}
ul.root-index { list-style: none; padding: 0; }
ul.root-index li { padding: 0.6rem 0; border-bottom: 1px solid var(--rule); }
ul.root-index a { font-size: 1.05rem; text-decoration: none; }
ul.root-index small { color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.75rem; margin-left: 0.5rem; }
h2.root-section { margin-top: 2rem; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); border-bottom: 1px solid var(--rule); padding-bottom: 0.3rem; font-weight: 600; }
</style>
</head><body>
<h1>social graph</h1>
<p class="essence">Local CRM views over the message archive.</p>

<h2 class="root-section">relational views</h2>
<ul class="root-index">
  <li><a href="/portraits/">portraits</a> <small>per-person narrative documents</small></li>
  <li><a href="/timeline">timeline</a> <small>chronological cross-relationship view</small></li>
  <li><a href="/checkins">check-ins</a> <small>who to reach out to and about what</small></li>
  <li><a href="/storyline">storyline</a> <small>intertwining narrative threads over time</small></li>
  <li><a href="/groups">groups</a> <small>group-chat ranking + cohort + bridges + graduation</small></li>
  <li><a href="/events/">events</a> <small>photo events + inferred meetups — who you were physically with, when and where</small></li>
  <li><a href="/years">years</a> <small>one almanac per year — most seen, new faces, concentration, biggest night</small></li>
  <li><a href="/threads">threads</a> <small>everyone you've been physically with, braided through sixteen years</small></li>
  <li><a href="/weeks">weeks</a> <small>every week as a cell — color is who, brightness is how much</small></li>
  <li><a href="/atlas">atlas</a> <small>one map per year, drawn only from where you actually were</small></li>
  <li><a href="/field">field</a> <small>the mosh — every event a particle, scroll descends the years, friends align</small></li>
  <li><a href="/rhythm">rhythm</a> <small>1.3M messages by week × local hour — the texture of sixteen years</small></li>
</ul>

<h2 class="root-section">self-portrait pipeline</h2>
<ul class="root-index">
  <li><a href="/sit-with"><strong>sit-with queue</strong></a> <small>P6 — read back the knots + cross-portrait + action-loop, mark each: loosened / true / wrong / unsure / retire</small></li>
  <li><a href="/writing">writing archive</a> <small>14 years of solo writing exported from Google Docs — 39 files, in-line reflection editor</small></li>
  <li><a href="/docs/writing-sweep-2026-05-10">writing-sweep against knots</a> <small>cross-reference of the writing archive against the layer-2 outputs — corroboration, contradictions, open factual questions</small></li>
  <li><a href="/self">today</a> <small>knot of the day · top gap · question to sit with — the daily-read surface</small></li>
  <li><a href="/portraits/George_Gao">self-portrait</a> <small>canonical synthesis: texture, loops, trajectory, decisions, knot hypotheses</small></li>
  <li><a href="/docs/self-knots-2026-05-09">knot hypotheses</a> <small>layer-2 LLM synthesis through the seven-lens committee</small></li>
  <li><a href="/docs/cross-portrait-2026-05-09">cross-portrait patterns</a> <small>themes recurring across friend portraits, named-in-one but appearing-in-many</small></li>
  <li><a href="/docs/nina-pitch-mind-portrait">pitch: mind-portrait tool for Nina</a> <small>the seven-lens design doc</small></li>
  <li><a href="/docs/memory-graph-design">memory graph design</a> <small>research: linking spatial × temporal × social — soot, Hägerstrand, storylines, the design internet</small></li>
</ul>

<h2 class="root-section">readings</h2>
<ul class="root-index">
</ul>

<h2 class="root-section">pre-conversation briefs</h2>
<ul class="root-index">
</ul>

<h2 class="root-section">network signals</h2>
<ul class="root-index">
  <li><a href="/graph">connection graph</a> <small>force-directed bubble plot of how people in your social graph are linked</small></li>
  <li><a href="/faces/review.html">face clusters — label</a> <small>name the recurring people in your Google Photos · autocomplete = your contacts · Save writes back</small></li>
  <li><a href="/merge">merge identities</a> <small>review duplicate candidates, stage and apply identity merges</small></li>
  <li><a href="/trajectory/">trajectories</a> <small>per-friend monthly volume + register-shift overlay for the top 30</small></li>
  <li><a href="/docs/gaps">gaps</a> <small>silent-and-strange — recipients whose recent volume has dropped well below their historical baseline</small></li>
</ul>

<h2 class="root-section">external data</h2>
<ul class="root-index">
  <li><a href="/fb-events">📅 facebook events</a> <small>event timeline + interest topics from Facebook export</small></li>
  <li><a href="/interests">🧠 interests</a> <small>what Demo's into — YouTube + Facebook + Gmail, aggregated</small></li>
  <li><a href="/youtube">📺 youtube interests</a> <small>topics, channels &amp; music artists from watch history</small></li>
  <li><a href="/milestones">🗓️ life milestones</a> <small>messages, photos &amp; events by year; click a name for their timeline</small></li>
  <li><a href="/on-this-day">📆 on this day</a> <small>photos, events &amp; conversations from today's date across the years</small></li>
  <li><a href="/map">🗺️ life map</a> <small>photo locations by city + event pins on a world map</small></li>
  <li><a href="/ask">💬 ask your life</a> <small>natural-language questions over your data via the local LLM</small></li>
  <li><a href="/reconnect">🤝 reconnect</a> <small>people who mattered that you've gone quiet with</small></li>
  <li><a href="/relationships">❤️ relationships</a> <small>closeness across messages + calls + photos — a multi-channel lens</small></li>
</ul>

<h2 class="root-section">api</h2>
<ul class="root-index">
  <li><a href="/api/timeline.json">api: timeline.json</a></li>
  <li><a href="/api/checkins.json">api: checkins.json</a></li>
  <li><a href="/api/storyline.json">api: storyline.json</a></li>
  <li><a href="/api/groups.json">api: groups.json</a></li>
  <li><a href="/api/cohorts.json">api: cohorts.json</a></li>
  <li><a href="/api/graph.json">api: graph.json</a> <small>force-directed connection graph (nodes + edges)</small></li>
  <li><a href="/api/self_bundle.json">api: self_bundle.json</a> <small>daily summary for Prefrontal Cortex iOS — knot + gap + question</small></li>
</ul>
</body></html>`;
}

function renderSelfPage() {
  const dataPath = path.join(ROOT, 'self_bundle.json');
  const b = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf-8')) : null;
  if (!b) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>self</title><style>${PORTRAIT_CSS}</style></head><body><nav class="crumbs"><a href="/">← root</a></nav><h1>self</h1><p>Bundle not yet built. Run <code>node pipeline/build-self-bundle.js</code>.</p></body></html>`;
  }
  const k = b.knot_of_the_day || {};
  const g = b.top_gap || {};
  const q = b.today_question || {};
  const s = b.strength_of_the_day || {};
  const wn = b.whats_new || {};
  const wnItems = Array.isArray(wn.items) ? wn.items : [];
  const esc = z => (z || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>self · today</title>
<style>${PORTRAIT_CSS}
body { max-width: 720px; }
.card { padding: 1.5rem; background: var(--quote-bg); border-left: 3px solid var(--accent); margin-bottom: 1.5rem; }
.card .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.5rem; font-family: ui-monospace, monospace; }
.card h2 { margin-top: 0; font-size: 1.1rem; line-height: 1.4; }
.card .meta { font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--muted); margin-top: 0.5rem; }
.card .move { padding: 0.7rem 0.9rem; background: var(--bg); border-radius: 4px; margin-top: 0.8rem; font-size: 0.9rem; }
.card .move-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent); margin-bottom: 0.3rem; font-family: ui-monospace, monospace; }
.card .question { font-style: italic; font-size: 1rem; color: var(--fg); margin-top: 0.8rem; padding-left: 0.8rem; border-left: 2px solid var(--rule); }
.footer-meta { font-family: ui-monospace, monospace; font-size: 0.72rem; color: var(--muted); margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--rule); }
.annot { margin-top: 1rem; padding-top: 0.8rem; border-top: 1px dashed var(--rule); font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--muted); }
.annot .row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.annot .lbl { color: var(--muted); margin-right: 0.3rem; }
.annot button { font-family: inherit; font-size: 0.78rem; padding: 0.25rem 0.6rem; border: 1px solid var(--rule); background: var(--bg); color: var(--fg); border-radius: 3px; cursor: pointer; }
.annot button:hover { border-color: var(--accent); color: var(--accent); }
.annot button.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.annot .saved { color: #6e8e6a; opacity: 0; transition: opacity 0.2s; margin-left: 0.4rem; }
.annot .saved.show { opacity: 1; }
.annot textarea { width: 100%; box-sizing: border-box; margin-top: 0.5rem; padding: 0.4rem 0.5rem; font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--fg); background: var(--bg); border: 1px solid var(--rule); border-radius: 3px; resize: vertical; min-height: 2.4rem; }
.annot textarea:focus { outline: none; border-color: var(--accent); }
.annot .note-disp { margin-top: 0.4rem; padding: 0.3rem 0.5rem; background: var(--bg); border-left: 2px solid var(--rule); white-space: pre-wrap; font-size: 0.78rem; color: var(--fg); display: none; }
.annot .note-disp.show { display: block; }
.whats-new { padding: 0.7rem 1rem; background: var(--bg); border-left: 3px solid #c4a44a; margin-bottom: 1.5rem; font-size: 0.85rem; }
.whats-new .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); margin-bottom: 0.4rem; font-family: ui-monospace, monospace; }
.whats-new ul { margin: 0; padding-left: 1.2rem; }
.whats-new li { margin-bottom: 0.3rem; line-height: 1.4; }
.whats-new .more { font-family: ui-monospace, monospace; font-size: 0.75rem; color: var(--muted); margin-top: 0.4rem; }
.whats-new a { color: var(--accent); text-decoration: none; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>today</h1>
<p class="essence">${new Date(b.generated_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.</p>

${wnItems.length ? `<div class="whats-new">
  <div class="label">new since yesterday</div>
  <ul>${wnItems.slice(0, 3).map(it => `<li>${esc((it.claim || it.label || it.knot_id || '').slice(0, 220))}</li>`).join('')}</ul>
  <div class="more">${wn.counts ? esc(`${wn.counts.new || 0} new · ${wn.counts.gone || 0} gone · ${wn.counts.stayed || 0} stayed · ${wn.counts.drifted || 0} drifted`) : ''} · <a href="/self/diff">full diff →</a></div>
</div>` : ''}

<div class="card">
  <div class="label">knot of the day</div>
  <h2>${esc(k.claim || 'no knot synthesized yet')}</h2>
  <div class="meta">${esc(k.knot_id || '')} · confidence ${esc(k.confidence || '?')} · ${k.lens_count || 0}/7 lenses converge</div>
  ${k.operational_move ? `<div class="move"><div class="move-label">move this week</div>${esc(k.operational_move)}</div>` : ''}
  ${k.open_question ? `<div class="question">${esc(k.open_question)}</div>` : ''}
  ${k.knot_id ? renderAnnotationBlock(k.knot_id, 'knot') : ''}
</div>

<div class="card" style="border-left-color: #6e8e6a;">
  <div class="label">strength of the day</div>
  <h2>${esc(s.claim || 'no strength surfaced yet')}</h2>
  ${s.strength_id ? `<div class="meta">${esc(s.strength_id)} · confidence ${esc(s.confidence || '?')} · ${s.lens_count || 0}/7 lenses converge</div>` : ''}
  ${s.presence_signature ? `<div style="margin-top:0.6rem; font-size:0.88rem; color:var(--muted)">where it shows up: ${esc(s.presence_signature)}</div>` : ''}
  ${s.amplification_move ? `<div class="move"><div class="move-label">amplify this week</div>${esc(s.amplification_move)}</div>` : ''}
  ${s.strength_id ? renderAnnotationBlock(s.strength_id, 'strength') : ''}
</div>

<div class="card">
  <div class="label">silent and strange</div>
  <h2>${esc(g.name || 'no gap flagged')}</h2>
  ${g.days_silent ? `<div class="meta">${g.days_silent} days silent · baseline ${g.historical_baseline_30d || '?'}/30d · last initiator: ${esc(g.last_initiator || '?')}</div>` : ''}
  ${g.texture ? `<div style="margin-top:0.7rem; font-size:0.95rem">${esc(g.texture)}</div>` : ''}
</div>

<div class="card">
  <div class="label">question to sit with</div>
  <h2 style="font-style: italic">${esc(q.question || 'no question yet')}</h2>
  ${q.knot_id ? `<div class="meta">from ${esc(q.knot_id)}</div>` : ''}
</div>

<div class="footer-meta">
generated: ${esc(b.generated_at)}<br>
knots: ${esc(b.sources?.knots_run || '')} (${esc(b.sources?.knots_model || '')})<br>
gaps: ${esc(b.sources?.gaps_run || '')}
</div>
<script>
(function(){
  const VERDICTS = ['landed', 'missed', 'resolved', 'partial', 'null'];
  // Display label override (UI shows "skip" for the null verdict).
  const VERDICT_LABEL = { landed: 'landed', missed: 'missed', resolved: 'resolved', partial: 'partial', null: 'skip' };

  function escHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function applyState(block, record) {
    const verdict = record && record.verdict;
    block.querySelectorAll('button[data-verdict]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-verdict') === verdict);
    });
    const ta = block.querySelector('textarea[data-note]');
    if (ta && record && typeof record.note === 'string' && document.activeElement !== ta) {
      ta.value = record.note;
    }
    const disp = block.querySelector('.note-disp');
    if (disp) {
      const note = record && record.note;
      if (note && note.trim()) {
        disp.textContent = note;
        disp.classList.add('show');
      } else {
        disp.classList.remove('show');
      }
    }
  }

  function flashSaved(block) {
    const saved = block.querySelector('.saved');
    if (!saved) return;
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 1200);
  }

  async function postAnnotation(payload) {
    const res = await fetch('/api/annotation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  function wireBlock(block) {
    const id = block.getAttribute('data-annot-id');
    const kind = block.getAttribute('data-annot-kind');
    if (!id || !kind) return;
    block.querySelectorAll('button[data-verdict]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const verdict = btn.getAttribute('data-verdict');
        const ta = block.querySelector('textarea[data-note]');
        const note = ta ? ta.value : '';
        try {
          const result = await postAnnotation({ id, kind, verdict, note });
          if (result && result.ok) {
            applyState(block, result.record);
            flashSaved(block);
          }
        } catch (err) {
          console.error('annotation save failed:', err);
        }
      });
    });
    const ta = block.querySelector('textarea[data-note]');
    if (ta) {
      ta.addEventListener('blur', async () => {
        // Only post the note if a verdict already exists for this id.
        const activeBtn = block.querySelector('button[data-verdict].active');
        if (!activeBtn) return;
        const verdict = activeBtn.getAttribute('data-verdict');
        try {
          const result = await postAnnotation({ id, kind, verdict, note: ta.value });
          if (result && result.ok) {
            applyState(block, result.record);
            flashSaved(block);
          }
        } catch (err) {
          console.error('annotation note save failed:', err);
        }
      });
    }
  }

  async function init() {
    const blocks = Array.from(document.querySelectorAll('.annot[data-annot-id]'));
    blocks.forEach(wireBlock);
    try {
      const all = await fetch('/api/annotations.json').then(r => r.json());
      blocks.forEach(b => {
        const id = b.getAttribute('data-annot-id');
        if (all && all[id]) applyState(b, all[id]);
      });
    } catch (err) {
      console.error('annotation pre-load failed:', err);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
</script>
</body></html>`;
}

function renderAnnotationBlock(id, kind) {
  // The textarea + buttons are pre-rendered with empty state; the on-page
  // script fetches /api/annotations.json after load and reflects the current
  // verdict / note. The note-disp div is server-rendered empty — script
  // applies it after fetching to avoid storing user notes inline in HTML.
  const buttons = ['landed', 'missed', 'resolved', 'partial', 'null'].map(v => {
    const label = v === 'null' ? 'skip' : v;
    return `<button type="button" data-verdict="${v}">${label}</button>`;
  }).join('\n    ');
  return `
<div class="annot" data-annot-id="${id}" data-annot-kind="${kind}">
  <div class="row">
    <span class="lbl">mark as:</span>
    ${buttons}
    <span class="saved">✓ saved</span>
  </div>
  <textarea data-note placeholder="optional note (saves on blur)"></textarea>
  <div class="note-disp"></div>
</div>`;
}

function renderGraphPage() {
  const dataPath = path.join(__dirname, 'output', 'graph.json');
  const graph = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf-8')) : { nodes: [], edges: [] };
  const payload = JSON.stringify({ nodes: graph.nodes, edges: graph.edges, co_present_edges: graph.co_present_edges || [] });

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>connection graph</title>
<style>${PORTRAIT_CSS}
body { max-width: none; margin: 0; padding: 0; }
.crumbs { padding: 1rem 2rem 0.5rem; }
.controls { padding: 0 2rem 0.5rem; font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--muted); display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.controls input[type="range"] { vertical-align: middle; }
#graph { width: 100vw; height: calc(100vh - 110px); display: block; background: var(--bg); }
.node { cursor: pointer; }
.node:hover circle { stroke: var(--accent); stroke-width: 2px; }
.node text { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; fill: var(--fg); pointer-events: none; }
.link { stroke: var(--rule); stroke-opacity: 0.4; cursor: pointer; }
.link.highlight { stroke: var(--accent); stroke-opacity: 0.9; }
.link:hover { stroke: var(--accent); stroke-opacity: 0.7; }
#sidepanel { position: fixed; top: 0; right: 0; width: 420px; height: 100vh; background: var(--bg); border-left: 1px solid var(--rule); padding: 1rem; overflow-y: auto; box-shadow: -4px 0 12px rgba(0,0,0,0.05); display: none; font-size: 0.9rem; }
#sidepanel.open { display: block; }
#sidepanel h3 { margin-top: 0; font-size: 1rem; }
#sidepanel h4 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-top: 1.2rem; margin-bottom: 0.4rem; }
#sidepanel .close { float: right; cursor: pointer; color: var(--muted); font-size: 1.2rem; line-height: 1; }
#sidepanel .stats { font-family: ui-monospace, monospace; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.6rem; }
#sidepanel .quote { padding: 0.5rem; background: var(--quote-bg); border-left: 2px solid var(--rule); margin-bottom: 0.4rem; font-size: 0.82rem; }
#sidepanel .quote .when { color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.7rem; margin-bottom: 0.2rem; }
#sidepanel .group-row { padding: 0.3rem 0; border-bottom: 1px solid var(--rule); font-family: ui-monospace, monospace; font-size: 0.78rem; }
#search { padding: 0.3rem 0.6rem; font-size: 0.85rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); color: var(--fg); width: 200px; }
.search-hit circle { stroke: var(--accent); stroke-width: 3px; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a> · <span style="color:var(--muted)">connection graph</span></nav>
<div class="controls">
  <span>${graph.n_nodes || 0} nodes · ${graph.n_edges || 0} edges · ${graph.n_clusters || 0} clusters</span>
  <span>·</span>
  <label>find: <input id="search" type="text" placeholder="name (e.g. leo)"></label>
  <span>·</span>
  <label>min edge weight: <input id="weightSlider" type="range" min="3" max="100" value="3"> <span id="weightVal">3</span></label>
  <span>·</span>
  <label title="people who appear together in your photos"><input type="checkbox" id="coToggle"> 📷 photo co-presence (${graph.n_co_present_edges || 0})</label>
  <span>·</span>
  <span style="color:var(--muted)">click edge → details · click node → portrait · drag · scroll to zoom</span>
</div>
<svg id="graph"></svg>
<div id="sidepanel">
  <span class="close" onclick="document.getElementById('sidepanel').classList.remove('open')">×</span>
  <h3 id="panelTitle"></h3>
  <div class="stats" id="panelStats"></div>
  <div id="panelBody"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7.8.5/dist/d3.min.js"></script>
<script>
const data = ${payload};
const W = window.innerWidth, H = window.innerHeight - 110;
const svg = d3.select('#graph').attr('viewBox', [0, 0, W, H]);
const g = svg.append('g');
svg.call(d3.zoom().scaleExtent([0.3, 4]).on('zoom', (e) => g.attr('transform', e.transform)));

const nodes = data.nodes.map(n => ({...n}));
const edges = data.edges.map(e => ({...e}));
const co = (data.co_present_edges || []).map(e => ({...e}));
const nodeById = new Map(nodes.map(n => [n.id, n]));
const nodeXY = (s) => (typeof s === 'object' ? s : nodeById.get(s));  // co source/target may be string id or (post-forceLink) node object

const sim = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(edges).id(d => d.id).distance(d => 100 + 200 / Math.max(1, Math.log10(d.weight))).strength(0.4))
  .force('colink', d3.forceLink(co).id(d => d.id).distance(90).strength(0.1))
  .force('charge', d3.forceManyBody().strength(-220))
  .force('center', d3.forceCenter(W/2, H/2))
  .force('collide', d3.forceCollide().radius(d => Math.max(12, Math.sqrt(d.msg_count) / 6)));

const clusterColor = d3.scaleOrdinal(d3.schemeTableau10.concat(d3.schemeCategory10).concat(d3.schemeSet3));

function showEdgeDetails(aId, bId, aName, bName, weight, groupOverlap, mentions) {
  document.getElementById('panelTitle').textContent = aName + ' ↔ ' + bName;
  document.getElementById('panelStats').textContent = 'weight ' + weight + ' · ' + groupOverlap + ' shared groups · ' + mentions + ' co-mentions';
  document.getElementById('panelBody').innerHTML = '<em style="color:var(--muted)">loading evidence...</em>';
  document.getElementById('sidepanel').classList.add('open');
  fetch('/api/edge?a=' + encodeURIComponent(aId) + '&b=' + encodeURIComponent(bId))
    .then(r => r.json())
    .then(data => {
      let html = '';
      // back-to-X link so the user can return to either node's panel
      html += '<div style="font-size:0.78rem; margin-bottom:0.6rem; color:var(--muted)">';
      html += '<a href="#" data-show-node="' + aId + '" style="color:var(--accent)">← back to ' + aName + '</a>';
      html += ' &middot; ';
      html += '<a href="#" data-show-node="' + bId + '" style="color:var(--accent)">' + bName + ' →</a>';
      html += '</div>';
      if (data.shared_groups && data.shared_groups.length) {
        html += '<h4>shared group threads (' + data.shared_groups.length + ')</h4>';
        for (const g of data.shared_groups.slice(0, 12)) {
          const parts = (g.participants || []).slice(0, 8).join(', ');
          html += '<div class="group-row">' + g.thread_id.replace(/^[^:]+:/, '') + '<br><span style="color:var(--muted)">' + parts + (g.participants && g.participants.length > 8 ? '…' : '') + '</span></div>';
        }
      }
      if (data.a_mentioned_in_b_thread && data.a_mentioned_in_b_thread.length) {
        html += '<h4>"' + aName + '" mentioned in your thread with ' + bName + '</h4>';
        for (const m of data.a_mentioned_in_b_thread.slice(0, 8)) {
          html += '<div class="quote"><div class="when">' + m.iso + ' · matched: ' + (m.form || '') + '</div>' + (m.body || '').replace(/</g,'&lt;').slice(0, 220) + '</div>';
        }
      }
      if (data.b_mentioned_in_a_thread && data.b_mentioned_in_a_thread.length) {
        html += '<h4>"' + bName + '" mentioned in your thread with ' + aName + '</h4>';
        for (const m of data.b_mentioned_in_a_thread.slice(0, 8)) {
          html += '<div class="quote"><div class="when">' + m.iso + ' · matched: ' + (m.form || '') + '</div>' + (m.body || '').replace(/</g,'&lt;').slice(0, 220) + '</div>';
        }
      }
      if (!data.shared_groups?.length && !data.a_mentioned_in_b_thread?.length && !data.b_mentioned_in_a_thread?.length) {
        html += '<em style="color:var(--muted)">no detail evidence found</em>';
      }
      document.getElementById('panelBody').innerHTML = html;
      // Wire up the back-to-node links
      document.querySelectorAll('#panelBody [data-show-node]').forEach(a => {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const id = a.getAttribute('data-show-node');
          const n = nodes.find(x => x.id === id);
          if (n) showNodeDetails(n);
        });
      });
    })
    .catch(err => {
      document.getElementById('panelBody').innerHTML = '<em style="color:#c53030">error: ' + err.message + '</em>';
    });
}

function showNodeDetails(d) {
  const slug = d.name.replace(/\s+/g, '_');
  const incident = edges
    .filter(l => (l.source.id || l.source) === d.id || (l.target.id || l.target) === d.id)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 16)
    .map(l => {
      const otherId = (l.source.id || l.source) === d.id ? (l.target.id || l.target) : (l.source.id || l.source);
      const other = nodes.find(n => n.id === otherId);
      return { id: otherId, name: other ? other.name : otherId, weight: l.weight, group_overlap: l.group_overlap, mentions: l.mentions };
    });
  document.getElementById('panelTitle').innerHTML = '<a href="/portraits/' + slug + '" style="color:var(--accent); text-decoration:none">' + d.name + ' →</a>';
  document.getElementById('panelStats').textContent = d.msg_count.toLocaleString() + ' msgs · ' + (d.first_iso || '?') + ' → ' + (d.last_iso || '?') + ' · cluster ' + (d.cluster_id ?? '?') + ' · sources: ' + (d.sources || []).join(', ');
  let html = '<h4>top connections (click a name to see the line)</h4>';
  for (const c of incident) {
    html += '<div class="group-row" style="cursor:pointer" data-show-edge="' + d.id + '||' + c.id + '" data-weight="' + c.weight + '" data-go="' + c.group_overlap + '" data-mn="' + c.mentions + '" data-othername="' + c.name.replace(/"/g, '&quot;') + '"><strong style="color:var(--accent)">' + c.name + '</strong> &middot; weight ' + c.weight + ' (' + c.group_overlap + ' groups, ' + c.mentions + ' mentions)</div>';
  }
  html += '<h4 style="margin-top:1rem">open</h4>';
  html += '<a href="/portraits/' + slug + '" style="display:block; padding:0.5rem; background:var(--quote-bg); border-left:2px solid var(--accent); text-decoration:none; color:var(--fg); font-size:0.85rem">→ view portrait</a>';
  document.getElementById('panelBody').innerHTML = html;
  document.getElementById('sidepanel').classList.add('open');
  // Wire up clicks on each connection row → show that edge
  document.querySelectorAll('#panelBody [data-show-edge]').forEach(row => {
    row.addEventListener('click', (e) => {
      const [aId, bId] = row.getAttribute('data-show-edge').split('||');
      showEdgeDetails(aId, bId, d.name, row.getAttribute('data-othername'),
        +row.getAttribute('data-weight'), +row.getAttribute('data-go'), +row.getAttribute('data-mn'));
    });
  });
}

const linkSel = g.append('g').attr('class', 'links').selectAll('line')
  .data(edges).enter().append('line')
  .attr('class', 'link')
  .attr('stroke-width', d => Math.max(0.5, Math.log(d.weight + 1) * 0.6))
  .on('click', (e, d) => {
    e.stopPropagation();
    const aName = (typeof d.source === 'object' ? d.source.name : nodes.find(n => n.id === d.source)?.name) || d.source;
    const bName = (typeof d.target === 'object' ? d.target.name : nodes.find(n => n.id === d.target)?.name) || d.target;
    const aId = (typeof d.source === 'object' ? d.source.id : d.source);
    const bId = (typeof d.target === 'object' ? d.target.id : d.target);
    showEdgeDetails(aId, bId, aName, bName, d.weight, d.group_overlap, d.mentions);
  });

// Phase 6: photo co-presence overlay (hidden until toggled). Drawn between existing
// node positions from the message-graph layout, so it does not perturb the layout.
const coSel = g.append('g').attr('class', 'coedges').selectAll('line')
  .data(co).enter().append('line')
  .attr('stroke', '#e8993a').attr('stroke-dasharray', '5 3')
  .attr('stroke-width', d => Math.max(2, Math.log(d.shared + 1) * 1.3))
  .attr('stroke-opacity', 0.85).style('display', 'none').style('cursor', 'pointer')
  .on('click', (e, d) => {
    e.stopPropagation();
    const a = nodeXY(d.source), b = nodeXY(d.target);
    const aId = a ? a.id : d.source, bId = b ? b.id : d.target;
    document.getElementById('panelTitle').textContent = (a ? a.name : d.source) + ' ↔ ' + (b ? b.name : d.target);
    document.getElementById('panelStats').textContent = '📷 ' + d.shared + ' shared photos';
    document.getElementById('panelBody').innerHTML = '<em style="color:var(--muted)">loading photos…</em>';
    document.getElementById('sidepanel').classList.add('open');
    const b64 = s => btoa(unescape(encodeURIComponent(s))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    fetch('/api/co-photos?a=' + encodeURIComponent(aId) + '&b=' + encodeURIComponent(bId))
      .then(r => r.json())
      .then(data => {
        const ps = data.photos || [];
        if (!ps.length) { document.getElementById('panelBody').innerHTML = '<em style="color:var(--muted)">no shared photos found</em>'; return; }
        let html = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px">';
        for (const p of ps) { const u = '/thumb/' + b64(p.asset_path); html += '<a href="' + u + '" target="_blank"><img src="' + u + '" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:5px" title="' + (p.iso || '') + '"></a>'; }
        html += '</div>';
        document.getElementById('panelBody').innerHTML = html;
      })
      .catch(err => { document.getElementById('panelBody').innerHTML = '<em style="color:#c53030">error: ' + err.message + '</em>'; });
  });

const nodeSel = g.append('g').attr('class', 'nodes').selectAll('g')
  .data(nodes).enter().append('g').attr('class', 'node')
  .on('click', (e, d) => { e.stopPropagation(); showNodeDetails(d); })
  .on('dblclick', (e, d) => {
    e.stopPropagation();
    window.location.href = '/portraits/' + d.name.replace(/\\s+/g, '_');
  })
  .on('mouseover', (e, d) => {
    linkSel.classed('highlight', l => l.source.id === d.id || l.target.id === d.id);
    nodeSel.style('opacity', n => (n.id === d.id || edges.some(l => (l.source.id === d.id && l.target.id === n.id) || (l.target.id === d.id && l.source.id === n.id))) ? 1 : 0.25);
  })
  .on('mouseout', () => {
    linkSel.classed('highlight', false);
    nodeSel.style('opacity', 1);
  })
  .call(d3.drag()
    .on('start', (e, d) => { if (!e.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; }));

nodeSel.append('circle')
  .attr('r', d => Math.max(5, Math.sqrt(d.msg_count) / 6))
  .attr('fill', d => d.photo_only ? '#e8993a' : (d.cluster_id != null ? clusterColor(d.cluster_id) : '#a99580'))
  .attr('stroke', 'var(--bg)').attr('stroke-width', 1);

nodeSel.append('title')
  .text(d => d.name + ' · ' + d.msg_count.toLocaleString() + ' msgs · ' + (d.first_iso || '?').slice(0,7) + ' → ' + (d.last_iso || '?').slice(0,7));

nodeSel.append('text')
  .attr('dx', d => Math.max(7, Math.sqrt(d.msg_count) / 6) + 4)
  .attr('dy', '0.35em')
  .text(d => d.name);

// Photo-only nodes (co-present people who aren't top-80 messagers) show only with the co-presence toggle.
nodeSel.filter(d => d.photo_only).style('display', 'none');

sim.on('tick', () => {
  linkSel.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  coSel.attr('x1', d => (nodeXY(d.source) || {}).x || 0).attr('y1', d => (nodeXY(d.source) || {}).y || 0)
       .attr('x2', d => (nodeXY(d.target) || {}).x || 0).attr('y2', d => (nodeXY(d.target) || {}).y || 0);
  nodeSel.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
});

document.getElementById('weightSlider').addEventListener('input', (e) => {
  const v = +e.target.value;
  document.getElementById('weightVal').textContent = v;
  linkSel.style('display', d => d.weight >= v ? null : 'none');
  sim.alpha(0.1).restart();
});

document.getElementById('coToggle').addEventListener('change', (e) => {
  const on = e.target.checked;
  coSel.style('display', on ? null : 'none');
  nodeSel.filter(d => d.photo_only).style('display', on ? null : 'none');
  sim.alpha(0.2).restart();
});

document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    nodeSel.classed('search-hit', false).style('opacity', 1);
    return;
  }
  nodeSel.classed('search-hit', d => d.name.toLowerCase().includes(q));
  nodeSel.style('opacity', d => d.name.toLowerCase().includes(q) ? 1 : 0.2);
});
</script>
</body></html>`;
}


// Slug for a group thread: thread_id with punctuation flattened to dashes.
function groupSlug(threadId) {
  return String(threadId || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// /groups/<slug> — per-group detail. Reads the same groups.json the index
// fetches, so it works wherever DATA_DIR points (including the demo set).
function renderGroupDetail(slug) {
  let groups = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'groups.json'), 'utf-8'));
    groups = Array.isArray(raw) ? raw : (raw.groups || Object.values(raw));
  } catch {
    return { status: 404, html: `<!DOCTYPE html><meta charset="utf-8"><title>groups</title><style>${PORTRAIT_CSS}</style>`
      + `<nav class="crumbs"><a href="/groups">← groups</a></nav><h1>no groups data</h1>`
      + `<p class="essence">groups.json is not present in this dataset.</p>` };
  }
  const g = groups.find((x) => groupSlug(x.thread_id) === slug);
  if (!g) {
    return { status: 404, html: `<!DOCTYPE html><meta charset="utf-8"><title>group not found</title><style>${PORTRAIT_CSS}</style>`
      + `<nav class="crumbs"><a href="/groups">← groups</a></nav><h1>group not found</h1>`
      + `<p class="essence">No group matches <code>${escapeHtml(slug)}</code>.</p>` };
  }
  const members = (g.members || []).slice().sort((a, b) => (b.msg_count || 0) - (a.msg_count || 0));
  const maxShare = Math.max(1, ...members.map((m) => m.share_pct || 0));
  const rows = members.map((m) => `<tr>
      <td>${escapeHtml(m.sender_name || '?')}</td>
      <td class="num">${(m.msg_count || 0).toLocaleString()}</td>
      <td class="num">${m.share_pct || 0}%</td>
      <td><span class="bar" style="width:${Math.round(((m.share_pct || 0) / maxShare) * 100)}%"></span></td>
    </tr>`).join('\n');
  const status = escapeHtml(g.life_status || 'unknown');
  return { status: 200, html: `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(g.name || 'group')}</title>
<style>${PORTRAIT_CSS}
body { max-width: 760px; }
table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
td, th { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--rule); text-align: left; }
td.num, th.num { text-align: right; font-family: ui-monospace, monospace; font-size: 0.85rem; }
.bar { display: inline-block; height: 0.55rem; background: var(--accent); border-radius: 2px; }
.meta { font-family: ui-monospace, monospace; font-size: 0.8rem; color: var(--muted); }
</style></head><body>
<nav class="crumbs"><a href="/groups">← groups</a></nav>
<h1>${escapeHtml(g.name || '(unnamed group)')}</h1>
<p class="meta">${escapeHtml(g.source || '?')} · ${(g.msg_count || 0).toLocaleString()} messages ·
${escapeHtml(g.first_iso || '?')} → ${escapeHtml(g.last_iso || '?')} ·
${g.days_since_last != null ? escapeHtml(String(g.days_since_last)) + 'd since last' : ''} · ${status}</p>
<p class="essence">${members.length} member${members.length === 1 ? '' : 's'}${g.peak_month ? ', peak ' + escapeHtml(g.peak_month) : ''}.</p>
<table><thead><tr><th>member</th><th class="num">messages</th><th class="num">share</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="4">no member breakdown</td></tr>'}</tbody></table>
</body></html>` };
}

function renderGroupsPage() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>groups</title>
<style>${PORTRAIT_CSS}
body { max-width: 980px; }
.tabs { font-family: ui-monospace, monospace; font-size: 0.85rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--rule); padding-bottom: 0.5rem; }
.tabs a { margin-right: 1rem; color: var(--muted); text-decoration: none; padding: 0.3rem 0.5rem; }
.tabs a.active { color: var(--accent); border-bottom: 2px solid var(--accent); padding-bottom: calc(0.5rem - 2px); }
.row { padding: 0.7rem 0; border-bottom: 1px solid var(--rule); }
.row .name { font-weight: 600; font-size: 1rem; color: var(--fg); }
.row .meta { font-family: ui-monospace, monospace; font-size: 0.75rem; color: var(--muted); margin-top: 0.2rem; }
.row .members { font-size: 0.85rem; margin-top: 0.3rem; }
.row .members .primary { font-weight: 600; color: var(--accent); }
.tag { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 3px; font-size: 0.7rem; margin-right: 0.3rem; }
.tag.active { background: #6e8e6a; color: white; }
.tag.cooling { background: #c4a44a; color: white; }
.tag.dormant { background: #b3a684; color: white; }
.tag.dead { background: var(--quote-bg); color: var(--muted); }
.section { display: none; }
.section.active { display: block; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>groups</h1>
<p class="essence">Group chats analysed differently — top groups by volume, cohorts of intimate groups, social bridges, and group → 1-on-1 graduation patterns.</p>
<div class="tabs">
  <a href="#groups" class="tab-link active" data-tab="groups">groups</a>
  <a href="#cohorts" class="tab-link" data-tab="cohorts">cohorts</a>
  <a href="#bridges" class="tab-link" data-tab="bridges">bridges</a>
  <a href="#graduation" class="tab-link" data-tab="graduation">graduation</a>
  <span style="float:right"><a href="/api/groups.json">json</a> · <a href="/api/cohorts.json">json</a></span>
</div>
<div id="groups-section" class="section active"><div id="groups-list"></div></div>
<div id="cohorts-section" class="section"><div id="cohorts-list"></div></div>
<div id="bridges-section" class="section"><div id="bridges-list"></div></div>
<div id="graduation-section" class="section"><div id="graduation-list"></div></div>
<script>
async function load() {
  const [groups, cohorts] = await Promise.all([
    fetch('/api/groups.json').then(r => r.json()),
    fetch('/api/cohorts.json').then(r => r.json()),
  ]);

  // groups list
  const gRoot = document.getElementById('groups-list');
  for (const g of groups.groups) {
    const tag = '<span class="tag ' + g.life_status + '">' + g.life_status + '</span>';
    const slug = g.thread_id.replace(/[^\\w\\-]+/g, '_');
    const portraitLink = '<a href="/portraits/group_' + (g.thread_id.replace(/^fb:/, '').replace(/_.*$/, '')) + '">portrait</a>';
    const top = g.members.filter(m => m.sender_name !== 'Demo User').slice(0, 5).map(m => m.sender_name + ' (' + m.share_pct + '%)').join(', ');
    const div = document.createElement('div'); div.className = 'row';
    div.innerHTML =
      '<div class="name">' + g.name + ' ' + tag + '</div>' +
      '<div class="meta">' + g.msg_count.toLocaleString() + ' msgs · ' + g.distinct_senders + ' people · ' + g.first_iso + ' → ' + g.last_iso + ' (peak ' + g.peak_month + ') · ' + portraitLink + '</div>' +
      '<div class="members">top: ' + top + '</div>';
    gRoot.appendChild(div);
  }

  // cohorts (intimate groups)
  const cRoot = document.getElementById('cohorts-list');
  for (const c of cohorts.cohorts) {
    const members = c.members.slice(0, 8).map(m => '<span' + (m.is_primary ? ' class="primary"' : '') + '>' + m.display_name + '</span>').join(' · ');
    const div = document.createElement('div'); div.className = 'row';
    div.innerHTML =
      '<div class="name">' + c.cohort_label + '</div>' +
      '<div class="meta">' + c.total_msgs.toLocaleString() + ' msgs · ' + c.member_count + ' members · ' + c.first + ' → ' + c.last + '</div>' +
      '<div class="members">' + members + (c.member_count > 8 ? ' +' + (c.member_count - 8) + ' more' : '') + '</div>';
    cRoot.appendChild(div);
  }

  // bridges
  const bRoot = document.getElementById('bridges-list');
  for (const b of cohorts.bridges) {
    const div = document.createElement('div'); div.className = 'row';
    div.innerHTML =
      '<div class="name">' + b.display_name + '</div>' +
      '<div class="meta">' + b.group_count + ' groups</div>';
    bRoot.appendChild(div);
  }

  // graduation
  const grRoot = document.getElementById('graduation-list');
  for (const g of cohorts.graduation.filter(x => x.sequence === 'group_first').slice(0, 60)) {
    const yrs = (g.lag_days / 365).toFixed(1);
    const div = document.createElement('div'); div.className = 'row';
    div.innerHTML =
      '<div class="name">' + g.display_name + '</div>' +
      '<div class="meta">' + yrs + ' yr lag · group ' + g.first_group + ' → 1on1 ' + g.first_1on1 + '</div>';
    grRoot.appendChild(div);
  }
}
load();
document.querySelectorAll('.tab-link').forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  document.querySelectorAll('.tab-link').forEach(x => x.classList.remove('active'));
  a.classList.add('active');
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(a.dataset.tab + '-section').classList.add('active');
}));
</script>
</body></html>`;
}

function renderStoryline() {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>storyline</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>${PORTRAIT_CSS}
body { max-width: none; margin: 0; padding: 0; }
.wrap { padding: 1rem 2rem; }
.controls { font-family: ui-monospace, monospace; font-size: 0.85rem; margin-bottom: 1rem; display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }
.controls a { color: var(--accent); text-decoration: none; }
svg { display: block; max-width: 100%; height: auto; background: var(--bg); }
.year-label { font-family: ui-monospace, monospace; font-size: 11px; fill: var(--muted); }
.year-tick { stroke: var(--rule); stroke-dasharray: 2 2; }
.person-label { font-family: 'Iowan Old Style', Georgia, serif; font-size: 11px; fill: var(--fg); pointer-events: none; }
.person-label.portrait { font-weight: 600; fill: var(--accent); }
.ribbon { mix-blend-mode: multiply; cursor: pointer; transition: opacity 0.15s; }
@media (prefers-color-scheme: dark) { .ribbon { mix-blend-mode: screen; } }
.ribbon.dim { opacity: 0.08; }
.ribbon.hot { opacity: 0.95; }
.tooltip { position: fixed; pointer-events: none; padding: 0.5rem 0.7rem; background: var(--quote-bg); border: 1px solid var(--rule); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--fg); max-width: 280px; line-height: 1.35; opacity: 0; transition: opacity 0.1s; z-index: 10; }
.tooltip.show { opacity: 1; }
.tooltip strong { color: var(--accent); }
.crossarc { fill: none; stroke-opacity: 0.18; pointer-events: none; mix-blend-mode: multiply; }
@media (prefers-color-scheme: dark) { .crossarc { mix-blend-mode: screen; } }
</style>
</head><body>
<div class="wrap">
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>storyline</h1>
<p class="essence">Top 30 by message volume. Each person is a ribbon — thickness is monthly activity, color is volume tier (★ portrait), arcs across the interior connect threads where two people were mentioned in each other's chats that month.</p>
<div class="controls">
  <label><input id="show-arcs" type="checkbox" checked> co-mention arcs</label>
  <label><input id="show-labels" type="checkbox" checked> labels</label>
  <span id="status" style="color: var(--muted)">loading…</span>
  <a href="/api/storyline.json">json</a>
</div>
<div id="chart"></div>
<div id="tooltip" class="tooltip"></div>
</div>
<script>
(async () => {
  const data = await fetch('/api/storyline.json').then(r => r.json());
  const status = document.getElementById('status');
  status.textContent = data.people.length + ' people · ' + data.months.length + ' months (' + data.months[0] + ' → ' + data.months[data.months.length-1] + ')';

  const W = Math.max(1200, window.innerWidth - 100);
  const padTop = 24, padBottom = 60, padLeft = 200, padRight = 40;
  const ROW_H = 26;
  const innerH = ROW_H * data.people.length;
  const H = padTop + innerH + padBottom;

  const ordered = [...data.people].sort((a, b) =>
    (b.has_portrait?1:0) - (a.has_portrait?1:0) || b.total_msgs - a.total_msgs
  );
  const yOf = new Map(ordered.map((p, i) => [p.canonical_id, padTop + ROW_H * (i + 0.5)]));

  const xStep = (W - padLeft - padRight) / Math.max(1, data.months.length - 1);
  const xOf = (i) => padLeft + i * xStep;
  const monthIdx = new Map(data.months.map((m, i) => [m, i]));

  let maxMsgs = 1;
  for (const p of ordered) {
    const a = data.activity[p.canonical_id] || {};
    for (const ym of Object.keys(a)) maxMsgs = Math.max(maxMsgs, (a[ym].msgs || 0));
  }
  const thicknessOf = (n) => !n ? 0.5 : 1.5 + 12 * Math.sqrt(n / maxMsgs);
  const colorOf = (i) => i < 5 ? '#5a5044' : i < 15 ? '#8b7d5e' : '#b3a684';

  const svg = d3.select('#chart').append('svg')
    .attr('width', W).attr('height', H).attr('viewBox', '0 0 ' + W + ' ' + H);

  const yearTicks = [];
  let lastYear = '';
  for (let i = 0; i < data.months.length; i++) {
    const y = data.months[i].slice(0, 4);
    if (y !== lastYear) { yearTicks.push({ idx: i, year: y }); lastYear = y; }
  }
  const tickG = svg.append('g').attr('class', 'ticks');
  tickG.selectAll('line').data(yearTicks).join('line')
    .attr('class', 'year-tick')
    .attr('x1', d => xOf(d.idx)).attr('x2', d => xOf(d.idx))
    .attr('y1', padTop - 8).attr('y2', H - padBottom + 8);
  tickG.selectAll('text').data(yearTicks).join('text')
    .attr('class', 'year-label')
    .attr('x', d => xOf(d.idx) + 4).attr('y', H - padBottom + 22)
    .text(d => d.year);

  const arcG = svg.append('g').attr('class', 'arcs');
  function renderArcs() {
    const showArcs = document.getElementById('show-arcs').checked;
    arcG.selectAll('path').remove();
    if (!showArcs) return;
    const arcs = [];
    for (const ym of Object.keys(data.co_active)) {
      const idx = monthIdx.get(ym);
      if (idx == null) continue;
      const x = xOf(idx);
      for (const [a, b, w] of data.co_active[ym].slice(0, 3)) {
        const ya = yOf.get(a), yb = yOf.get(b);
        if (ya == null || yb == null) continue;
        arcs.push({ x, ya, yb, w });
      }
    }
    const wMax = Math.max(1, ...arcs.map(a => a.w));
    arcG.selectAll('path').data(arcs).join('path')
      .attr('class', 'crossarc')
      .attr('stroke', '#c8954a')
      .attr('stroke-width', d => 0.5 + 1.8 * Math.sqrt(d.w / wMax))
      .attr('d', d => {
        const mid = (d.ya + d.yb) / 2;
        const offset = Math.min(40, Math.abs(d.yb - d.ya) * 0.25);
        return 'M' + d.x + ',' + d.ya + ' Q' + (d.x + offset) + ',' + mid + ' ' + d.x + ',' + d.yb;
      });
  }

  const ribbonG = svg.append('g').attr('class', 'ribbons');
  const area = d3.area()
    .x(d => d.x)
    .y0(d => d.y - d.h / 2)
    .y1(d => d.y + d.h / 2)
    .curve(d3.curveCatmullRom.alpha(0.5));

  ordered.forEach((p, i) => {
    const yc = yOf.get(p.canonical_id);
    const a = data.activity[p.canonical_id] || {};
    const points = data.months.map((ym, mi) => {
      const v = a[ym] || { msgs: 0 };
      return { x: xOf(mi), y: yc, h: thicknessOf(v.msgs) };
    });
    ribbonG.append('path')
      .datum(points)
      .attr('class', 'ribbon')
      .attr('data-cid', p.canonical_id)
      .attr('fill', colorOf(i))
      .attr('opacity', 0.55)
      .attr('d', area)
      .on('mouseenter', (e) => onHover(p, e))
      .on('mouseleave', onLeave)
      .on('click', () => {
        if (p.has_portrait) {
          const slug = p.display_name.replace(/[^\\w\\-]+/g, '_').replace(/^_+|_+$/g, '');
          window.location.href = '/portraits/' + slug;
        }
      });
  });

  const labelG = svg.append('g').attr('class', 'labels');
  function renderLabels() {
    const show = document.getElementById('show-labels').checked;
    labelG.selectAll('text').remove();
    if (!show) return;
    labelG.selectAll('text').data(ordered).join('text')
      .attr('class', d => 'person-label' + (d.has_portrait ? ' portrait' : ''))
      .attr('x', padLeft - 10).attr('y', d => yOf.get(d.canonical_id) + 4)
      .attr('text-anchor', 'end')
      .text(d => (d.has_portrait ? '★ ' : '') + d.display_name);
  }

  const tt = document.getElementById('tooltip');
  function onHover(p, e) {
    d3.selectAll('.ribbon').classed('dim', true);
    d3.select('.ribbon[data-cid="' + p.canonical_id + '"]').classed('dim', false).classed('hot', true);
    const a = data.activity[p.canonical_id] || {};
    const months = Object.keys(a).filter(ym => a[ym].msgs > 0);
    const peakMonth = months.sort((x, y) => a[y].msgs - a[x].msgs)[0] || '';
    const total = Object.values(a).reduce((s, v) => s + (v.msgs || 0), 0);
    tt.innerHTML = '<strong>' + p.display_name + '</strong>' + (p.has_portrait ? ' ★' : '') + '<br>' +
      total.toLocaleString() + ' msgs · ' + p.sources.join(', ') + '<br>' +
      (months.length ? 'active ' + months.length + ' months · peak ' + peakMonth + ' (' + a[peakMonth].msgs + ' msgs)' : 'no monthly data');
    tt.classList.add('show');
    moveTooltip(e);
  }
  function onLeave() {
    d3.selectAll('.ribbon').classed('dim', false).classed('hot', false);
    tt.classList.remove('show');
  }
  function moveTooltip(e) {
    tt.style.left = (e.clientX + 14) + 'px';
    tt.style.top = (e.clientY + 14) + 'px';
  }
  document.addEventListener('mousemove', moveTooltip);

  document.getElementById('show-arcs').addEventListener('change', renderArcs);
  document.getElementById('show-labels').addEventListener('change', renderLabels);
  renderArcs(); renderLabels();
})();
</script>
</body></html>`;
}

// Read the trajectories index, mapping slug (underscore-spaced display name) →
// canonical_id. Slug pattern matches /portraits/<Name> exactly so a person who
// has both a portrait and a trajectory can move between them by URL alone.
function loadTrajectoryIndex() {
  const dir = path.join(ROOT, 'self', 'trajectories');
  const idxPath = path.join(dir, 'index.json');
  if (!fs.existsSync(idxPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    const bySlug = new Map();
    const byCid = new Map();
    for (const p of (data.people || [])) {
      const slug = (p.display_name || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
      if (slug) bySlug.set(slug, p);
      byCid.set(p.canonical_id, p);
    }
    return { data, bySlug, byCid, dir };
  } catch (err) {
    console.error('[trajectory] failed to load index:', err.message);
    return null;
  }
}

function renderTrajectoryIndex() {
  const idx = loadTrajectoryIndex();
  if (!idx) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>trajectories</title><style>${PORTRAIT_CSS}</style></head><body><nav class="crumbs"><a href="/">← root</a></nav><h1>trajectories</h1><p>Not yet built. Run <code>node pipeline/build-trajectories.js</code>.</p></body></html>`;
  }
  const items = [...idx.data.people]
    .sort((a, b) => b.total_messages - a.total_messages)
    .map(p => {
      const slug = (p.display_name || '').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
      return `<li><a href="/trajectory/${encodeURIComponent(slug)}">${p.display_name}</a> <small>${p.total_messages.toLocaleString()} msgs · ${p.first_iso} → ${p.last_iso}</small></li>`;
    }).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>trajectories</title>
<style>${PORTRAIT_CSS}
ul.portrait-index small { color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.75rem; margin-left: 0.5rem; }
</style></head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>trajectories</h1>
<p class="essence">Per-friend monthly volume + register-shift overlay for the top ${idx.data.count} contacts.</p>
<ul class="portrait-index">${items}</ul>
</body></html>`;
}

function renderTrajectoryPage(slug) {
  const idx = loadTrajectoryIndex();
  if (!idx) {
    return { code: 503, body: `<!DOCTYPE html><html><body><h1>trajectories not built</h1><p>Run <code>node pipeline/build-trajectories.js</code>.</p></body></html>` };
  }
  const meta = idx.bySlug.get(slug);
  if (!meta) {
    return { code: 404, body: `<!DOCTYPE html><html><body><nav><a href="/trajectory/">← all</a></nav><h1>trajectory not found</h1><p>No trajectory for <code>${slug.replace(/[<>]/g, '')}</code> (top ${idx.data.count} only).</p></body></html>` };
  }
  const dataPath = path.join(idx.dir, meta.canonical_id + '.json');
  if (!fs.existsSync(dataPath)) {
    return { code: 404, body: `<!DOCTYPE html><html><body><h1>missing data file</h1></body></html>` };
  }
  const traj = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  const portraitSlug = (traj.display_name || '').replace(/\s+/g, '_');
  const hasPortrait = fs.existsSync(path.join(ROOT, 'portraits', portraitSlug + '.md'));
  // Escape `</script>` etc so a message-body excerpt can't break out of the inlined data.
  const payload = JSON.stringify(traj).replace(/<\/(script)/gi, '<\\/$1');
  const safeName = (traj.display_name || '').replace(/[<>]/g, '');
  const portraitLink = hasPortrait
    ? `<a href="/portraits/${portraitSlug}">portrait</a> · `
    : '';
  return { code: 200, body: `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeName} — trajectory</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7.8.5/dist/d3.min.js"></script>
<style>${PORTRAIT_CSS}
body { max-width: 960px; }
.summary { font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--muted); padding: 0.6rem 0.9rem; background: var(--quote-bg); border-left: 2px solid var(--rule); margin: 0 0 1.5rem; line-height: 1.6; }
.layout { display: grid; grid-template-columns: 1fr 240px; gap: 1.5rem; align-items: start; }
@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
.chart-wrap { background: var(--bg); border: 1px solid var(--rule); border-radius: 4px; padding: 0.5rem 0.5rem 0.2rem; overflow: hidden; }
svg.chart { width: 100%; height: auto; display: block; }
.legend { font-family: ui-monospace, monospace; font-size: 0.72rem; color: var(--muted); display: flex; gap: 1rem; flex-wrap: wrap; padding: 0.4rem 0.5rem 0.7rem; }
.legend .swatch { display: inline-block; width: 0.7rem; height: 0.7rem; vertical-align: middle; margin-right: 0.3rem; border-radius: 2px; }
.legend .line { display: inline-block; width: 1.1rem; height: 0; vertical-align: middle; margin-right: 0.3rem; border-top: 2px solid; }
aside.sidebar { font-size: 0.85rem; }
aside.sidebar .stat { padding: 0.5rem 0; border-bottom: 1px solid var(--rule); }
aside.sidebar .stat .label { font-family: ui-monospace, monospace; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
aside.sidebar .stat .val { font-size: 1.2rem; font-weight: 600; color: var(--fg); }
aside.sidebar .stat .sub { font-size: 0.78rem; color: var(--muted); font-family: ui-monospace, monospace; margin-top: 0.15rem; }
aside.sidebar .stat.urgent .val { color: #c97a4a; }
.moments { margin-top: 1.5rem; }
.moment { padding: 0.6rem 0; border-bottom: 1px solid var(--rule); display: grid; grid-template-columns: 7rem 1fr; gap: 0.7rem; align-items: baseline; }
.moment .when { font-family: ui-monospace, monospace; font-size: 0.78rem; color: var(--muted); }
.moment .what { font-size: 0.9rem; }
.moment .what .kind { font-family: ui-monospace, monospace; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--accent); margin-right: 0.4rem; }
.moment .what em { color: var(--muted); font-style: italic; }
.tooltip { position: fixed; pointer-events: none; padding: 0.4rem 0.6rem; background: var(--quote-bg); border: 1px solid var(--rule); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 0.74rem; color: var(--fg); max-width: 220px; opacity: 0; transition: opacity 0.1s; z-index: 10; line-height: 1.4; }
.tooltip.show { opacity: 1; }
@media (max-width: 600px) { .moment { grid-template-columns: 5.5rem 1fr; gap: 0.4rem; } body { font-size: 16px; } }
</style></head><body>
<nav class="crumbs"><a href="/">← root</a> · ${portraitLink}<span style="color:var(--muted)">trajectory: ${safeName}</span></nav>
<h1>${safeName}</h1>
<p class="essence">${traj.total_messages.toLocaleString()} messages · ${traj.first_iso} → ${traj.last_iso}</p>
<div class="summary">
sources: ${(traj.sources || []).join(', ') || 'unknown'}<br>
from_me: ${traj.from_me_total.toLocaleString()} · from_them: ${traj.from_them_total.toLocaleString()} · share_me: ${traj.total_messages > 0 ? Math.round(100 * traj.from_me_total / traj.total_messages) : 0}%
</div>
<div class="layout">
  <div>
    <div class="chart-wrap"><svg class="chart" id="chart"></svg></div>
    <div class="legend">
      <span><span class="swatch" style="background:#5a5044"></span>from_me</span>
      <span><span class="swatch" style="background:#a99580"></span>from_them</span>
      <span><span class="line" style="border-color:#c97a4a"></span>hedge per 1k</span>
      <span><span class="line" style="border-color:#6e8e6a; border-style:dashed"></span>asking per 1k</span>
    </div>
    <h2 class="moments-h" style="margin-top:1.5rem; font-size:0.85rem; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); border-bottom:1px solid var(--rule); padding-bottom:0.3rem">key moments</h2>
    <div class="moments" id="moments"></div>
  </div>
  <aside class="sidebar" id="sidebar"></aside>
</div>
<div class="tooltip" id="tt"></div>
<script>
const traj = ${payload};
// ===== Sidebar (current state) =====
(() => {
  const c = traj.current || {};
  const baseline = c.baseline_30d || 0;
  const recent = c.recent_30d || 0;
  const ratio = baseline > 0 ? Math.round(100 * recent / baseline) : null;
  const ratioStr = ratio == null ? 'n/a' : ratio + '% of baseline';
  const isQuiet = c.days_since_last >= 14;
  const sb = document.getElementById('sidebar');
  sb.innerHTML =
    '<div class="stat' + (isQuiet ? ' urgent' : '') + '">' +
      '<div class="label">days since last</div>' +
      '<div class="val">' + c.days_since_last + '</div>' +
      '<div class="sub">last: ' + traj.last_iso + ' · ' + (c.last_initiator === 'me' ? 'you' : 'them') + ' sent</div>' +
    '</div>' +
    '<div class="stat">' +
      '<div class="label">recent 30d</div>' +
      '<div class="val">' + recent + '</div>' +
      '<div class="sub">baseline: ' + baseline + '/30d · ' + ratioStr + '</div>' +
    '</div>' +
    '<div class="stat">' +
      '<div class="label">share me / them</div>' +
      '<div class="val">' + (traj.total_messages > 0 ? Math.round(100 * traj.from_me_total / traj.total_messages) : 0) + '%</div>' +
      '<div class="sub">' + traj.from_me_total.toLocaleString() + ' / ' + traj.from_them_total.toLocaleString() + '</div>' +
    '</div>';
})();

// ===== Key moments list =====
(() => {
  const root = document.getElementById('moments');
  for (const k of (traj.key_moments || [])) {
    const div = document.createElement('div');
    div.className = 'moment';
    let when = k.iso || (k.iso_start ? k.iso_start + ' →' : '') || k.month || '';
    let body;
    if (k.kind === 'first_message') {
      body = '<span class="kind">first</span><em>' + (k.excerpt || '').replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c])) + '</em>';
    } else if (k.kind === 'last_message') {
      body = '<span class="kind">last</span><em>' + (k.excerpt || '').replace(/[<>]/g, c => ({'<':'&lt;','>':'&gt;'}[c])) + '</em>';
    } else if (k.kind === 'longest_gap') {
      when = k.iso_start + ' → ' + k.iso_end;
      body = '<span class="kind">longest gap</span>' + k.days + ' days of silence';
    } else if (k.kind === 'peak_month') {
      when = k.month;
      body = '<span class="kind">peak month</span>' + k.total.toLocaleString() + ' messages';
    } else if (k.kind === 'biggest_day') {
      body = '<span class="kind">biggest day</span>' + k.total.toLocaleString() + ' messages';
    } else {
      body = '<span class="kind">' + k.kind + '</span>' + JSON.stringify(k);
    }
    div.innerHTML = '<div class="when">' + when + '</div><div class="what">' + body + '</div>';
    root.appendChild(div);
  }
})();

// ===== Chart =====
(() => {
  const monthly = traj.monthly || [];
  if (!monthly.length) return;
  const W = Math.min(900, Math.max(320, document.querySelector('.chart-wrap').clientWidth - 12));
  const H = Math.max(320, Math.min(440, Math.round(W * 0.55)));
  const margin = { top: 14, right: 56, bottom: 32, left: 44 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;
  const svg = d3.select('#chart').attr('viewBox', '0 0 ' + W + ' ' + H);
  const g = svg.append('g').attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

  // x: ordinal months, treated as a continuous index for nicer area shape
  const x = d3.scalePoint().domain(monthly.map(m => m.month)).range([0, innerW]).padding(0.5);
  const yMax = d3.max(monthly, m => m.total) || 1;
  const y = d3.scaleLinear().domain([0, yMax * 1.05]).range([innerH, 0]).nice();

  const densMax = Math.max(
    d3.max(monthly, m => m.hedge_per_1k) || 0,
    d3.max(monthly, m => m.asking_per_1k) || 0,
    1
  );
  const yDens = d3.scaleLinear().domain([0, densMax * 1.1]).range([innerH, 0]).nice();

  // Axes — only every Nth tick to keep mobile-readable
  const tickStep = Math.max(1, Math.ceil(monthly.length / 8));
  const xTicks = monthly.filter((_, i) => i % tickStep === 0).map(m => m.month);
  g.append('g').attr('transform', 'translate(0,' + innerH + ')')
    .call(d3.axisBottom(x).tickValues(xTicks).tickSizeOuter(0))
    .selectAll('text').attr('font-size', '10px').attr('fill', 'var(--muted)');
  g.append('g').call(d3.axisLeft(y).ticks(5).tickSizeOuter(0))
    .selectAll('text').attr('font-size', '10px').attr('fill', 'var(--muted)');
  g.append('g').attr('transform', 'translate(' + innerW + ',0)')
    .call(d3.axisRight(yDens).ticks(4).tickSizeOuter(0))
    .selectAll('text').attr('font-size', '10px').attr('fill', 'var(--muted)');
  g.selectAll('.domain, .tick line').attr('stroke', 'var(--rule)');

  // Stacked area: from_them stacked on top of from_me
  const stackedTo = (key) => d3.area()
    .x(d => x(d.month))
    .y0(d => key === 'from_them' ? y(d.from_me) : innerH)
    .y1(d => key === 'from_them' ? y(d.from_me + d.from_them) : y(d.from_me))
    .curve(d3.curveMonotoneX);

  g.append('path').datum(monthly)
    .attr('fill', '#5a5044').attr('opacity', 0.85)
    .attr('d', stackedTo('from_me'));
  g.append('path').datum(monthly)
    .attr('fill', '#a99580').attr('opacity', 0.7)
    .attr('d', stackedTo('from_them'));

  // Density lines (right axis)
  const lineHedge = d3.line().x(d => x(d.month)).y(d => yDens(d.hedge_per_1k)).curve(d3.curveMonotoneX);
  const lineAsk = d3.line().x(d => x(d.month)).y(d => yDens(d.asking_per_1k)).curve(d3.curveMonotoneX);
  g.append('path').datum(monthly)
    .attr('fill', 'none').attr('stroke', '#c97a4a').attr('stroke-width', 1.6)
    .attr('opacity', 0.85).attr('d', lineHedge);
  g.append('path').datum(monthly)
    .attr('fill', 'none').attr('stroke', '#6e8e6a').attr('stroke-width', 1.6)
    .attr('stroke-dasharray', '4 3').attr('opacity', 0.85).attr('d', lineAsk);

  // Hover overlay
  const tt = document.getElementById('tt');
  const hover = g.append('g').style('display', 'none');
  hover.append('line').attr('stroke', 'var(--accent)').attr('stroke-dasharray', '2 2').attr('y1', 0).attr('y2', innerH);
  const dot = hover.append('circle').attr('r', 3).attr('fill', 'var(--accent)');
  function findNearest(mx) {
    let best = monthly[0], bestD = Infinity;
    for (const m of monthly) {
      const d = Math.abs(x(m.month) - mx);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }
  svg.on('mousemove touchmove', (evt) => {
    const [mx] = d3.pointer(evt);
    const m = findNearest(mx - margin.left);
    if (!m) return;
    hover.style('display', null).attr('transform', 'translate(' + x(m.month) + ',0)');
    dot.attr('cy', y(m.from_me + m.from_them));
    tt.classList.add('show');
    tt.innerHTML = '<strong>' + m.month + '</strong><br>' +
      'total ' + m.total + '<br>' +
      'me ' + m.from_me + ' / them ' + m.from_them + '<br>' +
      'hedge/1k ' + m.hedge_per_1k.toFixed(1) + '<br>' +
      'ask/1k ' + m.asking_per_1k.toFixed(1) + '<br>' +
      'med len ' + m.median_msg_len;
    const ev = evt.touches ? evt.touches[0] : evt;
    tt.style.left = (ev.clientX + 14) + 'px';
    tt.style.top = (ev.clientY + 14) + 'px';
  });
  svg.on('mouseleave touchend', () => {
    hover.style('display', 'none');
    tt.classList.remove('show');
  });
})();
</script>
</body></html>` };
}

function renderPortraitIndex(absDir) {
  const files = fs.readdirSync(absDir).filter(f => f.endsWith('.md')).sort();
  const people = files.filter(f => !f.startsWith('group_'));
  const groups = files.filter(f => f.startsWith('group_'));
  const renderItem = (f) => {
    const slug = f.replace(/\.md$/, '');
    const display = slug.replace(/^group_/, '').replace(/_/g, ' ');
    return `<li><a href="${encodeURIComponent(slug)}">${display}</a></li>`;
  };
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>portraits</title>
<style>${PORTRAIT_CSS}
h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-top: 2.5rem; padding-bottom: 0.4rem; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a></nav>
<h1>portraits</h1>
<p class="essence">${people.length} people · ${groups.length} groups.</p>
<h2>people</h2>
<ul class="portrait-index">${people.map(renderItem).join('\n')}</ul>
<h2>groups</h2>
<ul class="portrait-index">${groups.map(renderItem).join('\n')}</ul>
</body></html>`;
}

// ---- /sit-with — priority list of things to think about + mark up ----
//
// Parses the key reflection-target documents (knots, cross-portrait, action
// loop) into a single ordered queue. Each item links into the doc at the
// matching anchor and shows live verdict+note state pulled from
// /api/annotations.json. Verdict-bar is repeated inline so quick decisions
// (loosened/true/wrong/unsure/retire) don't require leaving the page.
//
// Priority order is hand-curated below — knots first (the load-bearing
// hypotheses), cross-portrait second (the cross-friend shapes), action-loop
// last (process meta — the gates and risks worth re-asking).
const SIT_WITH_DOCS = [
  // Each entry is a markdown doc under <ROOT>/docs rendered as a review queue:
  //   { slug, label, blurb, headingLevels: [2], skipPattern: null }
  // Populate with your own documents.
];

function parseDocHeadings(slug, headingLevels = [2], skipPattern = null) {
  const docsRoot = path.resolve(__dirname, '..', 'docs');
  const mdPath = path.resolve(docsRoot, slug + '.md');
  if (!fs.existsSync(mdPath)) return null;
  const md = fs.readFileSync(mdPath, 'utf-8');
  // Strip frontmatter.
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = body.split('\n');
  const items = [];
  const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const seen = new Set();
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      if (current) { items.push(current); current = null; }
      const level = m[1].length;
      const text = m[2].replace(/\s+#$/, '').trim();
      if (!headingLevels.includes(level)) continue;
      if (skipPattern && skipPattern.test(text)) continue;
      let base = slugify(text); let id = base; let n = 1;
      while (seen.has(id)) { id = base + '-' + (++n); }
      seen.add(id);
      current = { id, text, excerpt: '' };
    } else if (current && !current.excerpt) {
      const t = line.trim();
      if (t && !t.startsWith('---') && !t.startsWith('|')) {
        // First non-empty non-rule line becomes the excerpt. Strip markdown
        // emphasis markers so the queue view reads as prose. Order matters:
        // bold/italic pairs first (so we don't decapitate the opening **),
        // then leading list/quote markers, then truncate.
        current.excerpt = t
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/^[>\-+]+\s*/, '')
          .slice(0, 220);
      }
    }
  }
  if (current) items.push(current);
  return items;
}

function renderSitWithPage() {
  const docs = SIT_WITH_DOCS.map(d => ({
    ...d,
    items: parseDocHeadings(d.slug, d.headingLevels, d.skipPattern) || [],
  })).filter(d => d.items.length);

  const verdicts = verdictsFor('reflection');
  const labels = VERDICT_LABELS;
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const verdictButtons = verdicts.map(v => {
    const lbl = labels[v] || v;
    return `<button type="button" data-verdict="${esc(v)}">${esc(lbl)}</button>`;
  }).join('');

  const sections = docs.map(d => {
    const rows = d.items.map(item => {
      const annotId = 'doc:' + d.slug + '__' + item.id;
      return `
<div class="qrow annot" data-annot-id="${esc(annotId)}" data-annot-kind="reflection">
  <div class="qhead">
    <a class="qtitle" href="/docs/${esc(d.slug)}#${esc(item.id)}">${esc(item.text)}</a>
    <span class="qmark"><span class="active-verdict"></span></span>
  </div>
  ${item.excerpt ? `<div class="qexcerpt">${esc(item.excerpt)}</div>` : ''}
  <div class="row qbtns">
    <span class="lbl">mark:</span>
    ${verdictButtons}
    <span class="saved">✓ saved</span>
    <a class="qopen" href="/docs/${esc(d.slug)}#${esc(item.id)}">open ↗</a>
  </div>
  <textarea data-note placeholder="note (saves on blur — only with a verdict)"></textarea>
  <div class="note-disp"></div>
</div>`;
    }).join('\n');
    return `
<section class="qsection" data-doc="${esc(d.slug)}">
  <h2>${esc(d.label)} <span class="qcount" data-doc-count="${esc(d.slug)}">(${d.items.length})</span></h2>
  <p class="qblurb">${esc(d.blurb)}</p>
  ${rows}
</section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sit-with queue</title>
<style>${PORTRAIT_CSS}
body { max-width: 900px; }
.progress { position: sticky; top: 0; z-index: 10; background: var(--bg); padding: 0.8rem 0; border-bottom: 1px solid var(--rule); margin-bottom: 1.5rem; font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.85rem; color: var(--muted); }
.progress strong { color: var(--fg); }
.progress .bar { display: inline-block; width: 200px; height: 6px; background: var(--quote-bg); border-radius: 3px; vertical-align: middle; margin: 0 0.5rem; overflow: hidden; }
.progress .bar .fill { display: block; height: 100%; background: var(--accent); width: 0%; transition: width 0.3s; }
.progress .filter { float: right; }
.progress .filter button { font-family: inherit; font-size: 0.75rem; margin-left: 0.3rem; padding: 0.15rem 0.55rem; border: 1px solid var(--rule); background: var(--bg); color: var(--muted); border-radius: 3px; cursor: pointer; }
.progress .filter button.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.qsection { margin-bottom: 2.4rem; }
.qsection h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); border-bottom: 1px solid var(--rule); padding-bottom: 0.3rem; font-weight: 600; }
.qsection .qblurb { font-style: italic; color: var(--muted); font-size: 0.9rem; margin: 0.4rem 0 1rem; }
.qcount { color: var(--muted); font-size: 0.75rem; }
.qrow { padding: 0.8rem 0.9rem; margin-bottom: 0.7rem; border: 1px solid var(--rule); border-radius: 5px; background: var(--bg); transition: border-color 0.15s, opacity 0.15s; }
.qrow.has-verdict { border-color: var(--accent); }
.qrow.hidden { display: none; }
.qhead { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; }
.qtitle { font-size: 1rem; color: var(--fg); text-decoration: none; font-weight: 500; line-height: 1.4; }
.qtitle:hover { color: var(--accent); }
.qmark { font-family: ui-monospace, monospace; font-size: 0.72rem; color: var(--accent); white-space: nowrap; }
.qexcerpt { color: var(--muted); font-size: 0.88rem; margin-top: 0.3rem; line-height: 1.5; }
.qbtns { margin-top: 0.6rem; font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.78rem; color: var(--muted); }
.qbtns .lbl { margin-right: 0.4rem; }
.qbtns button { font-family: inherit; font-size: 0.78rem; padding: 0.15rem 0.55rem; border: 1px solid var(--rule); background: var(--bg); color: var(--muted); border-radius: 3px; cursor: pointer; }
.qbtns button:hover { color: var(--fg); border-color: var(--accent); }
.qbtns button.active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.qbtns .qopen { margin-left: auto; color: var(--accent); text-decoration: none; font-size: 0.74rem; }
.qbtns .qopen:hover { text-decoration: underline; }
.qbtns .saved { color: var(--accent); opacity: 0; transition: opacity 0.2s; margin-left: 0.4rem; font-size: 0.74rem; }
.qbtns .saved.show { opacity: 1; }
.qrow textarea { width: 100%; min-height: 2.4rem; margin-top: 0.5rem; padding: 0.4rem 0.55rem; font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.82rem; background: var(--quote-bg); color: var(--fg); border: 1px solid var(--rule); border-radius: 3px; resize: vertical; box-sizing: border-box; }
.qrow textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
.note-disp { margin-top: 0.4rem; padding: 0.4rem 0.55rem; border-left: 2px solid var(--accent); background: var(--quote-bg); color: var(--fg); font-family: 'Iowan Old Style', Georgia, serif; font-size: 0.92rem; font-style: italic; white-space: pre-wrap; display: none; }
.note-disp.show { display: block; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a> · <span style="color:var(--muted)">sit-with queue</span></nav>
<h1>sit-with queue</h1>
<p class="essence">P6 of the action-loop plan. The output exists; the work now is reading it back, slowly, and noticing which hypotheses loosened anything. Mark each section as you sit with it.</p>

<div class="progress">
  <strong><span id="prog-done">0</span> / <span id="prog-total">0</span></strong> marked
  <span class="bar"><span id="prog-fill" class="fill"></span></span>
  <span id="prog-summary"></span>
  <span class="filter">
    show:
    <button data-filter="all" class="active">all</button>
    <button data-filter="unmarked">unmarked</button>
    <button data-filter="marked">marked</button>
  </span>
</div>

${sections}

<script>
(function(){
  const VERDICTS = ${JSON.stringify(verdicts)};
  const LABELS = ${JSON.stringify(labels)};
  const escHtml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function applyState(block, record) {
    const verdict = record && record.verdict;
    block.classList.toggle('has-verdict', !!verdict);
    block.querySelectorAll('button[data-verdict]').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-verdict') === verdict);
    });
    const mark = block.querySelector('.qmark .active-verdict');
    if (mark) {
      const lbl = verdict ? (LABELS[verdict] || verdict) : '';
      mark.textContent = lbl ? '· ' + lbl : '';
    }
    const ta = block.querySelector('textarea[data-note]');
    if (ta && record && typeof record.note === 'string' && document.activeElement !== ta) {
      ta.value = record.note;
    }
    const disp = block.querySelector('.note-disp');
    if (disp) {
      const note = record && record.note;
      if (note && note.trim()) { disp.textContent = note; disp.classList.add('show'); }
      else { disp.classList.remove('show'); }
    }
    updateProgress();
    applyFilter(currentFilter);
  }
  function flashSaved(block) {
    const s = block.querySelector('.saved');
    if (!s) return;
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1200);
  }
  async function postAnnot(payload) {
    const res = await fetch('/api/annotation', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error('http ' + res.status);
    return res.json();
  }

  const blocks = Array.from(document.querySelectorAll('.qrow.annot'));
  blocks.forEach(block => {
    const id = block.getAttribute('data-annot-id');
    const kind = block.getAttribute('data-annot-kind');
    block.querySelectorAll('button[data-verdict]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const verdict = btn.getAttribute('data-verdict');
        const ta = block.querySelector('textarea[data-note]');
        const note = ta ? ta.value : '';
        try {
          const r = await postAnnot({ id, kind, verdict, note });
          if (r && r.ok) { applyState(block, r.record); flashSaved(block); }
        } catch (e) { console.error('save fail', e); }
      });
    });
    const ta = block.querySelector('textarea[data-note]');
    if (ta) {
      ta.addEventListener('blur', async () => {
        const active = block.querySelector('button[data-verdict].active');
        if (!active) return;
        const verdict = active.getAttribute('data-verdict');
        try {
          const r = await postAnnot({ id, kind, verdict, note: ta.value });
          if (r && r.ok) { applyState(block, r.record); flashSaved(block); }
        } catch (e) { console.error('save fail', e); }
      });
    }
  });

  // Filter buttons.
  let currentFilter = 'all';
  function applyFilter(f) {
    currentFilter = f;
    blocks.forEach(b => {
      const has = b.classList.contains('has-verdict');
      b.classList.toggle('hidden', f === 'unmarked' ? has : f === 'marked' ? !has : false);
    });
    document.querySelectorAll('.filter button').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-filter') === f);
    });
  }
  document.querySelectorAll('.filter button').forEach(btn => {
    btn.addEventListener('click', () => applyFilter(btn.getAttribute('data-filter')));
  });

  function updateProgress() {
    const total = blocks.length;
    const done = blocks.filter(b => b.classList.contains('has-verdict')).length;
    document.getElementById('prog-done').textContent = done;
    document.getElementById('prog-total').textContent = total;
    const pct = total ? (100 * done / total) : 0;
    document.getElementById('prog-fill').style.width = pct.toFixed(1) + '%';
    // Per-verdict tally.
    const tally = {};
    VERDICTS.forEach(v => tally[v] = 0);
    blocks.forEach(b => {
      const active = b.querySelector('button[data-verdict].active');
      if (active) tally[active.getAttribute('data-verdict')]++;
    });
    const parts = VERDICTS.map(v => tally[v] ? (LABELS[v] || v) + ' ' + tally[v] : null).filter(Boolean);
    document.getElementById('prog-summary').textContent = parts.length ? '· ' + parts.join(' · ') : '';
  }

  fetch('/api/annotations.json').then(r => r.json()).then(all => {
    blocks.forEach(b => {
      const id = b.getAttribute('data-annot-id');
      if (all && all[id]) applyState(b, all[id]);
    });
    updateProgress();
  }).catch(e => { console.error('preload fail', e); updateProgress(); });
})();
</script>
</body></html>`;
}

// ---- /writing — index of inputs/writing/ (the 14-year Google Docs archive) ----
//
// Lists every .md file in inputs/writing/ sorted by best-available date.
// File names usually carry a date (e.g. "ACCC Exit Interview Notes (Jun 2019).md")
// or fall back to mtime. Each row shows size and a one-line excerpt (the first
// non-empty line of the file). Links into /writing/<basename> which renders
// through the same shell as /docs/*, with the inline reflection editor.
// ---- /merge — identity-merge UI ----
const MERGE_PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>merge identities</title>
<style>
:root {
  --bg: #fafaf7; --fg: #1c1c1c; --muted: #6a6a6a; --rule: #e0ddd5;
  --quote-bg: #f1ede4; --quote-rule: #c8c0a8; --accent: #5a5044;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14130f; --fg: #e8e6e0; --muted: #a09b8e; --rule: #2a2825;
    --quote-bg: #1d1b16; --quote-rule: #4a4538; --accent: #c8bea8;
  }
}
* { box-sizing: border-box; }
body { font-family: ui-monospace, 'SF Mono', monospace; max-width: 1100px; margin: 0 auto; padding: 1.5rem 2rem 4rem; background: var(--bg); color: var(--fg); font-size: 13px; line-height: 1.6; }
h1 { font-size: 1.3rem; margin: 0 0 0.2rem; letter-spacing: -0.01em; font-family: 'Iowan Old Style', Georgia, serif; }
p.essence { color: var(--muted); margin: 0 0 1.5rem; font-size: 0.88rem; }
nav.crumbs { font-size: 0.82rem; margin-bottom: 1.5rem; color: var(--muted); }
nav.crumbs a { color: var(--accent); text-decoration: none; }
nav.crumbs a:hover { text-decoration: underline; }
h2.section-head { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); border-bottom: 1px solid var(--rule); padding-bottom: 0.3rem; margin: 2rem 0 0.8rem; font-weight: 600; }
.layout { display: grid; grid-template-columns: 1fr 320px; gap: 2rem; align-items: start; }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; } }

/* Candidate cards */
#candidates { display: flex; flex-direction: column; gap: 0.9rem; }
.card { border: 1px solid var(--rule); border-radius: 5px; padding: 0.8rem 1rem; background: var(--bg); }
.card .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; margin-bottom: 0.6rem; }
.card .side { padding: 0.6rem 0.7rem; background: var(--quote-bg); border-radius: 4px; }
.card .side .name { font-weight: 700; font-size: 1rem; color: var(--fg); font-family: 'Iowan Old Style', Georgia, serif; }
.card .side .meta { font-size: 0.75rem; color: var(--muted); margin-top: 0.2rem; }
.card .side .aliases { font-size: 0.75rem; color: var(--muted); margin-top: 0.15rem; word-break: break-all; }
.card .score-row { font-size: 0.72rem; color: var(--muted); margin-bottom: 0.5rem; }
.card .score-row .score-val { color: var(--accent); font-weight: 700; }
.card .btns { display: flex; gap: 0.4rem; flex-wrap: wrap; }
.card .btns button { font-family: inherit; font-size: 0.78rem; padding: 0.25rem 0.7rem; border: 1px solid var(--rule); background: var(--bg); color: var(--fg); border-radius: 3px; cursor: pointer; }
.card .btns button:hover { border-color: var(--accent); color: var(--accent); }
.card .btns .btn-merge-l { border-color: #6e8e6a; }
.card .btns .btn-merge-l:hover { background: #6e8e6a; color: white; border-color: #6e8e6a; }
.card .btns .btn-merge-r { border-color: #5a5044; }
.card .btns .btn-merge-r:hover { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.card .btns .btn-dismiss { color: var(--muted); }
.card .btns .btn-dismiss:hover { color: var(--fg); }
#candidates-empty { color: var(--muted); font-size: 0.88rem; padding: 1rem 0; }

/* Sidebar: search + pending + apply */
.sidebar { display: flex; flex-direction: column; gap: 1.5rem; }
.search-box { display: flex; gap: 0.4rem; }
.search-box input { flex: 1; font-family: inherit; font-size: 0.82rem; padding: 0.3rem 0.6rem; background: var(--quote-bg); border: 1px solid var(--rule); color: var(--fg); border-radius: 3px; }
.search-box input:focus { outline: none; border-color: var(--accent); }
.search-box button { font-family: inherit; font-size: 0.78rem; padding: 0.3rem 0.7rem; border: 1px solid var(--rule); background: var(--bg); color: var(--fg); border-radius: 3px; cursor: pointer; }
.search-box button:hover { border-color: var(--accent); color: var(--accent); }
#search-results { display: flex; flex-direction: column; gap: 0.3rem; margin-top: 0.5rem; }
.sr-row { padding: 0.4rem 0.6rem; border: 1px solid var(--rule); border-radius: 3px; cursor: pointer; font-size: 0.8rem; }
.sr-row:hover { border-color: var(--accent); }
.sr-row.is-winner { border-color: #6e8e6a; background: rgba(110,142,106,0.08); }
.sr-row.is-loser  { border-color: #c97a4a; background: rgba(201,122,74,0.08); }
.sr-row .sr-name { font-weight: 600; color: var(--fg); }
.sr-row .sr-meta { font-size: 0.72rem; color: var(--muted); }
.stage-hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.3rem; min-height: 1rem; }
#stage-merge-btn { display: none; font-family: inherit; font-size: 0.78rem; padding: 0.3rem 0.8rem; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); border-radius: 3px; cursor: pointer; margin-top: 0.5rem; }
#stage-merge-btn:hover { opacity: 0.85; }

/* Pending panel */
#pending-list { display: flex; flex-direction: column; gap: 0.3rem; }
.pending-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.4rem; padding: 0.4rem 0.6rem; border: 1px solid var(--rule); border-radius: 3px; font-size: 0.8rem; }
.pending-row .pr-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pending-row .pr-reason { font-size: 0.72rem; color: var(--muted); display: block; }
.pending-row .pr-remove { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 1rem; padding: 0 0.2rem; flex-shrink: 0; }
.pending-row .pr-remove:hover { color: #c53030; }
#pending-empty { font-size: 0.82rem; color: var(--muted); padding: 0.3rem 0; }

/* Apply button + status */
.apply-row { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
#apply-btn { font-family: inherit; font-size: 0.82rem; padding: 0.4rem 1rem; border: 1px solid var(--accent); background: var(--accent); color: var(--bg); border-radius: 3px; cursor: pointer; font-weight: 600; }
#apply-btn:hover:not(:disabled) { opacity: 0.85; }
#apply-btn:disabled { opacity: 0.5; cursor: default; }
#status { font-size: 0.8rem; color: var(--muted); }
#status.err { color: #c53030; }
#status.ok  { color: #6e8e6a; }
</style>
</head><body>
<nav class="crumbs"><a href="/">← root</a> · <span style="color:var(--muted)">merge identities</span></nav>
<h1>merge identities</h1>
<p class="essence">Review duplicate candidates from the graph, stage merges, and apply them to the database.</p>

<div class="layout">
  <div>
    <h2 class="section-head">duplicate candidates <span id="cands-count" style="font-weight:400"></span></h2>
    <div id="candidates"><div id="candidates-empty" style="color:var(--muted)">loading…</div></div>
  </div>

  <div class="sidebar">
    <div>
      <h2 class="section-head">manual search</h2>
      <div class="search-box">
        <input id="search-input" type="text" placeholder="name or alias…">
        <button id="search-btn">search</button>
      </div>
      <div id="search-results"></div>
      <div class="stage-hint" id="stage-hint"></div>
      <button id="stage-merge-btn">stage merge</button>
    </div>

    <div>
      <h2 class="section-head">pending merges</h2>
      <div id="pending-list"><div id="pending-empty">none staged</div></div>
    </div>

    <div>
      <h2 class="section-head">apply</h2>
      <div class="apply-row">
        <button id="apply-btn">apply merges</button>
        <span id="status"></span>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  // Escape user/data text for HTML insertion.
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Pick the most-distinguishing alias for an identity.
  function pickAlias(identity) {
    const aliases = identity.aliases || [];
    const email = aliases.find(a => a.includes('@'));
    if (email) return email;
    const phone = aliases.find(a => /^\\+?\\d[\\d ()\\-]{6,}$/.test(a));
    if (phone) return phone;
    return aliases[0] || null;
  }

  function sigOf(identity) {
    return { name: identity.name || identity.display_name, alias: pickAlias(identity) };
  }

  // ---- Pending panel ----
  async function loadPending() {
    try {
      const data = await fetch('/api/merges').then(r => r.json());
      renderPending(data.merges || []);
    } catch (e) {
      console.error('loadPending fail', e);
    }
  }

  function renderPending(merges) {
    const list = document.getElementById('pending-list');
    if (!merges.length) {
      list.innerHTML = '<div id="pending-empty">none staged</div>';
      return;
    }
    list.innerHTML = merges.map((m, i) => {
      const wName = esc((m.winner && m.winner.name) || '?');
      const lName = esc((m.loser  && m.loser.name)  || '?');
      const reason = esc(m.reason || '');
      return '<div class="pending-row" data-idx="' + i + '">'
        + '<span class="pr-text">' + wName + ' ← ' + lName
        + (reason ? '<span class="pr-reason">' + reason + '</span>' : '')
        + '</span>'
        + '<button class="pr-remove" title="remove" data-idx="' + i + '">×</button>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.pr-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = +btn.getAttribute('data-idx');
        const data = await fetch('/api/merges').then(r => r.json());
        const merge = (data.merges || [])[idx];
        if (!merge) return;
        await fetch('/api/merges', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', merge }),
        });
        await loadPending();
      });
    });
  }

  // Post a merge and refresh pending panel + remove the card if one is given.
  async function postMerge(winner, loser, reason, cardEl) {
    const merge = { winner: sigOf(winner), loser: sigOf(loser), reason: reason || '' };
    try {
      const res = await fetch('/api/merges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', merge }),
      });
      if (!res.ok) throw new Error('http ' + res.status);
      await loadPending();
      if (cardEl) cardEl.remove();
    } catch (err) {
      console.error('postMerge failed:', err);
      const status = document.getElementById('status');
      status.className = 'err';
      status.textContent = 'merge failed: ' + err.message;
    }
  }

  // ---- Candidate cards ----
  function renderCandidates(cands) {
    const container = document.getElementById('candidates');
    const countEl = document.getElementById('cands-count');
    countEl.textContent = '(' + cands.length + ')';
    if (!cands.length) {
      container.innerHTML = '<div id="candidates-empty">no candidates found</div>';
      return;
    }
    container.innerHTML = '';
    for (const c of cands) {
      const a = c.a, b = c.b;
      const score = (c.score != null ? c.score.toFixed(2) : '?');
      const reasons = Array.isArray(c.reasons) ? c.reasons : [];
      const aliasSnip = (id) => {
        const al = (id.aliases || []).slice(0, 3);
        return al.length ? al.map(esc).join(', ') : '<em style="color:var(--muted)">none</em>';
      };
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<div class="score-row">score <span class="score-val">' + esc(score) + '</span>'
        + (reasons.length ? ' · ' + reasons.map(esc).join(', ') : '')
        + '</div>'
        + '<div class="pair">'
        + '<div class="side">'
        + '<div class="name">' + esc(a.name) + '</div>'
        + '<div class="meta">' + esc((a.msgs||0).toLocaleString()) + ' msgs · ' + (a.sources||[]).map(esc).join(', ') + '</div>'
        + '<div class="aliases">aliases: ' + aliasSnip(a) + '</div>'
        + '</div>'
        + '<div class="side">'
        + '<div class="name">' + esc(b.name) + '</div>'
        + '<div class="meta">' + esc((b.msgs||0).toLocaleString()) + ' msgs · ' + (b.sources||[]).map(esc).join(', ') + '</div>'
        + '<div class="aliases">aliases: ' + aliasSnip(b) + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="btns">'
        + '<button class="btn-merge-l">merge ← keep left</button>'
        + '<button class="btn-merge-r">merge → keep right</button>'
        + '<button class="btn-dismiss">not a dup</button>'
        + '</div>';

      const reason = reasons.join(', ');
      card.querySelector('.btn-merge-l').addEventListener('click', () => postMerge(a, b, reason, card));
      card.querySelector('.btn-merge-r').addEventListener('click', () => postMerge(b, a, reason, card));
      card.querySelector('.btn-dismiss').addEventListener('click', () => card.remove());

      container.appendChild(card);
    }
  }

  // ---- Manual search ----
  let searchWinner = null, searchLoser = null;

  function renderSearchResults(results) {
    const container = document.getElementById('search-results');
    const hint = document.getElementById('stage-hint');
    const stageBtn = document.getElementById('stage-merge-btn');
    if (!results.length) {
      container.innerHTML = '<div style="font-size:0.8rem;color:var(--muted);padding:0.3rem 0">no results</div>';
      return;
    }
    container.innerHTML = results.map((r, i) => {
      const name = esc(r.display_name || r.name || r.canonical_id);
      const meta = esc((r.msgs||0).toLocaleString()) + ' msgs · ' + (r.sources||[]).map(esc).join(', ');
      return '<div class="sr-row" data-idx="' + i + '">'
        + '<div class="sr-name">' + name + '</div>'
        + '<div class="sr-meta">' + meta + '</div>'
        + '</div>';
    }).join('');

    container.querySelectorAll('.sr-row').forEach((row, i) => {
      row.addEventListener('click', () => {
        const r = results[i];
        // First click = winner; second click (different) = loser.
        if (!searchWinner || (searchLoser && searchWinner && r.canonical_id === searchWinner.canonical_id)) {
          searchWinner = r; searchLoser = null;
        } else if (searchWinner && r.canonical_id !== searchWinner.canonical_id) {
          searchLoser = r;
        } else {
          searchWinner = r; searchLoser = null;
        }
        // Reflect state in UI.
        container.querySelectorAll('.sr-row').forEach((rr, ii) => {
          rr.classList.toggle('is-winner', searchWinner && results[ii].canonical_id === searchWinner.canonical_id);
          rr.classList.toggle('is-loser',  searchLoser  && results[ii].canonical_id === searchLoser.canonical_id);
        });
        if (searchWinner && !searchLoser) {
          hint.textContent = 'winner set: ' + (searchWinner.display_name || searchWinner.name) + ' — click another to set loser';
          stageBtn.style.display = 'none';
        } else if (searchWinner && searchLoser) {
          hint.textContent = 'winner: ' + (searchWinner.display_name || searchWinner.name)
            + ' ← loser: ' + (searchLoser.display_name || searchLoser.name);
          stageBtn.style.display = '';
        }
      });
    });
  }

  document.getElementById('search-btn').addEventListener('click', async () => {
    const q = document.getElementById('search-input').value.trim();
    if (!q) return;
    searchWinner = null; searchLoser = null;
    document.getElementById('stage-hint').textContent = '';
    document.getElementById('stage-merge-btn').style.display = 'none';
    try {
      const results = await fetch('/api/identity-search?q=' + encodeURIComponent(q)).then(r => r.json());
      renderSearchResults(results);
    } catch (e) {
      document.getElementById('search-results').innerHTML = '<div style="color:#c53030;font-size:0.8rem">error: ' + esc(e.message) + '</div>';
    }
  });

  document.getElementById('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('search-btn').click();
  });

  document.getElementById('stage-merge-btn').addEventListener('click', async () => {
    if (!searchWinner || !searchLoser) return;
    await postMerge(searchWinner, searchLoser, 'manual', null);
    document.getElementById('stage-hint').textContent = 'staged!';
    document.getElementById('stage-merge-btn').style.display = 'none';
    searchWinner = null; searchLoser = null;
    document.getElementById('search-results').querySelectorAll('.sr-row').forEach(r => {
      r.classList.remove('is-winner', 'is-loser');
    });
  });

  // ---- Apply button ----
  document.getElementById('apply-btn').addEventListener('click', async () => {
    const btn = document.getElementById('apply-btn');
    const status = document.getElementById('status');
    btn.disabled = true;
    status.className = '';
    status.textContent = 'Applying… (~2–3 min, do not close)';
    try {
      const r = await fetch('/api/merges/apply', { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        status.className = 'ok';
        status.textContent = (body.applyLog && body.applyLog.length) ? body.applyLog.join(' · ') : 'done';
      } else {
        status.className = 'err';
        status.textContent = 'error ' + r.status + ': ' + (body.error || body.message || 'unknown');
      }
    } catch (e) {
      status.className = 'err';
      status.textContent = 'error: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---- Init ----
  (async function init() {
    // Load candidates.
    try {
      const cands = await fetch('/api/dup-candidates').then(r => r.json());
      renderCandidates(Array.isArray(cands) ? cands : []);
    } catch (e) {
      document.getElementById('candidates').innerHTML =
        '<div style="color:#c53030;font-size:0.88rem">failed to load candidates: ' + esc(e.message) + '</div>';
    }
    // Load pending merges.
    await loadPending();
  })();
})();
</script>
</body></html>`;

function renderWritingIndex() {
  const writingRoot = path.resolve(__dirname, '..', 'inputs', 'writing');
  if (!fs.existsSync(writingRoot)) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>writing</title><style>${PORTRAIT_CSS}</style></head><body><nav class="crumbs"><a href="/">← root</a></nav><h1>writing archive not found</h1><p>Expected at <code>inputs/writing/</code> — drop your Google Docs export there.</p></body></html>`;
  }
  const files = fs.readdirSync(writingRoot).filter(f => f.endsWith('.md')).map(name => {
    const full = path.join(writingRoot, name);
    let st;
    let content;
    try {
      st = fs.statSync(full);
      content = fs.readFileSync(full, 'utf-8');
    } catch (err) {
      console.error('[writing] skipping ' + full + ': ' + err.message);
      return null;
    }
    const lines = content.split('\n').map(s => s.trim()).filter(Boolean);
    let excerpt = lines[0] || '';
    // Strip markdown emphasis from excerpt.
    excerpt = excerpt
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^[#>\-+]+\s*/, '')
      .slice(0, 220);
    // Try to extract a date from the filename: "(Mon YYYY)" / "(YYYY)" / fall back to mtime.
    const fnYearMonth = name.match(/\((\w{3,9})\s+(\d{4})\)/);
    const fnYear = name.match(/\((\d{4})\)/);
    let dateLabel = '';
    let sortKey = st.mtimeMs;
    if (fnYearMonth) {
      const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
      const m = months[fnYearMonth[1].slice(0, 3).toLowerCase()];
      const y = parseInt(fnYearMonth[2], 10);
      if (m !== undefined && y) { sortKey = Date.UTC(y, m, 1); dateLabel = `${fnYearMonth[1].slice(0, 3)} ${y}`; }
    } else if (fnYear) {
      const y = parseInt(fnYear[1], 10);
      if (y) { sortKey = Date.UTC(y, 0, 1); dateLabel = String(y); }
    } else {
      const d = new Date(st.mtimeMs);
      dateLabel = d.toISOString().slice(0, 7);
    }
    return { name, base: name.replace(/\.md$/, ''), size: st.size, excerpt, dateLabel, sortKey };
  }).filter(Boolean);
  // Newest first.
  files.sort((a, b) => b.sortKey - a.sortKey);
  const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtBytes = (n) => n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n/1024).toFixed(1)}K` : `${(n/(1024*1024)).toFixed(1)}M`;
  const rows = files.map(f => `
<li class="wrow">
  <a class="wtitle" href="/writing/${esc(encodeURIComponent(f.base))}">${esc(f.base)}</a>
  <span class="wmeta">${esc(f.dateLabel)} · ${fmtBytes(f.size)}</span>
  ${f.excerpt ? `<div class="wexcerpt">${esc(f.excerpt)}</div>` : ''}
</li>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>writing archive</title>
<style>${PORTRAIT_CSS}
body { max-width: 880px; }
ul.warchive { list-style: none; padding: 0; }
.wrow { padding: 0.7rem 0.2rem; border-bottom: 1px solid var(--rule); }
.wtitle { font-size: 1.05rem; text-decoration: none; color: var(--fg); font-weight: 500; }
.wtitle:hover { color: var(--accent); }
.wmeta { float: right; font-family: ui-monospace, monospace; font-size: 0.72rem; color: var(--muted); margin-top: 0.25rem; }
.wexcerpt { color: var(--muted); font-size: 0.88rem; margin-top: 0.3rem; line-height: 1.5; clear: right; }
.warchive-meta { font-family: ui-monospace, 'SF Mono', monospace; font-size: 0.85rem; color: var(--muted); margin: 0.6rem 0 1.6rem; }
</style></head><body>
<nav class="crumbs"><a href="/">← root</a> · <span style="color:var(--muted)">writing archive</span> · <a href="/docs/writing-sweep-2026-05-10">sweep against knots →</a></nav>
<h1>writing archive</h1>
<p class="essence">14 years of solo writing — Google Docs export. Each file gets the inline reflection editor when opened. Sorted newest-first by best-available date.</p>
<div class="warchive-meta">${files.length} files · ${fmtBytes(files.reduce((s, f) => s + f.size, 0))} total</div>
<ul class="warchive">${rows}</ul>
</body></html>`;
}

const server = http.createServer((req, res) => {
  let urlPath, urlSearch;
  try {
    const u = new URL(req.url, 'http://x');
    urlPath = decodeURIComponent(u.pathname);
    urlSearch = u.searchParams;
  } catch {
    res.writeHead(400); res.end('bad url'); return;
  }

  // While a merge-apply is running the DB is closed (lock released for the child
  // writers), so any DB-backed /api/* route would fail. Short-circuit with 503.
  if (applying && urlPath.startsWith('/api/') && urlPath !== '/api/merges/apply') {
    res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"applying, retry shortly"}'); return;
  }

  // Root landing page
  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderRootIndex());
    return;
  }

  // Timeline + check-in routes
  if (urlPath === '/timeline' || urlPath === '/timeline/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderTimelinePage());
    return;
  }
  if (urlPath === '/checkins' || urlPath === '/checkins/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderCheckinsPage());
    return;
  }
  if (urlPath === '/storyline' || urlPath === '/storyline/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderStoryline());
    return;
  }
  if (urlPath === '/groups' || urlPath === '/groups/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderGroupsPage());
    return;
  }
  if (urlPath === '/graph' || urlPath === '/graph/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderGraphPage());
    return;
  }
  // Identity merge UI
  if (urlPath === '/merge' || urlPath === '/merge/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(MERGE_PAGE_HTML);
    return;
  }

  // Trajectories — index + per-person page
  if (urlPath === '/trajectory' || urlPath === '/trajectory/' || urlPath === '/trajectories' || urlPath === '/trajectories/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderTrajectoryIndex());
    return;
  }
  if (urlPath.startsWith('/trajectory/')) {
    const slug = urlPath.slice('/trajectory/'.length).replace(/\/$/, '');
    if (slug && !slug.includes('/')) {
      const { code, body } = renderTrajectoryPage(slug);
      res.writeHead(code, { 'Content-Type': MIME['.html'] });
      res.end(body);
      return;
    }
  }
  // /api/trajectory/<canonical_id>.json — CORS-open JSON for external tools
  if (urlPath.startsWith('/api/trajectory/')) {
    const rest = urlPath.slice('/api/trajectory/'.length);
    const cid = rest.endsWith('.json') ? rest.slice(0, -5) : rest;
    if (cid && !cid.includes('/') && /^[A-Za-z0-9_\-]+$/.test(cid)) {
      const file = path.join(ROOT, 'self', 'trajectories', cid + '.json');
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(file).pipe(res);
        return;
      }
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'not_found', canonical_id: cid })); return;
    }
  }
  if (urlPath === '/api/trajectories.json' || urlPath === '/api/trajectories/index.json') {
    const file = path.join(ROOT, 'self', 'trajectories', 'index.json');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  if (urlPath === '/api/edge') {
    const aId = urlSearch.get('a');
    const bId = urlSearch.get('b');
    if (!aId || !bId) {
      res.writeHead(400); res.end('missing a or b');
      return;
    }
    fetchEdgeDetails(aId, bId).then(payload => {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(payload, null, 2));
    }).catch(err => {
      console.error('[api/edge] error:', err.message);
      res.writeHead(500); viewError(res, 'api', err, false);
    });
    return;
  }
  // API: /api/co-photos — the actual photos two people appear in together (NON-CORS; photos are sensitive).
  if (urlPath === '/api/co-photos') {
    const aId = urlSearch.get('a'), bId = urlSearch.get('b');
    if (!aId || !bId) { res.writeHead(400); res.end('missing a or b'); return; }
    fetchCoPhotos(aId, bId).then(payload => {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(payload));
    }).catch(err => { console.error('[api/co-photos]', err.message); res.writeHead(500); viewError(res, 'api', err, false); });
    return;
  }
  // /groups/<slug> — per-group detail page (slug derived from thread_id by replacing punctuation)
  if (urlPath.startsWith('/groups/')) {
    const slug = urlPath.slice('/groups/'.length);
    if (slug && !slug.includes('/')) {
      const detail = renderGroupDetail(slug);
      res.writeHead(detail.status, { 'Content-Type': MIME['.html'] });
      res.end(detail.html);
      return;
    }
  }
  // Annotation feedback API (knot/strength verdicts).
  if (urlPath === '/api/annotation') {
    handleAnnotationPost(req, res).catch(err => {
      console.error('[api/annotation] error:', err.message);
      try { res.writeHead(500, { 'Content-Type': MIME['.json'] }); viewError(res, 'api', err, false); } catch {}
    });
    return;
  }
  if (urlPath === '/api/annotations.json') {
    const all = readAnnotations();
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(all, null, 2));
    return;
  }

  // JSON / NDJSON exports
  if (urlPath === '/api/self_bundle.json' || urlPath === '/api/self-bundle.json') {
    const file = path.join(ROOT, 'self_bundle.json');
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404); res.end('not built yet — run pipeline/build-self-bundle.js'); return;
  }
  if (urlPath === '/self' || urlPath === '/self/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderSelfPage());
    return;
  }
  // /self/diff — yesterday→today layer-2 delta
  if (urlPath === '/self/diff' || urlPath === '/self/diff/') {
    const diffMdPath = path.join(ROOT, 'self', 'runs', 'latest', 'diff.md');
    if (fs.existsSync(diffMdPath)) {
      const md = fs.readFileSync(diffMdPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(renderPortraitHtml('layer-2 diff', md, path.join(ROOT, 'portraits')));
      return;
    }
    res.writeHead(404, { 'Content-Type': MIME['.html'] });
    res.end("<!DOCTYPE html><body style=\"font-family:monospace; padding:2rem\"><a href=\"/self\">← /self</a><h1>no diff yet</h1><p>The diff is generated nightly by <code>pipeline/self/knot-diff.js</code>. It needs at least two run-day snapshots to compare. Try again after tomorrow's 12:00 CT layer-1 fire.</p></body>"); return;
  }
  if (urlPath === '/sit-with' || urlPath === '/sit-with/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderSitWithPage());
    return;
  }
  // /writing — index of inputs/writing/*.md (the Google Docs export, your 14-year archive)
  if (urlPath === '/writing' || urlPath === '/writing/') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(renderWritingIndex());
    return;
  }
  if (urlPath.startsWith('/writing/')) {
    const rest = decodeURIComponent(urlPath.slice('/writing/'.length));
    const wantsRaw = urlSearch.get('raw') === '1';
    if (rest && !rest.includes('..')) {
      const writingRoot = path.resolve(__dirname, '..', 'inputs', 'writing');
      // Accept /writing/<basename> or /writing/<basename>.md
      const baseName = rest.endsWith('.md') ? rest : rest + '.md';
      const mdPath = path.resolve(writingRoot, baseName);
      if (mdPath.startsWith(writingRoot + path.sep) && fs.existsSync(mdPath) && fs.statSync(mdPath).isFile()) {
        const md = fs.readFileSync(mdPath, 'utf-8');
        if (wantsRaw) {
          res.writeHead(200, { 'Content-Type': MIME['.md'] });
          res.end(md);
          return;
        }
        const display = baseName.replace(/\.md$/, '');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        // Reflection editor enabled — same as /docs/*.
        res.end(renderPortraitHtml(display, md, path.join(ROOT, 'portraits'), { reflectionDocId: 'writing:' + baseName.replace(/\.md$/, '') }));
        return;
      }
    }
  }
  if (urlPath === '/api/timeline.json' || urlPath === '/api/checkins.json' || urlPath === '/api/storyline.json' || urlPath === '/api/groups.json' || urlPath === '/api/cohorts.json' || urlPath === '/api/graph.json') {
    const file = path.join(ROOT, urlPath.replace('/api/', ''));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  if (urlPath === '/api/timeline.ndjson' || urlPath === '/api/checkins.ndjson') {
    const jsonName = urlPath.replace('/api/', '').replace('.ndjson', '.json');
    const file = path.join(ROOT, jsonName);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const arr = data.entries || data.people || [];
      const lines = arr.map(o => JSON.stringify(o)).join('\n');
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(lines);
      return;
    }
  }

  // API: /api/email.json — bulk/automated email interests summary.
  // Deliberately NON-CORS (no Access-Control-Allow-Origin): email senders/content
  // are sensitive, so only this same-origin UI may read it.
  if (urlPath === '/api/email.json') {
    const p = path.join(ROOT, 'email-summary.json');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(p, 'utf-8'));
    } else {
      res.writeHead(404, { 'Content-Type': MIME['.json'] });
      res.end('{"error":"no email summary yet — run build-email-summary"}');
    }
    return;
  }

  // Page: /email — human-readable email-interests surface (also non-CORS).
  if (urlPath === '/email' || urlPath === '/email/') {
    const p = path.join(ROOT, 'email-summary.json');
    if (!fs.existsSync(p)) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      res.end('<p>No email summary yet. Run <code>npm run build-email-summary</code>.</p>');
      return;
    }
    const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cats = Object.entries(s.by_category || {}).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<li>${esc(k)}: <b>${v}</b></li>`).join('');
    const domains = (s.top_domains || []).map(d => `<li>${esc(d.domain)} — ${d.n_messages}</li>`).join('');
    const rows = (s.top_correspondents || []).map(c =>
      `<tr><td>${esc(c.display_name || c.addr)}</td><td>${esc(c.addr)}</td><td>${esc(c.kind)}</td><td style="text-align:right">${c.n_messages}</td></tr>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>Email interests</title>
<style>body{font:14px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:4px 8px}</style>
<h1>Email interests</h1>
<p>${s.total_correspondents} bulk/automated senders · ${s.total_bulk_messages} messages · generated ${esc(s.generated)}</p>
<h2>By category</h2><ul>${cats}</ul>
<h2>Top domains</h2><ul>${domains}</ul>
<h2>Top correspondents</h2><table><tr><th>Name</th><th>Address</th><th>Kind</th><th>Msgs</th></tr>${rows}</table>`;
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
    return;
  }

  // API: /api/dup-candidates — returns top 200 duplicate identity candidates (NON-CORS).
  if (urlPath === '/api/dup-candidates') {
    getDb().then(conn => loadFindDups().then(fn => fn(conn))).then(cands => {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(cands.slice(0, 200)));
    }).catch(err => {
      console.error('[api/dup-candidates] error:', err.message);
      res.writeHead(500); viewError(res, 'api', err, false);
    });
    return;
  }

  // API: /api/identity-search?q=<query> — search identities by display_name or alias (NON-CORS).
  if (urlPath === '/api/identity-search') {
    const q = (urlSearch.get('q') || '').trim();
    if (!q) { res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end('[]'); return; }
    const lit = "'" + q.replace(/'/g, "''") + "'";
    getDb().then(conn => conn.runAndReadAll(`
      SELECT i.canonical_id, i.display_name, i.aliases, i.sources, COALESCE(COUNT(m.id),0) AS msgs
      FROM identities i LEFT JOIN thread_identity ti ON ti.canonical_id=i.canonical_id
      LEFT JOIN messages m ON m.thread_id=ti.thread_id
      WHERE i.display_name ILIKE '%' || ${lit} || '%' OR list_contains(i.aliases, ${lit})
      GROUP BY 1,2,3,4 ORDER BY msgs DESC LIMIT 30`)).then(reader => {
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(reader.getRowObjectsJson()));
    }).catch(err => {
      console.error('[api/identity-search] error:', err.message);
      res.writeHead(500); viewError(res, 'api', err, false);
    });
    return;
  }

  // API: /api/merges GET/POST — read and write identity merge decisions (NON-CORS).
  if (urlPath === '/api/merges' && req.method === 'GET') {
    const data = readMerges();
    res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(data)); return;
  }
  if (urlPath === '/api/merges' && req.method === 'POST') {
    readJsonBody(req).then(body => {
      const data = readMerges();
      const key = m => JSON.stringify([m.winner, m.loser]);
      if (body.action === 'add' && body.merge) {
        if (!data.merges.some(m => key(m) === key(body.merge))) data.merges.push({ ...body.merge, ts: new Date().toISOString().slice(0, 10) });
      } else if (body.action === 'remove' && body.merge) {
        data.merges = data.merges.filter(m => key(m) !== key(body.merge));
      }
      const tmp = MERGES_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, MERGES_PATH);
      res.writeHead(200, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify(data));
    }).catch(err => {
      console.error('[api/merges] error:', err.message);
      res.writeHead(400, { 'Content-Type': MIME['.json'] }); res.end(JSON.stringify({ error: 'bad json: ' + err.message }));
    });
    return;
  }

  // API: /api/merges/apply — fold saved merges + rebuild derived tables (NON-CORS).
  // Releases the READ_ONLY DB lock first so the child read-write writers can open
  // the DB, then reopens. graph.json is read fresh from disk per-request (no
  // in-memory cache), so the rebuilt graph is picked up automatically.
  if (urlPath === '/api/merges/apply' && req.method === 'POST') {
    if (applying) { res.writeHead(409, {'Content-Type':'application/json'}); res.end('{"error":"already applying"}'); return; }
    applying = true;
    (async () => {
      try {
        await closeDb();                                  // release READ_ONLY lock
        const log = await runStep('pipeline/apply-merges.js', ['--apply']);
        await runStep('pipeline/build-connections.js');
        await runStep('pipeline/build-graph.js');
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, applyLog: String(log).split('\n').filter(Boolean).slice(0, 6) }));
      } catch (e) {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 800) }));
      } finally {
        applying = false;
        try { await getDb(); } catch {}                   // reopen READ_ONLY for subsequent requests
      }
    })();
    return;
  }

  // API: /api/face-labels — GET returns current labels file (or empty shape); POST saves new labels.
  // Deliberately NON-CORS (no Access-Control-Allow-Origin): labeling data is personal.
  if (urlPath === '/api/face-labels') {
    if (req.method === 'GET') {
      const p = path.join(__dirname, 'face-labels.json');
      if (fs.existsSync(p)) {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(p, 'utf-8'));
      } else {
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ clusters: [] }));
      }
      return;
    }
    if (req.method === 'POST') {
      handleFaceLabelsPost(req, res).catch(err => {
        console.error('[api/face-labels] error:', err.message);
        try { res.writeHead(500, { 'Content-Type': MIME['.json'] }); viewError(res, 'api', err, false); } catch {}
      });
      return;
    }
    res.writeHead(405, { 'Content-Type': MIME['.json'], 'Allow': 'GET, POST' });
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  // Page: /fb-events — Facebook events timeline + interest topics.
  if (urlPath === '/fb-events' || urlPath === '/fb-events/') {
    let fbData = { events: [], topics: [] };
    try { fbData = JSON.parse(fs.readFileSync(path.join(ROOT, 'fb-events.json'), 'utf-8')); } catch {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderFbEventsPage(fbData));
    return;
  }

  // API: /api/youtube.json — interests/content summary (non-sensitive; CORS-open like other artifacts).
  if (urlPath === '/api/youtube.json') {
    const p = path.join(ROOT, 'youtube.json');
    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(p, 'utf-8'));
    } else {
      res.writeHead(404, { 'Content-Type': MIME['.json'] });
      res.end('{"error":"no youtube summary yet — run build-youtube"}');
    }
    return;
  }

  // Page: /youtube — human-readable interests surface.
  if (urlPath === '/youtube' || urlPath === '/youtube/') {
    const p = path.join(ROOT, 'youtube.json');
    if (!fs.existsSync(p)) {
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      res.end('<p>No youtube summary yet. Run <code>npm run build-youtube</code>.</p>');
      return;
    }
    const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const liList = (arr) => (arr || []).map(t => `<li>${esc(t.topic)} <span style="color:#888">${t.count ?? ''}</span></li>`).join('');
    const topics = liList(s.top_topics);
    const channels = liList(s.top_channels);
    const artists = liList(s.top_artists);
    const subs = (s.top_subscriptions || []).map(c => `<li>${esc(c.title || c.channel_id)}</li>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><title>YouTube interests</title>
<style>body{font:14px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem}ul{columns:2}</style>
<h1>YouTube interests</h1>
<p>${s.subscriptions} subscriptions · ${s.songs} songs · ${s.videos} uploads · ${s.watch_entries} watched · ${s.search_entries} searches · self channel: ${esc(s.self_channel)} · generated ${esc(s.generated)}</p>
<h2>Top topics</h2><ul>${topics}</ul>
<h2>Most-watched channels</h2><ul>${channels}</ul>
<h2>Top music artists</h2><ul>${artists}</ul>
<h2>Subscriptions</h2><ul>${subs}</ul>`;
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(html);
    return;
  }

  // Unified interests — aggregates YouTube + Facebook-events + Gmail signals (live, read-only).
  if (urlPath === '/interests') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        const chips = (arr) => arr.map(t => `<span class="chip">${escapeHtml(t.topic)} <b>${t.count}</b></span>`).join(' ') || '<span class="sub">none</span>';
        const ytTopics = await q(`SELECT topic, count FROM yt_topics WHERE kind='topic' ORDER BY count DESC LIMIT 30`);
        const ytArtists = await q(`SELECT topic, count FROM yt_topics WHERE kind='artist' ORDER BY count DESC LIMIT 20`);
        const ytChannels = await q(`SELECT topic, count FROM yt_topics WHERE kind='channel' ORDER BY count DESC LIMIT 20`);
        const fbTopics = await q(`SELECT topic, n AS count FROM fb_event_topics ORDER BY n DESC LIMIT 30`);
        const gSubs = await q(`SELECT display_name AS topic, n_messages AS count FROM email_correspondents WHERE kind <> 'person' AND display_name IS NOT NULL ORDER BY n_messages DESC LIMIT 30`);
        const gCats = await q(`SELECT category AS topic, COUNT(*) AS count FROM email_meta WHERE category IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
        const html = `<!doctype html><meta charset="utf-8"><title>Interests</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.8rem;margin:0 0 1rem}
h2{margin:1.8rem 0 .5rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:.3rem;font-weight:600}
.chip{display:inline-block;background:var(--quote-bg);border:1px solid var(--rule);border-radius:12px;padding:2px 10px;margin:3px 2px;font-size:.85rem}.chip b{color:var(--accent);font-weight:600}</style>
<nav class="crumbs"><a href="/">← root</a> · interests</nav>
<h1>Interests</h1><p class="sub">What Demo's into — aggregated across YouTube, Facebook events &amp; Gmail.</p>
<h2>📺 YouTube — topics</h2><div>${chips(ytTopics)}</div>
<h2>🎵 YouTube — music artists</h2><div>${chips(ytArtists)}</div>
<h2>📺 YouTube — most-watched channels</h2><div>${chips(ytChannels)}</div>
<h2>📅 Facebook events — topics</h2><div>${chips(fbTopics)}</div>
<h2>✉️ Gmail — subscriptions &amp; brands</h2><div>${chips(gSubs)}</div>
<h2>✉️ Gmail — category mix</h2><div>${chips(gCats)}</div>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'interests', e);
      }
    })();
    return;
  }

  // Unified life timeline — milestones (default) or per-person (?person=<canonical_id>).
  if (urlPath === '/milestones') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        const yr = (col) => `EXTRACT(year FROM to_timestamp(${col}/1000))::INT`;
        const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
        const selfRow = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE display_name='Demo User' LIMIT 1`)).getRows()[0];
        const selfId = selfRow ? selfRow[0] : '__none__';
        const person = (urlSearch.get('person') || '').trim();

        if (person) {
          const who = (await q(`SELECT display_name FROM identities WHERE canonical_id=${sq(person)}`))[0];
          if (!who) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('person not found'); return; }
          const msgs = await q(`SELECT ${yr('m.ts')} y, COUNT(*) n FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id WHERE ti.canonical_id=${sq(person)} AND m.meaningful AND m.ts IS NOT NULL GROUP BY 1 ORDER BY 1`);
          const pics = await q(`SELECT ${yr('p.ts')} y, COUNT(*) n FROM photo_faces pf JOIN photos p ON p.id=pf.photo_id WHERE pf.canonical_id=${sq(person)} AND p.ts IS NOT NULL GROUP BY 1 ORDER BY 1`);
          const mMap = new Map(msgs.map(r => [r.y, Number(r.n)])), pMap = new Map(pics.map(r => [r.y, Number(r.n)]));
          const years = [...new Set([...mMap.keys(), ...pMap.keys()])].filter(y => y >= 2005 && y <= 2035).sort((a, b) => b - a);
          const maxM = Math.max(1, ...mMap.values()), maxP = Math.max(1, ...pMap.values());
          const bar = (v, max, c) => `<span style="display:inline-block;height:9px;width:${Math.round(140 * v / max)}px;background:${c};border-radius:2px;vertical-align:middle"></span>`;
          const rows = years.map(y => `<tr><td><b>${y}</b></td><td>${bar(mMap.get(y) || 0, maxM, 'var(--accent)')} ${(mMap.get(y) || 0).toLocaleString()} msgs</td><td>${bar(pMap.get(y) || 0, maxP, 'var(--muted)')} ${pMap.get(y) || 0} photos</td></tr>`).join('');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Timeline · ${escapeHtml(who.display_name)}</title>
<style>${PORTRAIT_CSS}
td{padding:5px 14px;white-space:nowrap}</style>
<nav class="crumbs"><a href="/milestones">← all milestones</a></nav><h1>${escapeHtml(who.display_name)}</h1><table>${rows || '<tr><td>no dated activity</td></tr>'}</table>`);
          return;
        }

        const photos = await q(`SELECT ${yr('ts')} y, COUNT(*) n FROM photos WHERE source='gphotos' AND ts IS NOT NULL GROUP BY 1`);
        const msgs = await q(`SELECT ${yr('ts')} y, COUNT(*) n FROM messages WHERE meaningful AND ts IS NOT NULL GROUP BY 1`);
        const topMsg = await q(`SELECT y, display_name, cid, n FROM (SELECT ${yr('m.ts')} y, ti.canonical_id cid, COUNT(*) n, ROW_NUMBER() OVER (PARTITION BY ${yr('m.ts')} ORDER BY COUNT(*) DESC) rn FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id JOIN threads t ON t.thread_id=m.thread_id WHERE m.meaningful AND NOT t.is_group AND m.ts IS NOT NULL AND ti.canonical_id<>${sq(selfId)} GROUP BY 1,2) x JOIN identities i ON i.canonical_id=x.cid WHERE rn=1`);
        const topPic = await q(`SELECT y, display_name, cid, n FROM (SELECT ${yr('p.ts')} y, pf.canonical_id cid, COUNT(*) n, ROW_NUMBER() OVER (PARTITION BY ${yr('p.ts')} ORDER BY COUNT(*) DESC) rn FROM photo_faces pf JOIN photos p ON p.id=pf.photo_id WHERE p.ts IS NOT NULL AND pf.canonical_id<>${sq(selfId)} GROUP BY 1,2) x JOIN identities i ON i.canonical_id=x.cid WHERE rn=1`);
        const fb = await q(`SELECT ${yr('start_ts')} y, name FROM fb_events WHERE start_ts IS NOT NULL AND response IN ('joined','hosted','ticket','created') ORDER BY start_ts DESC`);
        const m = {};
        const slot = (y) => (m[y] = m[y] || { fb: [] });
        for (const r of photos) slot(r.y).photos = Number(r.n);
        for (const r of msgs) slot(r.y).msgs = Number(r.n);
        for (const r of topMsg) { const s = slot(r.y); s.topMsg = r.display_name; s.topMsgCid = r.cid; s.topMsgN = Number(r.n); }
        for (const r of topPic) { const s = slot(r.y); s.topPic = r.display_name; s.topPicN = Number(r.n); }
        for (const r of fb) if (r.y != null) slot(r.y).fb.push(r.name);
        const pl = (cid, label) => `<a href="/person?id=${encodeURIComponent(cid)}">${escapeHtml(label)}</a>`;
        const years = Object.keys(m).map(Number).filter(y => y >= 2005 && y <= 2035).sort((a, b) => b - a);
        const sec = years.map(y => {
          const d = m[y];
          const parts = [];
          if (d.msgs) parts.push(`${d.msgs.toLocaleString()} messages`);
          if (d.topMsg) parts.push(`closest: ${pl(d.topMsgCid, d.topMsg)} (${d.topMsgN})`);
          if (d.photos) parts.push(`${d.photos} photos`);
          if (d.topPic) parts.push(`most photographed: ${escapeHtml(d.topPic)} (${d.topPicN})`);
          const ev = (d.fb || []).slice(0, 10).map(n => `<li>${escapeHtml(n)}</li>`).join('');
          return `<section><h2>${y}</h2><p class="stat">${parts.join(' · ')}</p>${ev ? `<ul>${ev}</ul>` : ''}</section>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Life timeline</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.8rem;margin:0 0 1.5rem}
section{border-left:2px solid var(--rule);padding-left:1rem;margin:.4rem 0}
section h2{margin:.9rem 0 .15rem;font-size:1.4rem}
.stat{color:var(--muted);margin:.1rem 0;font-size:.95rem}
ul{margin:.3rem 0 .7rem}</style>
<nav class="crumbs"><a href="/">← root</a> · life milestones</nav>
<h1>Life timeline</h1><p class="sub">Messages · photos · Facebook events, by year — click a name for their personal timeline.</p>${sec}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'timeline', e);
      }
    })();
    return;
  }

  // Person 360 — unify messages + photos + co-presence + mentions + portrait for one person.
  if (urlPath === '/person') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
        const unw = (v) => Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []);
        const id = (urlSearch.get('id') || '').trim();
        const info = (await q(`SELECT display_name, aliases, sources FROM identities WHERE canonical_id=${sq(id)}`))[0];
        if (!info) { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('person not found'); return; }
        const name = info.display_name;
        const stat = (await q(`SELECT COUNT(*) n, MIN(m.ts) mn, MAX(m.ts) mx FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id WHERE ti.canonical_id=${sq(id)} AND m.meaningful`))[0];
        const bySrc = await q(`SELECT m.source, COUNT(*) n FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id WHERE ti.canonical_id=${sq(id)} AND m.meaningful GROUP BY 1 ORDER BY 2 DESC`);
        const byYr = await q(`SELECT EXTRACT(year FROM to_timestamp(m.ts/1000))::INT y, COUNT(*) n FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id WHERE ti.canonical_id=${sq(id)} AND m.meaningful AND m.ts IS NOT NULL GROUP BY 1 ORDER BY 1`);
        const bd = (await q(`SELECT month, day FROM birthdays WHERE canonical_id=${sq(id)} LIMIT 1`))[0];
        const mentions = (await q(`SELECT COUNT(*) n FROM mentions WHERE mentioned_canonical_id=${sq(id)}`))[0];
        let callStat = null;
        try { callStat = (await q(`SELECT COUNT(*) n, COALESCE(SUM(duration_s),0) secs, MAX(ts) last_ts, COUNT(*) FILTER (WHERE missed) missed FROM calls WHERE canonical_id=${sq(id)}`))[0]; } catch {}
        const photos = await q(`SELECT p.asset_path FROM photo_faces pf JOIN photos p ON p.id=pf.photo_id WHERE pf.canonical_id=${sq(id)} AND p.asset_path IS NOT NULL ORDER BY p.ts DESC NULLS LAST LIMIT 24`);
        const copres = await q(`SELECT pf2.canonical_id cid, i.display_name nm, COUNT(DISTINCT pf1.photo_id) n FROM photo_faces pf1 JOIN photo_faces pf2 ON pf1.photo_id=pf2.photo_id AND pf1.canonical_id<>pf2.canonical_id JOIN identities i ON i.canonical_id=pf2.canonical_id WHERE pf1.canonical_id=${sq(id)} AND i.display_name <> 'Demo User' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`);
        const evts = await q(`SELECT e.event_id, e.start_ts, e.place_name, e.summary, e.n_photos FROM events e JOIN event_photos ep ON ep.event_id=e.event_id JOIN photo_faces pf ON pf.photo_id=ep.photo_id WHERE pf.canonical_id=${sq(id)} GROUP BY 1,2,3,4,5 ORDER BY e.start_ts DESC LIMIT 40`);
        const evPartners = await q(`SELECT related_canonical_id cid, related_label nm, weight FROM links WHERE link_type='co_present_event' AND canonical_id=${sq(id)} AND related_label <> 'Demo User' ORDER BY weight DESC LIMIT 12`);
        let metups = [];
        try { metups = await q(`SELECT event_id, start_ts, place_name, summary, n_messages FROM events WHERE source='messages' AND list_contains(participants, ${sq(id)}) ORDER BY start_ts DESC LIMIT 40`); } catch {} // events.source may predate this DB
        const aliases = unw(info.aliases), sources = unw(info.sources);
        const slug = String(name).replace(/ /g, '_');
        const portraitPath = path.join(ROOT, 'portraits', slug + '.md');
        const hasPortrait = fs.existsSync(portraitPath);
        const { personSeries } = await import('./lib/person-series.js');
        const ps = await personSeries(conn, id);
        const b64 = (s) => Buffer.from(String(s)).toString('base64url');
        const fmtDate = (ts) => ts ? new Date(Number(ts)).toISOString().slice(0, 10) : '?';
        const months = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const maxY = Math.max(1, ...byYr.map(r => Number(r.n)));
        const yrBars = byYr.map(r => `<tr><td>${r.y}</td><td><span style="display:inline-block;height:9px;width:${Math.round(160 * Number(r.n) / maxY)}px;background:var(--accent);border-radius:2px;vertical-align:middle"></span> ${Number(r.n).toLocaleString()}</td></tr>`).join('');
        const grid = photos.map(p => `<a href="/photo/${b64(p.asset_path)}" target="_blank"><img loading="lazy" src="/thumb/${b64(p.asset_path)}" style="width:96px;height:96px;object-fit:cover;border-radius:4px;border:1px solid var(--rule)"></a>`).join('');
        const cop = copres.map(c => `<li><a href="/person?id=${encodeURIComponent(c.cid)}">${escapeHtml(c.nm)}</a> <span class="sub">${Number(c.n)} photos</span></li>`).join('');
        // Header sparkline (the Horaire rule: the timeline before any prose) —
        // message volume as bars, events-together as dots on top.
        let spark = '', arcLine = '';
        if (ps) {
          const SW = 15, SH = 44, n = ps.series.length;
          const maxM = Math.max(1, ...ps.series.map(r => r.messages));
          const bars = ps.series.map((r, i) => {
            const h = r.messages ? Math.max(2, Math.round((SH - 14) * Math.log1p(r.messages) / Math.log1p(maxM))) : 0;
            const bar = h ? `<rect x="${i * SW + 2}" y="${SH - h - 12}" width="${SW - 4}" height="${h}" fill="var(--rule)"/>` : '';
            const dot = r.events ? `<circle cx="${i * SW + SW / 2}" cy="${SH - 6}" r="${Math.min(5, 1.5 + Math.sqrt(r.events) * 1.3).toFixed(1)}" fill="var(--accent)"/>` : '';
            return `<g><title>${r.year} · ${r.events} events together · ${r.messages.toLocaleString()} msgs</title>${bar}${dot}</g>`;
          }).join('');
          const t0 = `<text x="0" y="${SH + 10}" font-size="9" fill="var(--muted)">${ps.firstYear}</text>`;
          const t1 = `<text x="${n * SW}" y="${SH + 10}" text-anchor="end" font-size="9" fill="var(--muted)">${ps.lastYear}</text>`;
          spark = `<svg width="${n * SW}" height="${SH + 14}" viewBox="0 0 ${n * SW} ${SH + 14}" style="display:block;margin:.4rem 0">${bars}${t0}${t1}</svg>`;
          const bits = [`first met ${ps.firstYear}`];
          if (ps.gap && ps.gap.to - ps.gap.from >= 1) {
            bits.push(`quiet ${ps.gap.from}–${ps.gap.to}`);
            if (ps.resurfacedYear) bits.push(`resurfaced ${ps.resurfacedYear}`);
          }
          arcLine = `<p class="sub">${bits.join(' · ')}</p>`;
        }
        const evLi = evts.map(e => `<li><a href="/events/${encodeURIComponent(e.event_id)}.html">${escapeHtml(e.summary || e.place_name || e.event_id)}</a> <span class="sub">${fmtDate(e.start_ts)} · ${Number(e.n_photos)} photos</span></li>`).join('');
        const evPart = evPartners.map(c => `<li><a href="/person?id=${encodeURIComponent(c.cid)}">${escapeHtml(c.nm)}</a> <span class="sub">${Number(c.weight)} events together</span></li>`).join('');
        const mevtDay = (e) => /^mevt_\d{4}-\d{2}-\d{2}_/.test(e.event_id) ? e.event_id.slice(5, 15) : fmtDate(e.start_ts);
        const metLi = metups.map(e => `<li><a href="/events/${encodeURIComponent(e.event_id)}.html">${escapeHtml(e.summary || e.place_name || e.event_id)}</a> <span class="sub">${mevtDay(e)} · ${Number(e.n_messages)} msgs · inferred</span></li>`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
.facet{margin:1.6rem 0 .5rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:.3rem;font-weight:600}
td{padding:2px 12px 2px 0}.grid{display:flex;flex-wrap:wrap;gap:5px}ul{list-style:none;padding:0}li{padding:3px 0}</style>
<nav class="crumbs"><a href="/">← root</a> · <a href="/graph">graph</a> · person</nav>
<h1>${escapeHtml(name)}</h1>
<p class="sub">${sources.map(escapeHtml).join(' · ') || '—'}${bd ? ` · 🎂 ${months[bd.month] || '?'} ${bd.day}` : ''}${hasPortrait ? (() => {
  const tended = fs.statSync(portraitPath).mtime;
  const days = Math.round((Date.now() - tended.getTime()) / 86400000);
  const stale = days > 180;
  return ` · <a href="/portraits/${encodeURIComponent(slug)}">portrait →</a> <span class="sub"${stale ? ' style="opacity:.5;font-style:italic"' : ''}>last tended ${tended.toISOString().slice(0, 10)}${stale ? ' · wilting' : ''}</span>`;
})() : ''} · <a href="/milestones?person=${encodeURIComponent(id)}">timeline →</a></p>
${spark}${arcLine}
<p class="sub">aliases: ${aliases.slice(0, 6).map(escapeHtml).join(', ') || '—'}</p>
<div class="facet">messages</div>
<p>${stat && Number(stat.n) ? `${Number(stat.n).toLocaleString()} meaningful messages · ${fmtDate(stat.mn)} → ${fmtDate(stat.mx)}` : 'no direct messages'} · mentioned ${Number(mentions.n)}×</p>
<p class="sub">by source: ${bySrc.map(s => `${escapeHtml(s.source)} ${Number(s.n).toLocaleString()}`).join(' · ') || '—'}</p>
<table>${yrBars}</table>
${callStat && Number(callStat.n) ? `<div class="facet">calls</div><p>${Number(callStat.n)} calls · ${Math.round(Number(callStat.secs) / 60)} min total · ${Number(callStat.missed)} missed · last ${callStat.last_ts ? fmtDate(callStat.last_ts) : '?'}</p>` : ''}
${photos.length ? `<div class="facet">photos · ${photos.length} most recent</div><div class="grid">${grid}</div>` : ''}
${evLi ? `<div class="facet">physically together · ${evts.length}${evts.length === 40 ? '+' : ''} events</div><ul>${evLi}</ul>` : ''}
${metLi ? `<div class="facet">met up · inferred from messages${metups.length === 40 ? ' · 40 most recent' : ''}</div><ul>${metLi}</ul>` : ''}
${evPart ? `<div class="facet">most present with</div><ul>${evPart}</ul>` : ''}
${cop ? `<div class="facet">most photographed with</div><ul>${cop}</ul>` : ''}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'person', e);
      }
    })();
    return;
  }

  // On this day — photos, FB events, and messages from today's calendar date across all years.
  if (urlPath === '/on-this-day') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        const months = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        let M, D;
        const dp = (urlSearch.get('date') || '').match(/^(\d{1,2})-(\d{1,2})$/);
        if (dp) { M = +dp[1]; D = +dp[2]; } else { const n = new Date(); M = n.getMonth() + 1; D = n.getDate(); }
        if (!(M >= 1 && M <= 12 && D >= 1 && D <= 31)) { const n = new Date(); M = n.getMonth() + 1; D = n.getDate(); }
        const yc = (col) => `EXTRACT(year FROM to_timestamp(${col}/1000))::INT`;
        const md = (col) => `EXTRACT(month FROM to_timestamp(${col}/1000))=${M} AND EXTRACT(day FROM to_timestamp(${col}/1000))=${D}`;
        const b64 = (s) => Buffer.from(String(s)).toString('base64url');
        const photos = await q(`SELECT p.asset_path, ${yc('p.ts')} y FROM photos p WHERE p.source='gphotos' AND p.ts IS NOT NULL AND ${md('p.ts')} AND p.asset_path IS NOT NULL ORDER BY p.ts DESC LIMIT 60`);
        const events = await q(`SELECT name, ${yc('start_ts')} y, response FROM fb_events WHERE start_ts IS NOT NULL AND ${md('start_ts')} ORDER BY start_ts DESC`);
        const msgYr = await q(`SELECT y, display_name, cid, n FROM (SELECT ${yc('m.ts')} y, ti.canonical_id cid, COUNT(*) n, ROW_NUMBER() OVER (PARTITION BY ${yc('m.ts')} ORDER BY COUNT(*) DESC) rn FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id JOIN threads t ON t.thread_id=m.thread_id WHERE m.meaningful AND NOT t.is_group AND m.ts IS NOT NULL AND ${md('m.ts')} GROUP BY 1,2) x JOIN identities i ON i.canonical_id=x.cid WHERE rn=1`);
        const msgCnt = await q(`SELECT ${yc('ts')} y, COUNT(*) n FROM messages WHERE meaningful AND ts IS NOT NULL AND ${md('ts')} GROUP BY 1`);
        const cnt = new Map(msgCnt.map(r => [r.y, Number(r.n)]));
        const pby = {};
        for (const p of photos) (pby[p.y] = pby[p.y] || []).push(p.asset_path);
        const photoSecs = Object.keys(pby).map(Number).sort((a, b) => b - a).map(y =>
          `<h3>${y}</h3><div class="grid">${pby[y].map(ap => `<a href="/photo/${b64(ap)}" target="_blank"><img loading="lazy" src="/thumb/${b64(ap)}" style="width:88px;height:88px;object-fit:cover;border-radius:4px;border:1px solid var(--rule)"></a>`).join('')}</div>`).join('');
        const evSecs = events.map(e => `<li><b>${e.y}</b> — ${escapeHtml(e.name)} <span class="sub">${escapeHtml(e.response)}</span></li>`).join('');
        const msgSecs = msgYr.sort((a, b) => b.y - a.y).map(r => `<li><b>${r.y}</b> — ${cnt.get(r.y) || '?'} messages, mostly with <a href="/person?id=${encodeURIComponent(r.cid)}">${escapeHtml(r.display_name)}</a></li>`).join('');
        const empty = !photoSecs && !evSecs && !msgSecs;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>On this day · ${months[M]} ${D}</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
.facet{margin:1.6rem 0 .5rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:.3rem;font-weight:600}
h3{font-size:1rem;margin:.9rem 0 .3rem;color:var(--accent)}.grid{display:flex;flex-wrap:wrap;gap:5px}ul{list-style:none;padding:0}li{padding:3px 0}</style>
<nav class="crumbs"><a href="/">← root</a> · on this day</nav>
<h1>On this day — ${months[M]} ${D}</h1>
<p class="sub">photos · events · messages from ${months[M]} ${D} across the years</p>
${empty ? '<p>Nothing recorded on this date yet.</p>' : ''}
${photoSecs ? `<div class="facet">📷 photos</div>${photoSecs}` : ''}
${evSecs ? `<div class="facet">📅 events</div><ul>${evSecs}</ul>` : ''}
${msgSecs ? `<div class="facet">💬 conversations</div><ul>${msgSecs}</ul>` : ''}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'on-this-day', e);
      }
    })();
    return;
  }

  // The field — soot-style mosh: every event a particle, depth = years,
  // bearing = dominant companion, radius = distance from home. Scroll to
  // descend through time; hover lights a friend's whole thread.
  if (urlPath === '/field' || urlPath === '/field/') {
    (async () => {
      try {
        const conn = await getDb();
        const { computeField } = await import('./lib/field.js');
        const f = await computeField(conn);
        if (!f.items.length) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('no field yet — run build-events'); return; }
        const b64 = (s) => Buffer.from(String(s)).toString('base64url');
        const hue = (yi) => Math.round(210 - 190 * yi / Math.max(1, f.years.length - 1));
        const nodes = f.items.map(i => {
          const size = Math.round(Math.min(72, 30 + Math.sqrt(i.n_photos) * 4.2));
          const tip = `${i.title} · ${f.years[i.yi]}${i.personName ? ' · with ' + i.personName : ''}${i.inferred ? ' · inferred' : ` · ${i.n_photos} photos`}`;
          const body = i.thumb
            ? `<img loading="lazy" src="/thumb/${b64(i.thumb)}" width="${size}" height="${size}">`
            : `<span class="disc" style="width:${Math.max(16, size - 10)}px;height:${Math.max(16, size - 10)}px;background:hsla(${hue(i.yi)},50%,52%,.8)"></span>`;
          return `<a class="it" data-yi="${i.yi}"${i.person ? ` data-p="${escapeHtml(i.person)}"` : ''} href="/events/${encodeURIComponent(i.event_id)}.html" title="${escapeHtml(tip)}" style="left:calc(50% + ${(i.x * 46).toFixed(2)}vw);top:calc(50% + ${(i.y * 40).toFixed(2)}vh)">${body}</a>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>field</title>
<style>${PORTRAIT_CSS}
html,body{height:100%;overflow:hidden}
body{margin:0;padding:0;max-width:none}
.hud{position:fixed;top:0;left:0;right:0;z-index:500;display:flex;gap:1rem;align-items:baseline;padding:.7rem 1.2rem;background:linear-gradient(var(--bg),transparent)}
.hud .yr{font-size:2rem;font-weight:700;color:var(--accent);min-width:5.5rem}
.hud .sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.75rem}
.hud input[type=range]{flex:1;max-width:420px;accent-color:var(--accent)}
.hud a{font-size:.8rem}
.stage{position:fixed;inset:0}
.it{position:absolute;transform:translate(-50%,-50%);will-change:transform,opacity;transition:outline .12s}
.it img{display:block;object-fit:cover;border-radius:5px;box-shadow:0 1px 6px rgba(0,0,0,.25)}
.it .disc{display:block;border-radius:50%}
.it.kin{outline:3px solid var(--accent);z-index:400!important}
.it.dim{opacity:.08!important}
</style>
<div class="stage" id="stage">${nodes}</div>
<div class="hud">
  <a href="/">← root</a>
  <span class="yr" id="yr"></span>
  <span class="sub" id="cnt"></span>
  <input type="range" id="depth" min="0" max="${(f.years.length - 1) * 10}" value="${(f.years.length - 1) * 10}">
  <a href="#" id="all">see everything</a>
  <span class="sub">scroll to move through the years · hover lights a friend's thread · click opens the event</span>
</div>
<script>
const YEARS=${JSON.stringify(f.years)};
const stage=document.getElementById('stage'), yrEl=document.getElementById('yr'), cntEl=document.getElementById('cnt');
const slider=document.getElementById('depth'), allBtn=document.getElementById('all');
const its=[...stage.children].map(el=>({el, yi:+el.dataset.yi}));
const perYear={}; its.forEach(i=>perYear[i.yi]=(perYear[i.yi]||0)+1);
let focus=YEARS.length-1, overview=false, raf=0;
function apply(){
  raf=0;
  for(const it of its){
    const d=it.yi-focus;
    const ad=Math.abs(d);
    if(!overview && ad>3.5){ it.el.style.display='none'; continue; }
    it.el.style.display='';
    const s=overview?0.22:Math.max(0.1,Math.min(1.55,1.35-0.42*ad));
    const o=overview?0.65:Math.max(0.08,1-0.24*ad);
    const b=overview?0:(ad<0.7?0:ad<2?2:4);
    it.el.style.transform='translate(-50%,-50%) scale('+s.toFixed(3)+')';
    it.el.style.opacity=o.toFixed(2);
    it.el.style.filter=b?'blur('+b+'px)':'';
    it.el.style.zIndex=String(300-Math.round(ad*40));
    it.el.style.pointerEvents=(overview||ad<1.5)?'auto':'none';
  }
  const y=Math.round(Math.max(0,Math.min(YEARS.length-1,focus)));
  yrEl.textContent=overview?'∞':YEARS[y];
  cntEl.textContent=overview?its.length+' events, all years':(perYear[y]||0)+' events';
}
function schedule(){ if(!raf) raf=requestAnimationFrame(apply); }
addEventListener('wheel',e=>{ if(overview)return; focus=Math.max(0,Math.min(YEARS.length-1,focus+e.deltaY*0.008)); slider.value=String(Math.round(focus*10)); schedule(); },{passive:true});
slider.addEventListener('input',()=>{ overview=false; focus=+slider.value/10; schedule(); });
allBtn.addEventListener('click',e=>{ e.preventDefault(); overview=!overview; allBtn.textContent=overview?'dive back in':'see everything'; schedule(); });
stage.addEventListener('mouseover',e=>{ const a=e.target.closest('.it'); const p=a&&a.dataset.p; if(!p)return;
  for(const it of its){ const m=it.el.dataset.p===p; it.el.classList.toggle('kin',m); it.el.classList.toggle('dim',!m&&it.el.style.display!=='none'); } });
stage.addEventListener('mouseout',e=>{ if(e.target.closest('.it')) for(const it of its){ it.el.classList.remove('kin','dim'); } });
apply();
</script>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'field', e);
      }
    })();
    return;
  }

  // Year atlas — small-multiple year maps; no basemap, the city as lived.
  if (urlPath === '/atlas' || urlPath === '/atlas/') {
    (async () => {
      try {
        const conn = await getDb();
        const { yearAtlas, FRAMES } = await import('./lib/atlas.js');
        const a = await yearAtlas(conn);
        if (!a.years.length) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('no atlas yet — run build-events'); return; }
        const PW = 224, PH = 224;
        const proj = (frame, lat, lng) => {
          const [a0, a1, c0, c1] = FRAMES[frame];
          return [((lng - c0) / (c1 - c0)) * PW, ((a1 - lat) / (a1 - a0)) * PH];
        };
        const panels = a.years.map(y => {
          const sub = (a.substrate[y.frame] || []).map(p => {
            const [x, yy] = proj(y.frame, p.lat, p.lng);
            return `<circle cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" r="1.1" fill="var(--muted)" opacity="0.16"/>`;
          }).join('');
          const pts = y.points.map(p => {
            const [x, yy] = proj(y.frame, p.lat, p.lng);
            const r = Math.min(7, 2 + Math.sqrt(p.n_photos) * 0.55);
            const label = `${p.summary || p.place || p.event_id} · ${p.n_photos} photos`;
            return `<a href="/events/${encodeURIComponent(p.event_id)}.html"><circle cx="${x.toFixed(1)}" cy="${yy.toFixed(1)}" r="${r.toFixed(1)}" fill="var(--accent)" opacity="0.62"><title>${escapeHtml(label)}</title></circle></a>`;
          }).join('');
          const beyond = y.beyond.slice(0, 3).map(b => `${escapeHtml(b.place)}${b.n > 1 ? ' ×' + b.n : ''}`).join(', ');
          const extra = [
            beyond ? `beyond: ${beyond}` : '',
            y.nNoCoords ? `${y.nNoCoords} unlocated` : '',
          ].filter(Boolean).join(' · ');
          return `<div class="panel">
<div class="phead"><a href="/year/${y.year}">${y.year}</a> <span class="sub">${y.frame} · ${y.points.length}</span></div>
<svg width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}">${sub}${pts}</svg>
${extra ? `<div class="sub pfoot">${extra}</div>` : ''}</div>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>atlas</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.72rem}
.grid{display:flex;flex-wrap:wrap;gap:14px}
.panel{border:1px solid var(--rule);border-radius:6px;padding:8px}
.phead{font-size:.9rem;margin-bottom:4px}.phead a{text-decoration:none;font-weight:600}
.pfoot{max-width:${PW}px;margin-top:2px}
svg{background:var(--quote-bg);border-radius:4px}</style>
<nav class="crumbs"><a href="/">← root</a> · atlas</nav>
<h1>atlas</h1>
<p class="sub">one map per year, drawn only from where you actually were — grey = all-time, dots = that year's events (click one) · the frame follows the city that held the year</p>
<div class="grid">${panels}</div>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'atlas', e);
      }
    })();
    return;
  }

  // Life in weeks — every week a cell, tinted by that week's dominant
  // companion (era hue, matching /threads), weighted by events.
  if (urlPath === '/weeks' || urlPath === '/weeks/') {
    (async () => {
      try {
        const conn = await getDb();
        const { computeWeeks } = await import('./lib/weeks.js');
        const w = await computeWeeks(conn);
        if (!w.years.length) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('no weeks yet — run build-events'); return; }
        const y0 = w.years[0], y1 = w.years[w.years.length - 1];
        const hue = (fy) => Math.round(210 - 190 * (fy - y0) / Math.max(1, y1 - y0));
        const byKey = new Map(w.cells.map(c => [`${c.year}|${c.week}`, c]));
        const rows = w.years.map(year => {
          const cells = [];
          for (let wk = 0; wk < 53; wk++) {
            const c = byKey.get(`${year}|${wk}`);
            if (!c) { cells.push(`<div class="cell"></div>`); continue; }
            const fy = c.top ? (w.firstYears[c.top.canonical_id] ?? year) : year;
            const alpha = Math.min(1, 0.25 + Math.log1p(c.events) / 2.5);
            const title = `${year} w${wk + 1} · ${c.events} event${c.events > 1 ? 's' : ''}${c.top ? ' · mostly ' + c.top.name : ''}`;
            cells.push(`<div class="cell on" style="background:hsla(${hue(fy)},55%,50%,${alpha.toFixed(2)})" title="${escapeHtml(title)}"></div>`);
          }
          return `<div class="row"><a class="ylab sub" href="/year/${year}">${year}</a>${cells.join('')}</div>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>weeks</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
.row{display:flex;align-items:center;gap:2px;margin:2px 0}
.ylab{width:3.2rem;text-decoration:none}
.cell{width:14px;height:14px;border-radius:2px;background:var(--quote-bg)}
.cell.on:hover{outline:2px solid var(--accent)}</style>
<nav class="crumbs"><a href="/">← root</a> · weeks</nav>
<h1>weeks</h1>
<p class="sub">every week ${y0}–${y1} · color = who you were mostly with (by their era) · brightness = how much happened · hover for the week</p>
${rows}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'weeks', e);
      }
    })();
    return;
  }

  // Rhythm — every meaningful message bucketed (week × Demo-local hour),
  // precomputed by build-rhythm.js. The relocation shows as a seam.
  if (urlPath === '/rhythm' || urlPath === '/rhythm/') {
    try {
      const rhythmPath = path.join(ROOT, 'rhythm.json');
      if (!fs.existsSync(rhythmPath)) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('no rhythm.json — run npm run build-rhythm'); return; }
      const { cells } = JSON.parse(fs.readFileSync(rhythmPath, 'utf-8'));
      const weekKeys = [...new Set(cells.map(c => `${c[0]}|${c[1]}`))].sort((a, b) => {
        const [ya, wa] = a.split('|').map(Number), [yb, wb] = b.split('|').map(Number);
        return ya - yb || wa - wb;
      });
      const xOf = new Map(weekKeys.map((k, i) => [k, i]));
      const CW = 3, CH = 11, PAD_L = 44, PAD_T = 26;
      const W = PAD_L + weekKeys.length * CW + 10, H = PAD_T + 24 * CH + 30;
      const maxN = Math.max(...cells.map(c => c[3]));
      const rects = cells.map(c => {
        const x = PAD_L + xOf.get(`${c[0]}|${c[1]}`) * CW;
        const o = Math.min(1, 0.06 + 0.94 * Math.log1p(c[3]) / Math.log1p(maxN));
        return `<rect x="${x}" y="${PAD_T + c[2] * CH}" width="${CW}" height="${CH}" fill="var(--accent)" opacity="${o.toFixed(2)}"/>`;
      }).join('');
      let ticks = '';
      let lastYear = null, lastTickX = -Infinity;
      weekKeys.forEach((k, i) => {
        const y = Number(k.split('|')[0]);
        const x = PAD_L + i * CW;
        if (y !== lastYear && x - lastTickX >= 30) { ticks += `<text x="${x}" y="${PAD_T - 8}" font-size="10" fill="var(--muted)">${y}</text>`; lastTickX = x; }
        if (y !== lastYear) lastYear = y;
      });
      const hours = [0, 6, 12, 18].map(h => `<text x="${PAD_L - 6}" y="${PAD_T + h * CH + 9}" text-anchor="end" font-size="10" fill="var(--muted)">${String(h).padStart(2, '0')}</text>`).join('');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>rhythm</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
.wrap{overflow-x:auto}</style>
<nav class="crumbs"><a href="/">← root</a> · rhythm</nav>
<h1>rhythm</h1>
<p class="sub">every meaningful message · week × your local hour of day (tz-corrected, so the sleep band holds still and the texture changes when your life does)</p>
<div class="wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${ticks}${hours}${rects}</svg></div>`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      viewError(res, 'rhythm', e);
    }
    return;
  }

  // The braid — people as threads across years; distance from Demo = tie
  // strength that year (SpreadLine's rule), sides stable per person, dashed
  // through absent years, bundle dots where you were physically together.
  if (urlPath === '/threads' || urlPath === '/threads/') {
    (async () => {
      try {
        const conn = await getDb();
        const { computeBraid } = await import('./lib/braid.js');
        const topN = Math.min(80, parseInt(urlSearch.get('n') || '40', 10) || 40);
        const b = await computeBraid(conn, { topN });
        if (!b.people.length) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('no braid yet — run build-events'); return; }

        const PAD_L = 150, PAD_T = 40, COL_W = 88, SLOT_H = 16;
        const W = PAD_L + b.years.length * COL_W + 40;
        const half = Math.ceil(b.people.length / 2);
        const H = PAD_T * 2 + (half * 2 + 2) * SLOT_H;
        const cy = H / 2;
        const X = (yi) => PAD_L + yi * COL_W + COL_W / 2;

        // Stable side per person (by overall rank parity); per-year position =
        // rank among that side's active people (strongest nearest the center).
        b.people.forEach((p, i) => { p.side = i % 2 === 0 ? 1 : -1; });
        const yPos = new Map(); // cid -> yi -> y
        b.years.forEach((year, yi) => {
          for (const side of [1, -1]) {
            const active = b.people
              .filter(p => p.side === side && p.series[yi].strength > 0)
              .sort((a, c) => c.series[yi].strength - a.series[yi].strength);
            active.forEach((p, rank) => {
              let m = yPos.get(p.canonical_id);
              if (!m) { m = new Map(); yPos.set(p.canonical_id, m); }
              m.set(yi, cy - side * (rank + 1.5) * SLOT_H);
            });
          }
        });

        const hue = (fy) => Math.round(210 - 190 * (fy - b.years[0]) / Math.max(1, b.years.length - 1));
        const paths = [];
        const dots = [];
        const labels = [];
        for (const p of b.people) {
          const m = yPos.get(p.canonical_id) || new Map();
          const col = `hsl(${hue(p.firstYear)},45%,52%)`;
          let lastY = null, firstDrawn = false;
          for (let yi = 0; yi < b.years.length; yi++) {
            const s = p.series[yi];
            const here = m.has(yi) ? m.get(yi) : lastY;
            if (here == null) continue;
            if (lastY != null) {
              const x1 = X(yi - 1), x2 = X(yi), mx = (x1 + x2) / 2;
              const wpx = Math.min(4.5, 0.8 + Math.log1p(s.strength) / 2.2);
              const dash = s.strength === 0 ? ' stroke-dasharray="3,5" opacity="0.25"' : ' opacity="0.75"';
              paths.push(`<path d="M ${x1} ${lastY} C ${mx} ${lastY}, ${mx} ${here}, ${x2} ${here}" fill="none" stroke="${col}" stroke-width="${wpx.toFixed(1)}"${dash}/>`);
            }
            if (!firstDrawn && m.has(yi)) {
              labels.push(`<a href="/person?id=${encodeURIComponent(p.canonical_id)}"><text x="${X(yi) - 8}" y="${here + 4}" text-anchor="end" fill="${col}" font-size="11">${escapeHtml(p.name)}</text></a>`);
              firstDrawn = true;
            }
            if (s.events > 0 && m.has(yi)) {
              const r = Math.min(9, 2 + Math.sqrt(s.events) * 1.6);
              dots.push(`<circle cx="${X(yi)}" cy="${here}" r="${r.toFixed(1)}" fill="${col}" opacity="0.85"><title>${escapeHtml(p.name)} · ${b.years[yi]} · ${s.events} events together · ${s.messages.toLocaleString()} msgs</title></circle>`);
            }
            lastY = here;
          }
        }
        const yearHeads = b.years.map((year, yi) =>
          `<a href="/year/${year}"><text x="${X(yi)}" y="${PAD_T - 14}" text-anchor="middle" fill="var(--muted)" font-size="12">${year}</text></a>`).join('');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>threads</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
.wrap{overflow-x:auto}svg text{font-family:-apple-system,system-ui,sans-serif}svg a{cursor:pointer}</style>
<nav class="crumbs"><a href="/">← root</a> · threads</nav>
<h1>threads</h1>
<p class="sub">the ${b.people.length} people you've been physically with, as threads through ${b.years[0]}–${b.years[b.years.length - 1]} — closer to the center line = stronger tie that year · dots = events together · dashed = quiet years · <a href="/threads?n=80">more people</a></p>
<div class="wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${yearHeads}
<line x1="${PAD_L - 10}" y1="${cy}" x2="${W - 20}" y2="${cy}" stroke="var(--accent)" stroke-width="3" opacity="0.9"/>
<text x="${PAD_L - 16}" y="${cy + 4}" text-anchor="end" fill="var(--accent)" font-size="12" font-weight="600">Demo</text>
${paths.join('\n')}
${dots.join('\n')}
${labels.join('\n')}
</svg></div>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'threads', e);
      }
    })();
    return;
  }

  // Yearly almanacs — Feltron-style compiled pages, one per year of events.
  if (urlPath === '/years' || urlPath === '/years/') {
    (async () => {
      try {
        const conn = await getDb();
        const { eventYears, compileYear } = await import('./lib/almanac.js');
        const years = await eventYears(conn);
        const rows = [];
        for (const y of years) {
          const a = await compileYear(conn, y);
          rows.push(`<tr><td><a href="/year/${y}">${y}</a></td><td class="sub">${a.counts.events} events · ${a.counts.people} people · ${a.mostSeen[0] ? escapeHtml(a.mostSeen[0].name) + ' most seen' : '—'}</td></tr>`);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Years</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
table{border-collapse:collapse}td{padding:5px 14px 5px 0}</style>
<nav class="crumbs"><a href="/">← root</a> · years</nav>
<h1>Years</h1>
<p class="sub">one almanac per year — who, where, how much</p>
<table>${rows.join('')}</table>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'years', e);
      }
    })();
    return;
  }
  if (/^\/year\/\d{4}$/.test(urlPath)) {
    (async () => {
      try {
        const conn = await getDb();
        const { eventYears, compileYear } = await import('./lib/almanac.js');
        const year = parseInt(urlPath.slice('/year/'.length), 10);
        const a = await compileYear(conn, year);
        const years = await eventYears(conn);
        const idx = years.indexOf(year);
        const nav = [
          idx > 0 ? `<a href="/year/${years[idx - 1]}">← ${years[idx - 1]}</a>` : '',
          idx >= 0 && idx < years.length - 1 ? `<a href="/year/${years[idx + 1]}">${years[idx + 1]} →</a>` : '',
        ].filter(Boolean).join(' · ');
        const MONTHS = ['J','F','M','A','M','J','J','A','S','O','N','D'];
        const maxM = Math.max(1, ...a.months);
        const monthStrip = a.months.map((n, i) => `<div style="display:inline-block;text-align:center;margin-right:6px"><div style="height:48px;display:flex;align-items:flex-end"><div style="width:16px;height:${Math.round(48 * n / maxM)}px;background:var(--accent);border-radius:2px 2px 0 0"></div></div><div class="sub">${MONTHS[i]}</div></div>`).join('');
        const seen = a.mostSeen.slice(0, 15).map(p => `<li><a href="/person?id=${encodeURIComponent(p.canonical_id)}">${escapeHtml(p.name)}</a> <span class="sub">${p.events} events</span></li>`).join('');
        const faces = a.newFaces.slice(0, 12).map(p => `<a href="/person?id=${encodeURIComponent(p.canonical_id)}">${escapeHtml(p.name)}</a>`).join(', ');
        const gone = a.lapsed.slice(0, 12).map(p => `<a href="/person?id=${encodeURIComponent(p.canonical_id)}">${escapeHtml(p.name)}</a>`).join(', ');
        const places = a.topPlaces.map(p => `${escapeHtml(p.place)} <span class="sub">${p.events}</span>`).join(' · ');
        const conc = a.concentration.totalPeople
          ? `the most-messaged person carried <b>${Math.round(a.concentration.top1Share * 100)}%</b> of the year's messages · the top 5 carried ${Math.round(a.concentration.top5Share * 100)}% · ${a.concentration.totalPeople} people in total`
          : 'no messages this year';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>${year} — almanac</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
.facet{margin:1.6rem 0 .5rem;font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:1px solid var(--rule);padding-bottom:.3rem;font-weight:600}
ul{list-style:none;padding:0}li{padding:3px 0}.big{font-size:1.4rem}</style>
<nav class="crumbs"><a href="/">← root</a> · <a href="/years">years</a> · ${year} ${nav ? '· ' + nav : ''}</nav>
<h1>${year}</h1>
<p class="big">${a.counts.events.toLocaleString()} events${a.counts.inferred ? ` <span class="sub">(${a.counts.inferred} inferred)</span>` : ''} · ${a.counts.people} people · ${a.counts.photos.toLocaleString()} photos · ${a.counts.messages.toLocaleString()} messages</p>
<div class="facet">by month</div><div>${monthStrip}</div>
${seen ? `<div class="facet">most seen</div><ul>${seen}</ul>` : ''}
${faces ? `<div class="facet">new faces</div><p>${faces}</p>` : ''}
${gone ? `<div class="facet">not seen this year</div><p class="sub">${gone}</p>` : ''}
${places ? `<div class="facet">places</div><p>${places}</p>` : ''}
<div class="facet">concentration</div><p>${conc}</p>
${a.biggestEvent ? `<div class="facet">biggest event</div><p><a href="/events/${encodeURIComponent(a.biggestEvent.event_id)}.html">${escapeHtml(a.biggestEvent.title)}</a> <span class="sub">${a.biggestEvent.n_photos} photos${a.biggestEvent.participants.length ? ' · with ' + escapeHtml(a.biggestEvent.participants.join(', ')) : ''}</span></p>` : ''}`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'year', e);
      }
    })();
    return;
  }

  // Life map — geocoded photo locations (by city) + FB-event coords on a Leaflet map.
  if (urlPath === '/map') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        const cities = await q(`SELECT city, country, AVG(lat) la, AVG(lng) ln, COUNT(*) n FROM places WHERE lat IS NOT NULL AND city IS NOT NULL GROUP BY 1,2 ORDER BY n DESC LIMIT 400`);
        const events = await q(`SELECT name, lat, lng FROM fb_events WHERE lat IS NOT NULL AND lng IS NOT NULL`);
        const J = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
        const cityData = cities.map(c => ({ c: c.city, co: c.country, la: Number(c.la), ln: Number(c.ln), n: Number(c.n) }));
        const evData = events.map(e => ({ name: e.name, la: Number(e.lat), ln: Number(e.lng) }));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Life map</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>body{margin:0;font:14px system-ui}#map{height:100vh}
.bar{position:absolute;z-index:1000;top:10px;left:54px;background:#fff;color:#222;padding:5px 12px;border-radius:6px;box-shadow:0 1px 5px rgba(0,0,0,.3)}.bar a{color:#36c;text-decoration:none}</style>
<div class="bar"><a href="/">← root</a> · Life map — <span id="cnt"></span></div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const cities=${J(cityData)},events=${J(evData)};
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const map=L.map('map').setView([-37.81,144.96],4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© OpenStreetMap',maxZoom:19}).addTo(map);
const pts=[];
for(const c of cities){const r=Math.min(34,4+Math.sqrt(c.n));L.circleMarker([c.la,c.ln],{radius:r,color:'#b03a2e',fillColor:'#e74c3c',fillOpacity:.45,weight:1}).addTo(map).bindPopup('<b>'+esc(c.c)+'</b>'+(c.co?', '+esc(c.co):'')+'<br>'+c.n+' photos');pts.push([c.la,c.ln]);}
for(const e of events){L.marker([e.la,e.ln]).addTo(map).bindPopup(esc(e.name));pts.push([e.la,e.ln]);}
if(pts.length)map.fitBounds(pts,{padding:[40,40]});
document.getElementById('cnt').textContent=cities.length+' places · '+events.length+' events';
</script>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'map', e);
      }
    })();
    return;
  }

  // Ask your life — natural-language Q&A via the local LLM (text-to-SQL over the READ-ONLY DB).
  if (urlPath === '/ask') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Ask your life</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
input{width:100%;padding:.6rem .8rem;font:inherit;background:var(--quote-bg);color:var(--fg);border:1px solid var(--rule);border-radius:6px;box-sizing:border-box}
button{margin-top:.6rem;padding:.45rem 1.1rem;font:inherit;background:var(--accent);color:var(--bg);border:none;border-radius:6px;cursor:pointer}
pre{background:var(--quote-bg);border:1px solid var(--rule);border-radius:6px;padding:.6rem;overflow:auto;font-size:.78rem}
table{border-collapse:collapse;font-size:.8rem;margin-top:.5rem}td,th{border:1px solid var(--rule);padding:3px 8px;text-align:left}
#ans{margin:1.1rem 0;white-space:pre-wrap;font-size:1.05rem}.err{color:#c0392b}</style>
<nav class="crumbs"><a href="/">← root</a> · ask</nav>
<h1>Ask your life</h1>
<p class="sub">Natural-language questions over your data — runs read-only via the local LLM. e.g. "who did I message most in 2023?", "what cities have the most photos?", "what music artists do I listen to?"</p>
<form id="f"><input id="q" placeholder="ask anything about your data…" autofocus></form>
<button id="go">Ask</button>
<div id="ans"></div><div id="extra"></div>
<script>
const ans=document.getElementById('ans'),extra=document.getElementById('extra');
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function ask(){const q=document.getElementById('q').value.trim();if(!q)return;ans.textContent='Thinking…';extra.innerHTML='';
 try{const r=await fetch('/api/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:q})});const d=await r.json();
  ans.innerHTML=d.error?'<span class="err">'+esc(d.error)+'</span>':esc(d.answer||'(no answer)');
  let h='';if(d.sql)h+='<p class="sub">query</p><pre>'+esc(d.sql)+'</pre>';
  if(d.rows&&d.rows.length){const cols=Object.keys(d.rows[0]);h+='<table><tr>'+cols.map(c=>'<th>'+esc(c)+'</th>').join('')+'</tr>'+d.rows.slice(0,20).map(row=>'<tr>'+cols.map(c=>'<td>'+esc(row[c])+'</td>').join('')+'</tr>').join('')+'</table>';}
  extra.innerHTML=h;
 }catch(e){ans.innerHTML='<span class="err">'+esc(e.message)+'</span>';}}
document.getElementById('go').onclick=ask;
document.getElementById('f').onsubmit=e=>{e.preventDefault();ask();};
</script>`);
    return;
  }
  if (urlPath === '/api/ask' && req.method === 'POST') {
    (async () => {
      let sql, rows;
      try {
        const body = (await readJsonBody(req)) || {};
        const question = String(body.question || '').slice(0, 500).trim();
        if (!question) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"empty question"}'); return; }
        const SCHEMA = `DuckDB tables (ts columns are unix MILLISECONDS — use to_timestamp(ts/1000)):
identities(canonical_id, display_name, aliases VARCHAR[], sources VARCHAR[]) -- the USER is display_name='Demo User'
messages(id, ts, source, thread_id, from_me BOOLEAN, sender_name, body, meaningful BOOLEAN)
thread_identity(thread_id, canonical_id) -- maps a 1-on-1 thread to the OTHER person; join messages via thread_id to count a person's messages
threads(thread_id, is_group BOOLEAN)
group_membership(thread_id, participant_name, canonical_id); mentions(mentioned_canonical_id, mentioned_form, thread_id, ts, from_me)
photos(id, ts, source, asset_path); places(photo_id, lat, lng, city, country); photo_faces(photo_id, canonical_id) -- who is in a photo
fb_events(name, start_ts, end_ts, place_name, lat, lng, description, response) -- response: joined/interested/declined/invited/created/hosted/ticket
yt_topics(kind, topic, count) -- kind: topic/channel/artist/category; yt_songs(title, album, artists VARCHAR[]); yt_activity(kind, title, channel_name, query, ts)
email_correspondents(display_name, domain, kind, n_messages); email_meta(category); birthdays(canonical_id, name, month, day)`;
        const askLLM = async (messages) => {
          const url = process.env.ASK_LLM_URL || 'http://127.0.0.1:8000/v1/chat/completions';
          const model = process.env.ASK_LLM_MODEL || 'local';
          const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, temperature: 0, max_tokens: 900 }), signal: AbortSignal.timeout(90000) });
          if (!r.ok) throw new Error('LLM HTTP ' + r.status);
          const d = await r.json();
          return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
        };
        const safeSelect = (raw) => {
          let s = String(raw).trim().replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim().replace(/;\s*$/, '');
          if (!/^(select|with)\b/i.test(s)) return null;
          if (/\b(insert|update|delete|drop|alter|create|attach|copy|pragma|install|load|export|replace|set|call)\b/i.test(s)) return null;
          // Block DuckDB read-side file/http table functions (defense in depth — getDb also SET enable_external_access=false).
          if (/\b(read_text|read_text_auto|read_blob|read_csv|read_csv_auto|read_parquet|read_json|read_json_auto|read_ndjson|parquet_scan|glob|sniff_csv)\b/i.test(s)) return null;
          // Bound output regardless of trailing -- comment or an inner LIMIT (the newline terminates any line comment).
          return `SELECT * FROM (\n${s}\n) AS _q LIMIT 200`;
        };
        let answer, gen;
        try {
          gen = await askLLM([
            { role: 'system', content: `Translate the question into ONE DuckDB SELECT over this schema. Output ONLY the SQL — no prose, no markdown fences.\n${SCHEMA}` },
            { role: 'user', content: question },
          ]);
        } catch (llmErr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Local LLM not reachable (' + String((llmErr && llmErr.message) || llmErr).slice(0, 100) + '). Start locallmm (Qwen on :8000) or set ASK_LLM_URL.' }));
          return;
        }
        sql = safeSelect(gen);
        if (!sql) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Could not derive a safe read-only query — try rephrasing.', sql: String(gen).slice(0, 400) })); return; }
        try {
          const conn = await getDb();
          rows = (await conn.runAndReadAll(sql)).getRowObjectsJson()
            .map(r => { const o = {}; for (const k in r) { const v = r[k]; o[k] = typeof v === 'bigint' ? Number(v) : (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v); } return o; });
          // The generated SQL can select message text under any alias, and these rows
          // are handed to an LLM below — so redact on the serialized row, not one column.
          rows = filterRedacted(rows, r => JSON.stringify(r));
        } catch (dbErr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Generated SQL failed: ' + String((dbErr && dbErr.message) || dbErr).slice(0, 160), sql }));
          return;
        }
        try {
          answer = await askLLM([
            { role: 'system', content: 'Answer the question in 1-3 sentences using ONLY the SQL results. Be concrete; cite specific names/numbers.' },
            { role: 'user', content: `Question: ${question}\n\nSQL: ${sql}\n\nResults JSON:\n${JSON.stringify(rows.slice(0, 40))}` },
          ]);
        } catch (llmErr) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ answer: '(LLM summary unavailable — showing raw results)', sql, rows: rows.slice(0, 20) }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ answer, sql, rows: rows.slice(0, 20) }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String((e && e.message) || e).slice(0, 200) }));
      }
    })();
    return;
  }

  // Reconnect — significant contacts (100+ msgs) gone quiet (60+ days), ranked by historical weight.
  if (urlPath === '/reconnect') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        const sq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
        const selfRow = (await conn.runAndReadAll(`SELECT canonical_id FROM identities WHERE display_name='Demo User' LIMIT 1`)).getRows()[0];
        const selfId = selfRow ? selfRow[0] : '__none__';
        const now = Date.now();
        const yrAgo = now - 365 * 86400000;
        const cutoff = now - 60 * 86400000;
        const rows = await q(`
          WITH per AS (
            SELECT ti.canonical_id cid, COUNT(*) n, MAX(m.ts) last_ts,
                   COUNT(*) FILTER (WHERE m.ts > ${yrAgo}) recent
            FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id JOIN threads t ON t.thread_id=m.thread_id
            WHERE m.meaningful AND NOT t.is_group AND m.ts IS NOT NULL AND ti.canonical_id <> ${sq(selfId)}
            GROUP BY 1
          )
          SELECT p.cid, i.display_name nm, p.n, p.last_ts, p.recent
          FROM per p JOIN identities i ON i.canonical_id=p.cid
          WHERE p.n >= 100 AND p.last_ts < ${cutoff}
          ORDER BY p.n DESC LIMIT 80`);
        const li = rows.map(r => {
          const days = Math.round((now - Number(r.last_ts)) / 86400000);
          const ago = days >= 365 ? `${(days / 365).toFixed(1)}y` : `${days}d`;
          return `<tr><td><a href="/person?id=${encodeURIComponent(r.cid)}">${escapeHtml(r.nm)}</a></td><td>${Number(r.n).toLocaleString()}</td><td>${ago} ago</td><td class="sub">${Number(r.recent)} last yr</td></tr>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Reconnect</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
table{border-collapse:collapse;margin-top:1rem}td,th{padding:4px 14px 4px 0;text-align:left}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-bottom:1px solid var(--rule)}</style>
<nav class="crumbs"><a href="/">← root</a> · reconnect</nav>
<h1>Reconnect</h1>
<p class="sub">People who mattered (100+ messages) you haven't talked to in 60+ days — most significant first. Top ${rows.length} shown.</p>
<table><tr><th>person</th><th>total msgs</th><th>last contact</th><th>recent</th></tr>${li || '<tr><td>nobody — all caught up</td></tr>'}</table>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'reconnect', e);
      }
    })();
    return;
  }

  // Relationships lens — closeness across ALL channels (messages + calls + shared photos),
  // not just message volume. Calls are weighted up (calling signals closeness).
  if (urlPath === '/relationships') {
    (async () => {
      try {
        const conn = await getDb();
        const q = async (s) => (await conn.runAndReadAll(s)).getRowObjectsJson();
        let hasCalls = true;
        try { await conn.runAndReadAll('SELECT 1 FROM calls LIMIT 1'); } catch { hasCalls = false; }
        const callCte = hasCalls
          ? `cl AS (SELECT canonical_id cid, COUNT(*) n, SUM(duration_s) secs, MAX(ts) last_ts FROM calls WHERE canonical_id IS NOT NULL GROUP BY 1),`
          : `cl AS (SELECT NULL::VARCHAR cid, 0 n, 0.0 secs, 0::BIGINT last_ts WHERE false),`;
        let hasEvSource = true;
        try { await conn.runAndReadAll('SELECT source FROM events LIMIT 1'); } catch { hasEvSource = false; }
        const miCte = hasEvSource
          ? `mi AS (SELECT pe.cid cid, COUNT(DISTINCT pe.event_id) n FROM (SELECT event_id, unnest(participants) cid FROM events WHERE source='messages') pe GROUP BY 1)`
          : `mi AS (SELECT NULL::VARCHAR cid, 0 n WHERE false)`;
        const rows = await q(`
          WITH msg AS (SELECT ti.canonical_id cid, COUNT(*) n, MAX(m.ts) last_ts FROM messages m JOIN thread_identity ti ON ti.thread_id=m.thread_id JOIN threads t ON t.thread_id=m.thread_id WHERE m.meaningful AND NOT t.is_group GROUP BY 1),
          ${callCte}
          ph AS (SELECT canonical_id cid, COUNT(*) n FROM photo_faces GROUP BY 1),
          ev AS (SELECT pf.canonical_id cid, COUNT(DISTINCT ep.event_id) n FROM event_photos ep JOIN photo_faces pf ON pf.photo_id=ep.photo_id GROUP BY 1),
          ${miCte}
          SELECT i.canonical_id cid, i.display_name nm,
                 COALESCE(msg.n,0) msgs, COALESCE(cl.n,0) calls, COALESCE(cl.secs,0) call_secs, COALESCE(ph.n,0) photos, COALESCE(ev.n,0) events, COALESCE(mi.n,0) metups,
                 GREATEST(COALESCE(msg.last_ts,0), COALESCE(cl.last_ts,0)) last_contact
          FROM identities i
          LEFT JOIN msg ON msg.cid=i.canonical_id
          LEFT JOIN cl ON cl.cid=i.canonical_id
          LEFT JOIN ph ON ph.cid=i.canonical_id
          LEFT JOIN ev ON ev.cid=i.canonical_id
          LEFT JOIN mi ON mi.cid=i.canonical_id
          WHERE i.display_name <> 'Demo User' AND (msg.cid IS NOT NULL OR cl.cid IS NOT NULL OR ph.cid IS NOT NULL OR ev.cid IS NOT NULL OR mi.cid IS NOT NULL)`);
        const now = Date.now();
        const scored = rows.map(r => {
          const msgs = Number(r.msgs), calls = Number(r.calls), secs = Number(r.call_secs), photos = Number(r.photos), events = Number(r.events), metups = Number(r.metups);
          // log-blend so message volume doesn't drown calls/photos; calls weighted up.
          // co-present events weighted up too — being physically there is the strongest signal.
          // inferred meetups count for less than face-verified events.
          const score = Math.log1p(msgs) + 2.5 * Math.log1p(secs / 60) + 2.0 * Math.log1p(photos) + 2.5 * Math.log1p(events) + 1.5 * Math.log1p(metups);
          return { cid: r.cid, nm: r.nm, msgs, calls, secs, photos, events, metups, score, last: Number(r.last_contact) };
        }).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 80);
        const max = scored.length ? scored[0].score : 1;
        const li = scored.map(r => {
          const days = r.last ? Math.round((now - r.last) / 86400000) : null;
          const ago = days == null ? '' : (days > 365 ? `${(days / 365).toFixed(1)}y` : `${days}d`) + ' ago';
          const bits = [`💬 ${r.msgs.toLocaleString()}`];
          if (r.calls) bits.push(`📞 ${r.calls} (${Math.round(r.secs / 60)}m)`);
          if (r.photos) bits.push(`📷 ${r.photos}`);
          if (r.events) bits.push(`🎉 ${r.events}`);
          if (r.metups) bits.push(`🤝 ${r.metups}`);
          if (ago) bits.push(ago);
          return `<tr><td><a href="/person?id=${encodeURIComponent(r.cid)}">${escapeHtml(r.nm)}</a></td><td><span style="display:inline-block;height:8px;width:${Math.round(180 * r.score / max)}px;background:var(--accent);border-radius:2px;vertical-align:middle"></span></td><td class="sub">${bits.join(' · ')}</td></tr>`;
        }).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Relationships</title>
<style>${PORTRAIT_CSS}
.sub{color:var(--muted);font-family:ui-monospace,monospace;font-size:.78rem}
table{border-collapse:collapse}td{padding:4px 12px 4px 0;vertical-align:middle}</style>
<nav class="crumbs"><a href="/">← root</a> · relationships</nav>
<h1>Relationships</h1>
<p class="sub">Closeness across all channels — messages + calls (weighted up, since calling signals closeness) + shared photos + co-present events (🎉, weighted up — physically there) + inferred meetups (🤝, from message evidence). ${hasCalls ? '' : '<b>call data not built yet — run build-calls.</b> '}Not just who you text most.</p>
<table>${li}</table>`);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        viewError(res, 'relationships', e);
      }
    })();
    return;
  }

  // Portrait routes — render markdown server-side as a styled HTML page.
  if (urlPath === '/portraits' || urlPath === '/portraits/') {
    const dir = path.join(ROOT, 'portraits');
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(renderPortraitIndex(dir));
      return;
    }
  }
  if (urlPath.startsWith('/portraits/')) {
    const rest = urlPath.slice('/portraits/'.length);
    const wantsRaw = urlSearch.get('raw') === '1';
    // /portraits/<name> → render <name>.md;  /portraits/<name>.md → render unless ?raw=1
    if (rest && !rest.includes('/')) {
      const slug = rest.endsWith('.md') ? rest.slice(0, -3) : rest;
      const mdPath = path.join(ROOT, 'portraits', slug + '.md');
      if (fs.existsSync(mdPath) && fs.statSync(mdPath).isFile()) {
        const md = fs.readFileSync(mdPath, 'utf-8');
        if (rest.endsWith('.md') && wantsRaw) {
          res.writeHead(200, { 'Content-Type': MIME['.md'] });
          res.end(md);
          return;
        }
        const display = slug.replace(/_/g, ' ');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(renderPortraitHtml(display, md, path.join(ROOT, 'portraits')));
        return;
      }
    }
  }




  // /docs/<path>  →  render <project>/docs/<path>.md as HTML using the portrait shell
  if (urlPath.startsWith('/docs/')) {
    const rest = urlPath.slice('/docs/'.length);
    const wantsRaw = urlSearch.get('raw') === '1';
    if (rest && !rest.includes('..')) {
      const slug = rest.endsWith('.md') ? rest.slice(0, -3) : rest;
      const docsRoot = path.resolve(__dirname, '..', 'docs');
      const mdPath = path.resolve(docsRoot, slug + '.md');
      if (mdPath.startsWith(docsRoot + path.sep) && fs.existsSync(mdPath) && fs.statSync(mdPath).isFile()) {
        const md = fs.readFileSync(mdPath, 'utf-8');
        if (rest.endsWith('.md') && wantsRaw) {
          res.writeHead(200, { 'Content-Type': MIME['.md'] });
          res.end(md);
          return;
        }
        const display = slug.replace(/[_\-/]/g, ' ');
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        // /docs/* gets the inline reflection editor (per-h2/h3 verdict bars).
        res.end(renderPortraitHtml(display, md, path.join(ROOT, 'portraits'), { reflectionDocId: 'doc:' + slug }));
        return;
      }
    }
  }

  // Special endpoint: /photo/<base64url>
  // /thumb/<base64url abs path> — small JPEG thumbnail (handles HEIC via macOS sips), cached. For photo grids.
  if (urlPath.startsWith('/thumb/')) {
    const abs = Buffer.from(urlPath.slice('/thumb/'.length), 'base64url').toString('utf-8');
    // Cache first, validation second: pregenerated thumbs (build-thumbs.js)
    // ship inside releases, so the homelab serves photos without holding the
    // raw archive. The key derives from the request; the bytes are ours.
    const cacheDir = path.join(ROOT, 'thumbs');
    const cached = path.join(cacheDir, crypto.createHash('sha1').update(abs).digest('hex') + '.jpg');
    const sendCached = () => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(cached).pipe(res);
    };
    if (fs.existsSync(cached)) { sendCached(); return; }
    if (!isAllowedPhotoPath(abs)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.mkdirSync(cacheDir, { recursive: true });
    execFile('sips', ['-s', 'format', 'jpeg', '-Z', '320', abs, '--out', cached], { timeout: 20000, killSignal: 'SIGKILL' }, (err) => {
      if (err) { res.writeHead(500); res.end('thumb failed'); return; }
      sendCached();
    });
    return;
  }
  if (urlPath.startsWith('/photo/')) {
    const abs = Buffer.from(urlPath.slice('/photo/'.length), 'base64url').toString('utf-8');
    if (isAllowedPhotoPath(abs)) {
      res.writeHead(200, {
        'Content-Type': mimeFor(abs),
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(abs).pipe(res);
      return;
    }
    // Full-res absent (homelab has no raw archive) — degrade to the shipped
    // thumb rather than a broken image.
    const cached = path.join(ROOT, 'thumbs', crypto.createHash('sha1').update(abs).digest('hex') + '.jpg');
    if (fs.existsSync(cached)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      fs.createReadStream(cached).pipe(res);
      return;
    }
    res.writeHead(403); res.end('forbidden'); return;
  }

  // Normal serve under ROOT
  const safe = path.normalize(path.join(ROOT, urlPath)).replace(/\\/g, '/');
  if (!safe.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (!fs.existsSync(safe)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const stat = fs.statSync(safe);

  if (stat.isDirectory()) {
    // Try index.html
    const indexPath = path.join(safe, 'index.html');
    if (fs.existsSync(indexPath)) {
      const html = rewriteHtmlFileUrls(fs.readFileSync(indexPath, 'utf-8'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(html);
      return;
    }
    // Otherwise list
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(listDirHtml(urlPath, safe));
    return;
  }

  // File
  const mime = mimeFor(safe);
  if (mime.startsWith('text/html')) {
    const html = rewriteHtmlFileUrls(fs.readFileSync(safe, 'utf-8'));
    res.writeHead(200, { 'Content-Type': mime });
    res.end(html);
  } else {
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(safe).pipe(res);
  }
});

const BIND = process.env.HOST || '127.0.0.1';
server.listen(PORT, BIND, () => {
  console.log(`pipeline/output served at http://${BIND}:${PORT}/`);
  console.log(`  portraits: http://${BIND}:${PORT}/portraits/`);
  console.log(`  events:    http://${BIND}:${PORT}/events/`);
});
