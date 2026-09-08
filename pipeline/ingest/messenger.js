import fs from 'fs';
import path from 'path';
import { fixMojibake } from '../normalize/schema.js';

/**
 * Parse Facebook Messenger JSON export.
 *
 * Same shape as Instagram (Meta uses the same exporter):
 *   inputs/messenger/messages/inbox/<thread_id>/message_*.json
 */

export function parseMessengerThread(threadDir) {
  const files = fs.readdirSync(threadDir)
    .filter(f => /^message_\d+\.json$/.test(f))
    .sort()
    .map(f => path.join(threadDir, f));

  if (files.length === 0) return null;

  const allMessages = [];
  let participants = null;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!participants) participants = (data.participants || []).map(p => fixMojibake(p.name || ''));
    for (const m of data.messages || []) allMessages.push(m);
  }

  allMessages.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const others = participants.filter(p => p !== 'Demo User');
  const isGroup = others.length > 1;
  const threadId = `fb:${path.basename(threadDir)}`;

  const normalized = allMessages.map((m, idx) => {
    const senderName = fixMojibake(m.sender_name || '');
    const body = fixMojibake(m.content || '');
    let attachmentType = null;
    if (m.photos) attachmentType = 'image';
    else if (m.videos) attachmentType = 'video';
    else if (m.audio_files) attachmentType = 'audio';

    return {
      id: `${threadId}#${idx}`,
      ts: m.timestamp_ms,
      from: senderName === 'Demo User' ? 'me' : 'them',
      senderName,
      body,
      threadId,
      source: 'messenger',
      isGroup,
      participants: others,
      attachmentType,
    };
  });

  return {
    threadId,
    isGroup,
    participants: others,
    sources: ['messenger'],
    messages: normalized,
  };
}

// Meta's incremental exports overlap older exports but are not supersets of
// them. Merge at message granularity so a short incremental export can add a
// recent tail without replacing the older history for the same thread.
//
// Meta does not expose a durable message id in these JSON exports. The same
// exact tuple is stable across repeated exports and matches the strategy used
// by the Instagram multi-root ingester.
function messageKey(message) {
  return JSON.stringify([
    Number(message.ts),
    message.senderName || '',
    message.body || '',
    message.attachmentType || '',
  ]);
}

function mergeMessengerThreads(threads) {
  const byId = new Map();

  for (const thread of threads) {
    let merged = byId.get(thread.threadId);
    if (!merged) {
      merged = {
        threadId: thread.threadId,
        participants: new Set(),
        messages: new Map(),
      };
      byId.set(thread.threadId, merged);
    }

    for (const participant of thread.participants || []) {
      if (participant && participant !== 'Demo User') merged.participants.add(participant);
    }
    const messagesInThisCopy = new Map();
    for (const message of thread.messages || []) {
      if (message.senderName && message.senderName !== 'Demo User') {
        merged.participants.add(message.senderName);
      }
      const key = messageKey(message);
      if (!messagesInThisCopy.has(key)) messagesInThisCopy.set(key, []);
      messagesInThisCopy.get(key).push(message);
    }

    // Use a multiset union: repeated exports should not multiply messages, but
    // two genuinely identical messages inside one export must remain two.
    for (const [key, messages] of messagesInThisCopy) {
      const current = merged.messages.get(key);
      if (!current || messages.length > current.length) {
        merged.messages.set(key, messages);
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => a.threadId.localeCompare(b.threadId))
    .map((entry) => {
      const participants = [...entry.participants].sort((a, b) => a.localeCompare(b));
      const isGroup = participants.length > 1;
      const messages = [...entry.messages.entries()]
        .flatMap(([key, copies]) => copies.map((message, copyIndex) => ({ key, message, copyIndex })))
        .sort((a, b) => (a.message.ts - b.message.ts)
          || a.key.localeCompare(b.key)
          || (a.copyIndex - b.copyIndex))
        .map(({ message }, index) => ({
          ...message,
          id: `${entry.threadId}#${index}`,
          threadId: entry.threadId,
          source: 'messenger',
          isGroup,
          participants,
        }));

      return {
        threadId: entry.threadId,
        isGroup,
        participants,
        sources: ['messenger'],
        messages,
      };
    });
}

// Locate all message-folder roots under a Meta export. The standard layout is
// <rootDir>/your_facebook_activity/messages/<bucket>/<thread>/message_*.json
// where bucket can be:
//   inbox             — primary inbox (always parsed historically)
//   e2ee_cutover      — end-to-end-encrypted cutover threads (Meta migrated to E2EE in 2023-2024;
//                       active 1-on-1s post-migration land here, NOT in inbox)
//   archived_threads  — archived but not deleted
//   filtered_threads  — mostly spam/promo
//   message_requests  — pending requests from non-friends
//
// Older / Instagram-style exports use <rootDir>/messages/<bucket>/...
//
// We scan all of these so the corpus is complete. e2ee_cutover is the big one — without
// it, the canonical FB-Messenger 1-on-1 with anyone whose account is currently active
// will be missing from the export.
const BUCKETS = ['inbox', 'e2ee_cutover', 'archived_threads', 'filtered_threads', 'message_requests'];

function findBucketDirs(rootDir) {
  const candidates = [];
  for (const bucket of BUCKETS) {
    const a = path.join(rootDir, 'messages', bucket);
    if (fs.existsSync(a)) candidates.push({ bucket, dir: a });
    const b = path.join(rootDir, 'your_facebook_activity', 'messages', bucket);
    if (fs.existsSync(b)) candidates.push({ bucket, dir: b });
  }
  return candidates;
}

export function parseMessengerExport(rootDir) {
  const bucketDirs = findBucketDirs(rootDir);
  if (!bucketDirs.length) {
    console.log(`Messenger: no message buckets under ${rootDir}, skipping`);
    return [];
  }
  const threads = [];
  const counts = {};
  for (const { bucket, dir } of bucketDirs) {
    let n = 0;
    for (const sub of fs.readdirSync(dir).sort()) {
      const threadDir = path.join(dir, sub);
      if (!fs.statSync(threadDir).isDirectory()) continue;
      try {
        const t = parseMessengerThread(threadDir);
        if (t && t.messages.length > 0) { threads.push(t); n++; }
      } catch (err) {
        console.warn(`Messenger: skipping ${bucket}/${sub}: ${err.message}`);
      }
    }
    counts[bucket] = n;
  }
  const merged = mergeMessengerThreads(threads);
  console.log(`Messenger: parsed ${merged.length} threads from ${path.basename(rootDir)} (${Object.entries(counts).map(([k,v]) => k+':'+v).join(', ')})`);
  return merged;
}

/**
 * Aggregate threads from all Messenger/FB exports across known locations.
 * Meta splits large exports across multiple zip chunks; this scans all of them.
 *
 * Probed roots, in order:
 *   - inputsDir/messenger      (canonical drop)
 *   - inputsDir/facebook-XYZ   (Accounts Center chunks, current pattern)
 *   - projectRoot/facebook-XYZ (legacy unpacked at root)
 *   - projectRoot/messenger    (legacy alternate)
 *
 * Threads repeated across chunks or exports are merged message-by-message.
 *
 * @param {string} inputsDir   absolute path to ./inputs
 * @param {string} projectRoot absolute path to project root (parent of inputs)
 * @returns {Array} merged thread list
 */
export function parseAllMessengerExports(inputsDir, projectRoot) {
  // Expand a candidate root into actual export roots. A "root" is any directory that
  // contains EITHER a `messages/<bucket>/` or `your_facebook_activity/messages/<bucket>/`
  // tree directly. If a candidate is a container of chunks (e.g. inputs/messenger pointing
  // at a folder containing chunk-AAA/, chunk-BBB/), we descend one level and treat each
  // chunk as its own root.
  function expand(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    // Direct hit: this directory contains at least one supported bucket.
    if (findBucketDirs(dir).length > 0) {
      return [dir];
    }
    // Otherwise — does it contain chunk-XYZ subdirs that ARE export roots?
    const out = [];
    for (const sub of fs.readdirSync(dir).sort()) {
      const subDir = path.join(dir, sub);
      if (!fs.statSync(subDir).isDirectory()) continue;
      if (findBucketDirs(subDir).length > 0) {
        out.push(subDir);
      }
    }
    return out;
  }

  const roots = [];
  const seenRoots = new Set();
  const addRoots = (dir) => {
    for (const root of expand(dir)) {
      const real = fs.realpathSync(root);
      if (seenRoots.has(real)) continue;
      seenRoots.add(real);
      roots.push(root);
    }
  };

  addRoots(path.join(inputsDir, 'messenger'));
  if (fs.existsSync(inputsDir)) {
    for (const d of fs.readdirSync(inputsDir).sort()) {
      if (/^facebook-/.test(d) && fs.statSync(path.join(inputsDir, d)).isDirectory()) {
        addRoots(path.join(inputsDir, d));
      }
    }
  }
  if (projectRoot && fs.existsSync(projectRoot)) {
    for (const d of fs.readdirSync(projectRoot).sort()) {
      if (/^(facebook-|messenger$)/i.test(d) && fs.statSync(path.join(projectRoot, d)).isDirectory()) {
        addRoots(path.join(projectRoot, d));
      }
    }
  }
  if (!roots.length) {
    console.log('Messenger: no exports detected');
    return [];
  }
  const all = [];
  for (const r of roots) {
    all.push(...parseMessengerExport(r));
  }
  const merged = mergeMessengerThreads(all);
  console.log(`Messenger: ${merged.length} unique threads across ${roots.length} export root(s)`);
  return merged;
}
