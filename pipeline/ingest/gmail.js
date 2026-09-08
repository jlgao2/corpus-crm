/**
 * Gmail mbox ingest — streams the Takeout "All mail" mbox, keeps human
 * (person-to-person) threads, and returns the standard Thread[] contract.
 *
 * Bulk (List-Unsubscribe) and automated (noreply) mail are NOT returned here —
 * they are counted and skipped in Phase 1 (Phase 2 builds interest tables from them).
 *
 * mailparser already decodes RFC-2047 headers + quoted-printable/multipart bodies
 * to correct UTF-8, so we deliberately do NOT apply fixMojibake (that would corrupt it).
 */

import fs from 'fs';
import path from 'path';

// Demo's own email address(es). Self-detection keys on the From ADDRESS, never
// the display name (display names like "Jordan Blake" appeared on Demo's account
// in the export but belong to other people).
export const GEORGE_EMAILS = ['demo.user@example.com'];

// Cap stored body length — email quote-chains can be enormous; keep the DB lean.
const MAX_BODY = 20000;

export function isGeorge(addr, georgeEmails = GEORGE_EMAILS) {
  if (!addr) return false;
  return georgeEmails.includes(String(addr).toLowerCase());
}

export function isNoreply(addr) {
  if (!addr) return false;
  return /(^|[._-])(no-?reply|do-?not-?reply|notifications?|mailer-daemon|bounce)([._-]|@)/i.test(addr);
}

export function parseHeaderBlock(rawHeaders) {
  const map = new Map();
  const lines = String(rawHeaders).split(/\r?\n/);
  let curName = null;
  let curVal = '';
  const commit = () => {
    if (curName == null) return;
    const key = curName.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(curVal.trim());
    curName = null;
    curVal = '';
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && curName != null) {
      curVal += ' ' + line.trim();        // folded continuation
    } else {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      commit();
      curName = line.slice(0, idx);
      curVal = line.slice(idx + 1);
    }
  }
  commit();
  return map;
}

export function headerValue(map, name) {
  const v = map.get(String(name).toLowerCase());
  return v && v.length ? v[0] : null;
}

const ADDR_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

export function allAddresses(value) {
  if (!value) return [];
  const out = [];
  const seen = new Set();
  for (const m of value.matchAll(ADDR_RE)) {
    const a = m[0].toLowerCase();
    if (!seen.has(a)) { seen.add(a); out.push(a); }
  }
  return out;
}

export function firstAddress(value) {
  if (!value) return null;
  // Prefer the angle-bracket address — that's the real sender/recipient. The bare
  // regex would otherwise pick up an address embedded in a quoted display name,
  // e.g. From: "boss@work.com" <demo.user@example.com> must resolve to Demo.
  const angle = value.match(/<([^>]+@[^>]+)>/);
  if (angle) {
    const inner = allAddresses(angle[1])[0];
    if (inner) return inner;
  }
  return allAddresses(value)[0] || null;
}

export function labelsFromHeaders(map) {
  const v = headerValue(map, 'x-gmail-labels');
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

export function domainOf(addr) {
  if (!addr) return null;
  const at = String(addr).lastIndexOf('@');
  if (at === -1 || at === String(addr).length - 1) return null;
  return String(addr).slice(at + 1).toLowerCase();
}

export function displayNameFromHeader(value) {
  if (!value) return null;
  // "Name" <addr> or Name <addr> — the part before the first '<'.
  const lt = value.indexOf('<');
  if (lt === -1) return null;                 // bare address, no display name
  let name = value.slice(0, lt).trim();
  name = name.replace(/^"(.*)"$/, '$1').trim(); // strip surrounding quotes
  return name || null;
}

export function categoryFromLabels(labels) {
  for (const l of labels || []) {
    const m = /^Category\s+(.+)$/i.exec(String(l).trim());
    if (m) return m[1].trim().toLowerCase();
  }
  return null;
}

export function classifyMessage(meta) {
  if (meta.listUnsubscribe) return 'bulk';
  if (isNoreply(meta.fromAddr)) return 'automated';
  return 'human';
}

export function threadKeyFromHeaders(map) {
  const thrid = headerValue(map, 'x-gm-thrid');
  if (thrid) return thrid.trim();
  const refs = headerValue(map, 'references');
  if (refs) {
    const m = refs.match(/<[^>]+>/);
    if (m) return m[0];
  }
  const mid = headerValue(map, 'message-id');
  if (mid) {
    const m = mid.match(/<[^>]+>/);
    return m ? m[0] : mid.trim();
  }
  return 'nothrid';
}

export function buildThreads(records, georgeEmails = GEORGE_EMAILS) {
  const byThrid = new Map();
  for (const r of records) {
    if (!byThrid.has(r.thrid)) byThrid.set(r.thrid, []);
    byThrid.get(r.thrid).push(r);
  }

  const threads = [];
  for (const [thrid, recs] of byThrid) {
    // A thread is human if Demo participated (sent a message) OR it is a reply chain.
    const anyGeorge = recs.some(r => r.fromIsGeorge);
    const anyRefs = recs.some(r => r.hasRefs);
    if (!anyGeorge && !anyRefs) continue;

    // Participants = every non-Demo address seen in From/To/Cc across the thread.
    const partSet = new Set();
    const nameByAddr = new Map();
    for (const r of recs) {
      for (const a of [r.fromAddr, ...r.toAddrs, ...r.ccAddrs]) {
        if (a && !isGeorge(a, georgeEmails)) partSet.add(a);
      }
      if (r.fromAddr && !isGeorge(r.fromAddr, georgeEmails) && r.fromName && !nameByAddr.has(r.fromAddr)) {
        nameByAddr.set(r.fromAddr, r.fromName);
      }
    }
    const participants = [...partSet];
    if (participants.length === 0) continue;     // Demo-only / no other party

    const isGroup = participants.length > 1;
    const threadId = `gmail:${thrid}`;
    recs.sort((a, b) => a.ts - b.ts);

    const messages = recs.map((r, idx) => {
      const fromIsGeorge = r.fromIsGeorge;
      return {
        id: `${threadId}#${idx}`,
        ts: r.ts,
        from: fromIsGeorge ? 'me' : 'them',
        senderName: fromIsGeorge ? 'Demo User' : (r.fromName || r.fromAddr || '(unknown)'),
        body: (r.text || '').slice(0, MAX_BODY),
        threadId,
        source: 'gmail',
        isGroup,
        participants,
        attachmentType: null,
      };
    });

    const thread = { threadId, isGroup, participants, sources: ['gmail'], messages };
    if (!isGroup) thread.otherDisplayName = nameByAddr.get(participants[0]) || null;
    threads.push(thread);
  }
  return threads;
}

import { mboxReader } from 'mbox-reader';
import { simpleParser } from 'mailparser';

function splitHeaderBlock(buf) {
  const s = buf.toString('utf8');
  const sep = s.search(/\r?\n\r?\n/);
  return sep === -1 ? s : s.slice(0, sep);
}

function hasSpamOrTrash(labels) {
  return labels.some(l => /^(spam|trash|bin)$/i.test(l.trim()));
}

// mailparser returns address fields (from/to/cc) as a single AddressObject
// { value: [{address,name},...] } — OR, when a message has multiple header lines
// of the same type (e.g. two `To:` lines), as an ARRAY of AddressObjects.
// Normalize both shapes to a flat list of lowercased addresses.
export function addressList(field) {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const out = [];
  for (const o of objs) {
    for (const v of (o && o.value) || []) {
      if (v && v.address) out.push(String(v.address).toLowerCase());
    }
  }
  return out;
}

// First address object (with its display name) across the single-or-array shape.
export function firstAddressObj(field) {
  if (!field) return null;
  const objs = Array.isArray(field) ? field : [field];
  for (const o of objs) {
    for (const v of (o && o.value) || []) {
      if (v && v.address) return v;
    }
  }
  return null;
}

export async function streamGmail(rootDir, opts = {}) {
  const georgeEmails = opts.georgeEmails || GEORGE_EMAILS;
  const empty = { threads: [], correspondents: [], emailMeta: [], counts: { total: 0, human: 0, bulk: 0, automated: 0, skipped_label: 0 } };
  if (!fs.existsSync(rootDir)) return empty;
  const mboxName = fs.readdirSync(rootDir).find(f => f.toLowerCase().endsWith('.mbox'));
  if (!mboxName) {
    console.log(`Gmail: no .mbox in ${rootDir}, skipping`);
    return empty;
  }
  const mboxPath = path.join(rootDir, mboxName);

  const records = [];
  const corr = new Map();            // addr -> correspondent accumulator
  const emailMeta = [];
  const counts = { total: 0, human: 0, bulk: 0, automated: 0, skipped_label: 0 };
  let noMsgId = 0;

  const stream = fs.createReadStream(mboxPath);
  for await (const message of mboxReader(stream)) {
    counts.total++;
    const buf = Buffer.from(message.content);
    const headers = parseHeaderBlock(splitHeaderBlock(buf));

    const labels = labelsFromHeaders(headers);
    if (hasSpamOrTrash(labels)) { counts.skipped_label++; continue; }

    const fromHeader = headerValue(headers, 'from');
    const fromAddr = firstAddress(fromHeader);
    const listUnsub = headers.has('list-unsubscribe');
    const kind = classifyMessage({ listUnsubscribe: listUnsub, fromAddr });

    if (kind !== 'human') {
      // ── Bulk/automated: capture from HEADERS only (no expensive simpleParser) ──
      counts[kind]++;
      const dateHdr = headerValue(headers, 'date');
      let ts = dateHdr ? new Date(dateHdr).getTime() : (message.time ? new Date(message.time).getTime() : 0);
      if (!Number.isFinite(ts)) ts = 0;

      if (fromAddr) {
        const acc = corr.get(fromAddr) || {
          addr: fromAddr,
          display_name: displayNameFromHeader(fromHeader),
          domain: domainOf(fromAddr),
          n_messages: 0,
          first_ts: null,
          last_ts: null,
          list_unsubscribe: false,
          _labels: new Set(),
        };
        acc.n_messages++;
        if (ts) {
          acc.first_ts = acc.first_ts == null ? ts : Math.min(acc.first_ts, ts);
          acc.last_ts = acc.last_ts == null ? ts : Math.max(acc.last_ts, ts);
        }
        if (listUnsub) acc.list_unsubscribe = true;
        if (!acc.display_name) acc.display_name = displayNameFromHeader(fromHeader);
        for (const l of labels) acc._labels.add(l);
        corr.set(fromAddr, acc);
      }

      const midRaw = headerValue(headers, 'message-id');
      const midMatch = midRaw && midRaw.match(/<[^>]+>/);
      const message_id = midMatch ? midMatch[0] : (midRaw ? midRaw.trim() : `nomsgid:${noMsgId++}`);
      const irtRaw = headerValue(headers, 'in-reply-to');
      const irtMatch = irtRaw && irtRaw.match(/<[^>]+>/);
      emailMeta.push({
        message_id,
        x_gm_thrid: headerValue(headers, 'x-gm-thrid'),
        labels,
        category: categoryFromLabels(labels),
        in_reply_to: irtMatch ? irtMatch[0] : null,
        kind,
      });
      continue;
    }

    // ── Human: full-parse for clean names + decoded body (unchanged from Phase 1) ──
    counts.human++;
    let rec;
    try {
      const parsed = await simpleParser(buf);
      const fromObj = firstAddressObj(parsed.from);
      const recFromAddr = (fromObj && fromObj.address ? fromObj.address : fromAddr || '').toLowerCase();
      const ts = parsed.date ? parsed.date.getTime()
               : (message.time ? new Date(message.time).getTime() : 0);
      rec = {
        thrid: threadKeyFromHeaders(headers),
        ts: Number.isFinite(ts) ? ts : 0,
        fromAddr: recFromAddr || null,
        fromName: (fromObj && fromObj.name) ? fromObj.name : null,
        fromIsGeorge: isGeorge(recFromAddr, georgeEmails),
        toAddrs: addressList(parsed.to),
        ccAddrs: addressList(parsed.cc),
        text: parsed.text || '',
        hasRefs: headers.has('in-reply-to') || headers.has('references'),
      };
    } catch (err) {
      continue; // unparseable message — skip rather than abort the whole import
    }
    records.push(rec);
  }

  const threads = buildThreads(records, georgeEmails);
  const correspondents = [...corr.values()].map(a => ({
    addr: a.addr,
    display_name: a.display_name,
    domain: a.domain,
    kind: a.list_unsubscribe ? 'bulk' : 'automated',
    n_messages: a.n_messages,
    first_ts: a.first_ts,
    last_ts: a.last_ts,
    list_unsubscribe: a.list_unsubscribe,
    top_labels: [...a._labels].slice(0, 12),
  }));

  console.log(
    `Gmail: ${counts.total} messages — ${counts.human} human, ${counts.bulk} bulk, `
    + `${counts.automated} automated, ${counts.skipped_label} spam/trash → `
    + `${threads.length} human threads, ${correspondents.length} bulk correspondents`
  );
  return { threads, correspondents, emailMeta, counts };
}

// Backward-compatible wrapper — Phase-1 callers/tests expect just the threads.
export async function parseGmailExport(rootDir, opts = {}) {
  return (await streamGmail(rootDir, opts)).threads;
}
