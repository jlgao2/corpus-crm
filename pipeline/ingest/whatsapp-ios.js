import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Parse an extracted iOS WhatsApp App-Group backup directly from
 * ChatStorage.sqlite. Emits the same thread/message shape as the other
 * ingest modules.
 *
 * Pass the directory containing ChatStorage.sqlite (typically the project's
 * `whatsapp/` dir or `inputs/whatsapp-ios/`).
 */

// Apple Core Data reference date: 2001-01-01 UTC, in unix seconds.
const APPLE_EPOCH_OFFSET_S = 978307200;

const ATTACHMENT_TYPE_BY_MSGTYPE = {
  1: 'image',
  2: 'video',
  3: 'audio',
  4: 'contact',
  5: 'location',
  7: 'link',
  8: 'document',
  11: 'image',
};

const MEDIA_BODY_PLACEHOLDER = {
  image: '<image>',
  video: '<video>',
  audio: '<audio>',
  contact: '<contact>',
  location: '<location>',
  link: '<link>',
  document: '<document>',
};

function phoneFromJid(jid) {
  if (!jid) return null;
  const at = jid.indexOf('@');
  return at === -1 ? jid : jid.slice(0, at);
}

function appleTsToUnixMs(coreDataTs) {
  if (coreDataTs == null) return 0;
  return Math.round((Number(coreDataTs) + APPLE_EPOCH_OFFSET_S) * 1000);
}

export function parseWhatsappIosBackup(rootDir) {
  const dbPath = path.join(rootDir, 'ChatStorage.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.log(`WhatsApp iOS: no ChatStorage.sqlite at ${rootDir}`);
    return [];
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });

  const sessions = db.prepare(`
    SELECT Z_PK, ZPARTNERNAME, ZCONTACTJID, ZSESSIONTYPE
    FROM ZWACHATSESSION
    WHERE ZCONTACTJID IS NOT NULL
      AND ZCONTACTJID NOT LIKE '%@status'
  `).all();

  const groupMembers = db.prepare(`
    SELECT Z_PK, ZMEMBERJID, ZCONTACTNAME, ZCHATSESSION
    FROM ZWAGROUPMEMBER
  `).all();
  const groupMemberById = new Map();
  for (const gm of groupMembers) groupMemberById.set(gm.Z_PK, gm);

  const messageStmt = db.prepare(`
    SELECT Z_PK, ZCHATSESSION, ZMESSAGEDATE, ZTEXT, ZFROMJID, ZISFROMME,
           ZGROUPMEMBER, ZMESSAGETYPE, ZPUSHNAME, ZSTANZAID
    FROM ZWAMESSAGE
    WHERE ZCHATSESSION = ?
    ORDER BY ZMESSAGEDATE ASC
  `);

  const threads = [];
  let totalMessages = 0;

  for (const s of sessions) {
    const jid = s.ZCONTACTJID;
    const isGroup = jid.endsWith('@g.us');
    const threadId = `wai:${jid}`;

    const partnerName =
      (s.ZPARTNERNAME && s.ZPARTNERNAME.trim()) ||
      (isGroup ? jid : phoneFromJid(jid));

    const rawMsgs = messageStmt.all(s.Z_PK);

    const messages = [];
    const groupSenderNames = new Set();
    let idx = 0;

    for (const r of rawMsgs) {
      const mt = r.ZMESSAGETYPE;
      // 6 = system/group event, 10 = call info — drop entirely.
      if (mt === 6 || mt === 10) continue;

      const attachmentType = ATTACHMENT_TYPE_BY_MSGTYPE[mt] || null;
      const text = r.ZTEXT;

      // Drop type 11 (sticker/gif) with no body — pure stickers carry no signal.
      if (mt === 11 && (!text || !text.trim())) continue;

      let body = text != null ? String(text) : '';
      if (!body.trim() && attachmentType) {
        body = MEDIA_BODY_PLACEHOLDER[attachmentType] || '';
      }
      if (!body && !attachmentType) continue;

      const fromMe = r.ZISFROMME === 1;

      let senderName;
      if (fromMe) {
        senderName = 'Demo User';
      } else if (isGroup) {
        const gm = r.ZGROUPMEMBER ? groupMemberById.get(r.ZGROUPMEMBER) : null;
        const gmName = gm && gm.ZCONTACTNAME ? gm.ZCONTACTNAME.trim() : '';
        const pushName = r.ZPUSHNAME ? String(r.ZPUSHNAME).trim() : '';
        senderName =
          gmName ||
          pushName ||
          (gm && gm.ZMEMBERJID ? phoneFromJid(gm.ZMEMBERJID) : null) ||
          (r.ZFROMJID ? phoneFromJid(r.ZFROMJID) : 'unknown');
      } else {
        senderName = partnerName;
      }

      if (isGroup) groupSenderNames.add(senderName);

      messages.push({
        id: `${threadId}#${idx++}`,
        ts: appleTsToUnixMs(r.ZMESSAGEDATE),
        from: fromMe ? 'me' : 'them',
        senderName,
        body,
        threadId,
        source: 'whatsapp',
        isGroup,
        participants: null, // filled in below once we know the full set
        attachmentType,
      });
    }

    if (messages.length === 0) continue;

    const participants = isGroup
      ? Array.from(groupSenderNames).filter(n => n && n !== 'Demo User')
      : [partnerName];

    for (const m of messages) m.participants = participants;

    messages.sort((a, b) => a.ts - b.ts);

    threads.push({
      threadId,
      isGroup,
      participants,
      sources: ['whatsapp'],
      messages,
    });
    totalMessages += messages.length;
  }

  db.close();

  console.log(`WhatsApp iOS: parsed ${threads.length} threads (${totalMessages} messages)`);
  return threads;
}
