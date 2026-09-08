// WhatsApp live-capture reader — merges the baileys listener's JSONL spool
// (inputs/whatsapp-live/raw/messages-*.jsonl) into the whatsapp-ios backup
// threads as a recent-tail supplement, the same pattern as the instagram
// HTML export. Per-thread ts floor dedupes the overlap window; baileys
// message ids keep re-parses idempotent.

import fs from 'node:fs';
import path from 'node:path';

const SELF_NAME = 'Demo User';

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`invalid JSONL at ${file}:${index + 1}: ${error.message}`);
    }
  }
  return records;
}

// Multiple computers can capture on the same date. Sync stores each machine's
// spool under its own subdirectory so same-day files never overwrite one
// another; recurse while ignoring rsync's hidden partial-transfer directory.
function findSpoolFiles(rawDir, basenamePattern) {
  if (!fs.existsSync(rawDir)) return [];
  const found = [];
  const pending = [rawDir];

  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile() && basenamePattern.test(entry.name)) found.push(item);
    }
  }

  return found.sort();
}

/** Unwrap ephemeral/viewOnce containers and extract a text body + attachment type. */
function extractBody(content) {
  if (!content) return null;
  const inner = content.ephemeralMessage?.message ?? content.viewOnceMessage?.message ?? content;
  if (inner.conversation) return { body: inner.conversation, attachmentType: null };
  if (inner.extendedTextMessage?.text) return { body: inner.extendedTextMessage.text, attachmentType: null };
  if (inner.imageMessage) return { body: inner.imageMessage.caption || '[photo]', attachmentType: 'image' };
  if (inner.videoMessage) return { body: inner.videoMessage.caption || '[video]', attachmentType: 'video' };
  if (inner.audioMessage) return { body: '[voice message]', attachmentType: 'audio' };
  if (inner.documentMessage) return { body: inner.documentMessage.fileName || '[document]', attachmentType: 'document' };
  return null; // protocol/reaction/receipt noise
}

export function parseWhatsappLive(rawDir, iosThreads = []) {
  const byThread = new Map(iosThreads.map((t) => [t.threadId, t]));
  const floors = new Map(iosThreads.map((t) => [
    t.threadId, Math.max(0, ...t.messages.map((m) => m.ts)),
  ]));
  const contacts = new Map();
  for (const file of findSpoolFiles(rawDir, /^contacts\.jsonl$/)) {
    for (const contact of readJsonl(file)) {
      if (contact.id && contact.name) contacts.set(contact.id, contact.name);
    }
  }

  const files = findSpoolFiles(rawDir, /^messages-\d{8}(?:-[A-Za-z0-9._-]+)?\.jsonl$/);
  const seenIds = new Set();
  let added = 0;

  for (const file of files) {
    for (const event of readJsonl(file)) {
      const m = event.message;
      if (event.kind !== 'upsert' || !m?.key?.remoteJid) continue;
      const extracted = extractBody(m.message);
      if (!extracted) continue;
      const jid = m.key.remoteJid;
      if (jid === 'status@broadcast') continue;
      const threadId = `wai:${jid}`;
      const ts = Number(m.messageTimestamp) * 1000;
      if (ts <= (floors.get(threadId) ?? 0)) continue;
      const id = `${threadId}#${m.key.id}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const isGroup = jid.endsWith('@g.us');
      const fromMe = !!m.key.fromMe;
      const contactName = contacts.get(jid);
      const senderName = fromMe ? SELF_NAME
        : (isGroup ? (m.pushName || 'unknown') : (contactName || m.pushName || jid.split('@')[0]));

      if (!byThread.has(threadId)) {
        byThread.set(threadId, {
          threadId,
          isGroup,
          participants: [],
          sources: ['whatsapp'],
          messages: [],
        });
      }
      const thread = byThread.get(threadId);
      thread.messages.push({
        id,
        ts,
        from: fromMe ? 'me' : 'them',
        senderName,
        body: extracted.body,
        threadId,
        source: 'whatsapp',
        isGroup,
        participants: null,
        attachmentType: extracted.attachmentType,
      });
      added++;
    }
  }

  const threads = [...byThread.values()];
  for (const t of threads) {
    const names = new Set(t.participants);
    for (const m of t.messages) {
      if (m.senderName && m.senderName !== SELF_NAME) names.add(m.senderName);
    }
    t.participants = [...names];
    for (const m of t.messages) m.participants = t.participants;
    t.messages.sort((a, b) => a.ts - b.ts);
  }
  console.log(`WhatsApp live: merged ${added} messages from ${files.length} spool file(s)`);
  return threads;
}
