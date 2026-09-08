#!/usr/bin/env node
/**
 * Baileys "linked device" WhatsApp ingester.
 *
 * Usage:
 *   node pipeline/whatsapp-baileys/pair.mjs           # connect, sync, listen indefinitely
 *   node pipeline/whatsapp-baileys/pair.mjs --once    # connect, wait for initial history sync, exit
 *
 * First run: scan the QR shown in the terminal with WhatsApp on your phone:
 *   Settings -> Linked Devices -> Link a Device
 *
 * Subsequent runs reuse the saved auth state under ./auth/.
 *
 * Streams written under ../../inputs/whatsapp-live/raw/:
 *   messages-YYYYMMDD.jsonl  - appended message events (messages.upsert + messaging-history.set messages)
 *   chats.jsonl              - chat metadata snapshots
 *   contacts.jsonl           - contact pushname / name updates
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..', '..');
const AUTH_DIR = path.join(__dirname, 'auth');
const RAW_DIR = path.join(ROOT, 'inputs', 'whatsapp-live', 'raw');

const ONCE = process.argv.includes('--once');

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

function todayStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function appendJsonl(filename, payload) {
  const line = JSON.stringify({ recordedAt: Date.now(), ...payload }) + '\n';
  fs.appendFileSync(path.join(RAW_DIR, filename), line);
}

function appendMessage(payload) {
  appendJsonl(`messages-${todayStamp()}.jsonl`, payload);
}

let messageCount = 0;
let historySyncSeen = false;

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[baileys] using WA web version ${version.join('.')} (latest=${isLatest})`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // we render it ourselves so it works on all baileys versions
    syncFullHistory: true,
    markOnlineOnConnect: false,
    browser: ['Social Graph CRM', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[baileys] Scan this QR with WhatsApp -> Settings -> Linked Devices -> Link a Device:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('[baileys] connection open');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log(`[baileys] connection closed (code=${code}, loggedOut=${loggedOut})`);
      if (loggedOut) {
        console.log('[baileys] device was unlinked. Delete pipeline/whatsapp-baileys/auth/ and re-run to pair again.');
        process.exit(1);
      }
      // Otherwise reconnect.
      if (!ONCE) {
        console.log('[baileys] reconnecting in 3s...');
        setTimeout(() => { main().catch(err => { console.error(err); process.exit(1); }); }, 3000);
      } else {
        process.exit(0);
      }
    }
  });

  sock.ev.on('messaging-history.set', (payload) => {
    const { chats = [], contacts = [], messages = [], isLatest, syncType } = payload;
    console.log(`[baileys] messaging-history.set: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages (isLatest=${isLatest}, syncType=${syncType})`);

    for (const c of chats) appendJsonl('chats.jsonl', { kind: 'history', chat: c });
    for (const c of contacts) appendJsonl('contacts.jsonl', { kind: 'history', contact: c });
    for (const m of messages) {
      appendMessage({ kind: 'history', message: m });
      messageCount++;
    }

    historySyncSeen = true;
    if (ONCE && isLatest !== false) {
      console.log(`[baileys] --once: history sync received (${messageCount} messages). Closing.`);
      // Give the socket a tick to flush, then end.
      setTimeout(() => {
        try { sock.end(undefined); } catch {}
        setTimeout(() => process.exit(0), 500);
      }, 500);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) {
      appendMessage({ kind: 'upsert', type, message: m });
      messageCount++;
    }
  });

  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) appendJsonl('chats.jsonl', { kind: 'upsert', chat: c });
  });

  sock.ev.on('chats.update', (updates) => {
    for (const u of updates) appendJsonl('chats.jsonl', { kind: 'update', chat: u });
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) appendJsonl('contacts.jsonl', { kind: 'upsert', contact: c });
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) appendJsonl('contacts.jsonl', { kind: 'update', contact: u });
  });
}

// One-line status heartbeat every minute.
const heartbeat = setInterval(() => {
  console.log(`[baileys] status: messages received this session = ${messageCount}${historySyncSeen ? ' (history sync done)' : ''}`);
}, 60_000);
heartbeat.unref?.();

process.on('SIGINT', () => {
  console.log(`\n[baileys] SIGINT — shutting down. Total messages this session: ${messageCount}`);
  process.exit(0);
});

main().catch((err) => {
  console.error('[baileys] fatal:', err);
  process.exit(1);
});
