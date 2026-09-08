import fs from 'fs';
import path from 'path';
import { fixMojibake } from '../normalize/schema.js';
import { parseInstagramHtmlThread } from './instagram-html.js';

/**
 * Parse Instagram inbox export.
 *
 * Expected layout:
 *   inputs/instagram/your_instagram_activity/messages/inbox/<thread_id>/message_*.json
 *
 * Optionally merges an HTML-format export (a partial, recent stopgap when the
 * JSON export isn't available) supplied as a second root. For each thread, the
 * HTML messages newer than that thread's latest JSON message are appended; this
 * avoids fuzzy cross-format dedup (the two formats carry timestamps differently)
 * while still capturing the recent tail. See instagram-html.js.
 */

const INBOX_REL = path.join('your_instagram_activity', 'messages', 'inbox');

// Read a thread's JSON message files into raw (un-normalized) messages.
function readJsonThreadRaw(threadDir) {
  const files = fs.readdirSync(threadDir)
    .filter(f => /^message_\d+\.json$/.test(f))
    .map(f => path.join(threadDir, f))
    .sort();
  if (files.length === 0) return null;

  const messages = [];
  let participants = null;
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!participants) participants = (data.participants || []).map(p => fixMojibake(p.name || ''));
    for (const m of data.messages || []) {
      let attachmentType = null;
      if (m.photos) attachmentType = 'image';
      else if (m.videos) attachmentType = 'video';
      else if (m.audio_files) attachmentType = 'audio';
      messages.push({
        ts: m.timestamp_ms,
        senderName: fixMojibake(m.sender_name || ''),
        body: fixMojibake(m.content || ''),
        attachmentType,
      });
    }
  }
  return { participants: participants || [], messages };
}

// Turn raw messages ({ts, senderName, body, attachmentType}) into the normalized
// message shape, sorted by ts with a single contiguous index (stable ids).
function normalizeThread(folder, participants, rawMessages) {
  const others = participants.filter(p => p !== 'Demo User');
  const isGroup = others.length > 1;
  const threadId = `ig:${folder}`;
  const sorted = [...rawMessages].sort((a, b) => a.ts - b.ts);
  const messages = sorted.map((m, idx) => ({
    id: `${threadId}#${idx}`,
    ts: m.ts,
    from: m.senderName === 'Demo User' ? 'me' : 'them',
    senderName: m.senderName,
    body: m.body,
    threadId,
    source: 'instagram',
    isGroup,
    participants: others,
    attachmentType: m.attachmentType ?? null,
  }));
  return { threadId, isGroup, participants: others, sources: ['instagram'], messages };
}

export function parseInstagramThread(threadDir) {
  const raw = readJsonThreadRaw(threadDir);
  if (!raw) return null;
  return normalizeThread(path.basename(threadDir), raw.participants, raw.messages);
}

export function parseInstagramExport(rootDir, htmlRoot = null) {
  const inboxDir = path.join(rootDir, INBOX_REL);
  if (!fs.existsSync(inboxDir)) {
    throw new Error(`Instagram inbox not found at ${inboxDir}`);
  }

  // 1. JSON threads: folder -> { participants, messages }
  const jsonByFolder = new Map();
  for (const dir of fs.readdirSync(inboxDir)) {
    const threadDir = path.join(inboxDir, dir);
    if (!fs.statSync(threadDir).isDirectory()) continue;
    try {
      const raw = readJsonThreadRaw(threadDir);
      if (raw) jsonByFolder.set(dir, raw);
    } catch (err) {
      console.warn(`Skipping ${dir}: ${err.message}`);
    }
  }

  // 2. Optional HTML supplement: folder -> { participants, messages }
  const htmlByFolder = new Map();
  const htmlInbox = htmlRoot ? path.join(htmlRoot, INBOX_REL) : null;
  if (htmlInbox && fs.existsSync(htmlInbox)) {
    for (const dir of fs.readdirSync(htmlInbox)) {
      const threadDir = path.join(htmlInbox, dir);
      if (!fs.statSync(threadDir).isDirectory()) continue;
      try {
        const parsed = parseInstagramHtmlThread(threadDir);
        if (parsed && parsed.messages.length) htmlByFolder.set(dir, parsed);
      } catch (err) {
        console.warn(`Skipping HTML ${dir}: ${err.message}`);
      }
    }
  }

  // 3. Merge per folder: keep all JSON, append only HTML newer than JSON cutoff.
  const threads = [];
  let htmlAdded = 0, supplemented = 0, htmlOnly = 0;
  for (const folder of new Set([...jsonByFolder.keys(), ...htmlByFolder.keys()])) {
    const j = jsonByFolder.get(folder);
    const h = htmlByFolder.get(folder);
    const jsonRaw = j ? j.messages : [];
    const participants = (j && j.participants.length) ? j.participants : (h ? h.participants : []);

    let merged = jsonRaw;
    if (h) {
      const cutoff = jsonRaw.reduce((mx, m) => (m.ts > mx ? m.ts : mx), -Infinity);
      const tail = h.messages.filter(m => m.ts > cutoff);
      if (tail.length) {
        merged = jsonRaw.concat(tail);
        htmlAdded += tail.length;
        if (jsonRaw.length) supplemented++; else htmlOnly++;
      }
    }
    if (!merged.length) continue;
    const thread = normalizeThread(folder, participants, merged);
    if (thread.messages.length > 0) threads.push(thread);
  }

  const suffix = htmlRoot
    ? ` (+${htmlAdded} from HTML: ${supplemented} threads supplemented, ${htmlOnly} html-only)`
    : '';
  console.log(`Instagram: parsed ${threads.length} threads${suffix}`);
  return threads;
}
