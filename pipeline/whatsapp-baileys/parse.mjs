/**
 * Parse the JSONL streams written by pair.mjs into the pipeline thread/message shape.
 *
 *   inputs/whatsapp-live/raw/messages-YYYYMMDD.jsonl
 *   inputs/whatsapp-live/raw/chats.jsonl
 *   inputs/whatsapp-live/raw/contacts.jsonl
 *
 * threadId convention: `wal:` + jid  (wal = WhatsApp Live; distinct from `wa:` and `wai:`).
 *
 * Output schema (matches pipeline/ingest/imessage.js):
 *   thread  = { threadId, isGroup, participants, sources: ['whatsapp'], messages }
 *   message = { id, ts, from, senderName, body, threadId, source: 'whatsapp', isGroup, participants, attachmentType }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', 'inputs', 'whatsapp-live');

const ME_NAME = 'Demo User';

const SKIP_JID_SUFFIXES = ['@broadcast', '@status', '@newsletter'];

function shouldSkipJid(jid) {
  if (!jid) return true;
  for (const suf of SKIP_JID_SUFFIXES) if (jid.endsWith(suf)) return true;
  return false;
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function phoneFromJid(jid) {
  if (!jid) return null;
  // jid may be like "12025551234@s.whatsapp.net", "12025551234:34@s.whatsapp.net", "12025551234@lid"
  const at = jid.indexOf('@');
  const left = at === -1 ? jid : jid.slice(0, at);
  const colon = left.indexOf(':');
  return colon === -1 ? left : left.slice(0, colon);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf-8');
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // skip malformed
    }
  }
  return out;
}

function listMessageFiles(rawDir) {
  if (!fs.existsSync(rawDir)) return [];
  return fs.readdirSync(rawDir)
    .filter(f => /^messages-\d{8}\.jsonl$/.test(f))
    .sort()
    .map(f => path.join(rawDir, f));
}

/**
 * Build a jid -> display name map from chats.jsonl + contacts.jsonl.
 * Later records override earlier ones (reflecting newer pushnames).
 */
function buildNameMap(rawDir) {
  const names = new Map();

  const setIfBetter = (jid, candidate) => {
    if (!jid || !candidate) return;
    const trimmed = String(candidate).trim();
    if (!trimmed) return;
    const existing = names.get(jid);
    // Prefer non-numeric "real" names over phone-number-shaped strings.
    const candidateIsPhone = /^\+?\d[\d\s\-]*$/.test(trimmed);
    const existingIsPhone = existing ? /^\+?\d[\d\s\-]*$/.test(existing) : false;
    if (!existing) { names.set(jid, trimmed); return; }
    if (existingIsPhone && !candidateIsPhone) names.set(jid, trimmed);
    // else keep existing
  };

  for (const rec of readJsonl(path.join(rawDir, 'chats.jsonl'))) {
    const c = rec.chat || rec;
    if (!c) continue;
    const jid = c.id || c.jid;
    if (!jid) continue;
    setIfBetter(jid, c.name || c.subject);
  }

  for (const rec of readJsonl(path.join(rawDir, 'contacts.jsonl'))) {
    const c = rec.contact || rec;
    if (!c) continue;
    const jid = c.id || c.jid;
    if (!jid) continue;
    setIfBetter(jid, c.name || c.notify || c.verifiedName || c.pushname);
  }

  return names;
}

function getMessageBody(msg) {
  const m = msg?.message;
  if (!m) return { body: '', attachmentType: null };

  // Unwrap ephemeral / view-once / device-sent envelopes.
  const inner =
    m.ephemeralMessage?.message ||
    m.viewOnceMessage?.message ||
    m.viewOnceMessageV2?.message ||
    m.viewOnceMessageV2Extension?.message ||
    m.documentWithCaptionMessage?.message ||
    m.editedMessage?.message ||
    m;

  if (typeof inner.conversation === 'string' && inner.conversation) {
    return { body: inner.conversation, attachmentType: null };
  }
  if (inner.extendedTextMessage?.text) {
    return { body: inner.extendedTextMessage.text, attachmentType: null };
  }
  if (inner.imageMessage) {
    return { body: inner.imageMessage.caption || '<image>', attachmentType: 'image' };
  }
  if (inner.videoMessage) {
    return { body: inner.videoMessage.caption || '<video>', attachmentType: 'video' };
  }
  if (inner.audioMessage) {
    return { body: '<audio>', attachmentType: 'audio' };
  }
  if (inner.stickerMessage) {
    return { body: '<sticker>', attachmentType: 'sticker' };
  }
  if (inner.documentMessage) {
    return { body: inner.documentMessage.caption || `<document:${inner.documentMessage.fileName || ''}>`, attachmentType: 'document' };
  }
  if (inner.contactMessage || inner.contactsArrayMessage) {
    return { body: '<contact>', attachmentType: 'contact' };
  }
  if (inner.locationMessage || inner.liveLocationMessage) {
    return { body: '<location>', attachmentType: 'location' };
  }
  if (inner.reactionMessage) {
    // Reactions carry only a single emoji and a target msg id — usually noise.
    return { body: `<reaction:${inner.reactionMessage.text || ''}>`, attachmentType: 'reaction' };
  }
  if (inner.protocolMessage) {
    // Edits, revokes, key changes, etc. — drop.
    return { body: '', attachmentType: null };
  }
  return { body: '', attachmentType: null };
}

function resolveSenderName(msg, jid, isGroup, nameMap) {
  const fromMe = !!msg?.key?.fromMe;
  if (fromMe) return ME_NAME;

  // For groups, the actual sender jid is in key.participant; for 1-on-1s, it's the chat jid.
  const senderJid = isGroup
    ? (msg?.key?.participant || msg?.participant)
    : jid;

  const pushName = msg?.pushName ? String(msg.pushName).trim() : '';
  const mapped = senderJid ? nameMap.get(senderJid) : null;

  // Prefer real names (chat/contact map) over pushNames over phone fallback.
  if (mapped && !/^\+?\d[\d\s\-]*$/.test(mapped)) return mapped;
  if (pushName) return pushName;
  if (mapped) return mapped;
  if (senderJid) return phoneFromJid(senderJid) || senderJid;
  return 'unknown';
}

function getMessageTs(msg) {
  const t = msg?.messageTimestamp;
  if (t == null) return 0;
  // Baileys sometimes serializes Long as { low, high, unsigned } or as a number/string.
  let secs;
  if (typeof t === 'number') secs = t;
  else if (typeof t === 'string') secs = parseInt(t, 10);
  else if (typeof t === 'object' && 'low' in t) secs = t.low; // good enough through 2038
  else secs = Number(t);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  return secs * 1000;
}

export function parseWhatsappLiveExport(rootDir = DEFAULT_ROOT) {
  const rawDir = path.join(rootDir, 'raw');
  if (!fs.existsSync(rawDir)) {
    console.log(`WhatsApp Live: no raw dir at ${rawDir}, skipping`);
    return [];
  }

  const nameMap = buildNameMap(rawDir);
  const msgFiles = listMessageFiles(rawDir);
  if (msgFiles.length === 0) {
    console.log(`WhatsApp Live: no messages-*.jsonl under ${rawDir}, skipping`);
    return [];
  }

  // Dedupe by jid + key.id + fromMe (Baileys can emit the same message via history + upsert).
  const seen = new Set();
  const byThread = new Map(); // jid -> { jid, isGroup, messages: [] }

  for (const file of msgFiles) {
    for (const rec of readJsonl(file)) {
      const msg = rec.message;
      if (!msg) continue;
      const jid = msg.key?.remoteJid;
      if (!jid || shouldSkipJid(jid)) continue;

      const dedupeKey = `${jid}|${msg.key?.id || ''}|${msg.key?.fromMe ? 1 : 0}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const isGroup = isGroupJid(jid);
      const { body, attachmentType } = getMessageBody(msg);
      if (!body && !attachmentType) continue;

      const ts = getMessageTs(msg);
      const fromMe = !!msg.key?.fromMe;
      const senderName = resolveSenderName(msg, jid, isGroup, nameMap);

      let bucket = byThread.get(jid);
      if (!bucket) {
        bucket = { jid, isGroup, groupSenders: new Set(), messages: [] };
        byThread.set(jid, bucket);
      }
      if (isGroup && senderName && senderName !== ME_NAME) bucket.groupSenders.add(senderName);

      bucket.messages.push({
        ts,
        fromMe,
        senderName,
        body,
        attachmentType,
        msgId: msg.key?.id || null,
      });
    }
  }

  const threads = [];
  let totalMessages = 0;

  for (const [jid, bucket] of byThread) {
    const threadId = `wal:${jid}`;
    const partnerName =
      nameMap.get(jid) ||
      (bucket.isGroup ? jid.replace(/@g\.us$/, '') : phoneFromJid(jid));

    const participants = bucket.isGroup
      ? Array.from(bucket.groupSenders)
      : [partnerName];

    bucket.messages.sort((a, b) => a.ts - b.ts);

    const messages = bucket.messages.map((m, idx) => ({
      id: `${threadId}#${idx}`,
      ts: m.ts,
      from: m.fromMe ? 'me' : 'them',
      senderName: m.fromMe ? ME_NAME : m.senderName,
      body: m.body,
      threadId,
      source: 'whatsapp',
      isGroup: bucket.isGroup,
      participants,
      attachmentType: m.attachmentType,
    }));

    if (messages.length === 0) continue;

    threads.push({
      threadId,
      isGroup: bucket.isGroup,
      participants,
      sources: ['whatsapp'],
      messages,
    });
    totalMessages += messages.length;
  }

  console.log(`WhatsApp Live: parsed ${threads.length} threads (${totalMessages} messages)`);
  return threads;
}

// Allow direct CLI invocation for a quick smoke check:  node parse.mjs
if (import.meta.url === `file://${process.argv[1]}`) {
  const threads = parseWhatsappLiveExport(process.argv[2]);
  console.log(JSON.stringify({
    threads: threads.length,
    messages: threads.reduce((n, t) => n + t.messages.length, 0),
    sample: threads.slice(0, 3).map(t => ({ threadId: t.threadId, isGroup: t.isGroup, participants: t.participants, messageCount: t.messages.length })),
  }, null, 2));
}
