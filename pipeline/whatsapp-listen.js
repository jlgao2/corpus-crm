#!/usr/bin/env node
// Read-only WhatsApp capture — appends incoming/outgoing messages to the
// JSONL spool that ingest/whatsapp-live.js reads. Session persists in
// inputs/whatsapp-live/auth (QR scan once, in a terminal:
//   npm run whatsapp:listen
// then install the launchd agent to keep it running headless).
//
// Baileys speaks the unofficial WhatsApp Web protocol; this listener only
// listens — it never sends, reads receipts, or changes presence.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(__dirname, '..', 'inputs', 'whatsapp-live', 'raw');
const AUTH_DIR = path.join(__dirname, '..', 'inputs', 'whatsapp-live', 'auth');
fs.mkdirSync(RAW_DIR, { recursive: true });

function spoolFile() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return path.join(RAW_DIR, `messages-${ymd}.jsonl`);
}

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // A stale pinned WA Web version gets a 405 before any QR is issued —
  // negotiate the current one every start.
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ auth: state, version, printQRInTerminal: false, markOnlineOnConnect: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('[whatsapp-listen] scan this QR with WhatsApp → Linked Devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') console.log('[whatsapp-listen] connected');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('[whatsapp-listen] logged out — delete inputs/whatsapp-live/auth and re-scan');
        process.exit(1);
      }
      console.log(`[whatsapp-listen] disconnected (${code}) — reconnecting in 5s`);
      setTimeout(start, 5000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    const file = spoolFile();
    for (const message of messages) {
      append(file, { recordedAt: Date.now(), kind: 'upsert', type, message });
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    const file = path.join(RAW_DIR, 'contacts.jsonl');
    for (const c of contacts) {
      if (c.id && (c.name || c.notify)) append(file, { id: c.id, name: c.name || c.notify });
    }
  });
}

start().catch((e) => { console.error('[whatsapp-listen] fatal:', e.message); process.exit(1); });
