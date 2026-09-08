import fs from 'fs';
import path from 'path';

/**
 * Parse WhatsApp chat exports.
 *
 * WhatsApp's "Export chat" produces a .txt file. Format varies by locale; the
 * common shape is:
 *   [DD/MM/YYYY, HH:MM:SS] Sender Name: Message body
 *   (continuation lines have no timestamp prefix)
 *
 * Drop your exported .txt files in inputs/whatsapp/. Naming convention:
 *   "WhatsApp Chat with <Name>.txt"  (1-on-1)
 *   "WhatsApp Chat - <Group Name>.txt"  (group)
 */

// Match: [12/04/2024, 18:23:11] Demo User: hello
// Or:    12/04/2024, 18:23 - Demo User: hello
const ANDROID_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[AP]M)?\s*-\s*([^:]+?):\s*(.*)$/;
const IOS_RE = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[AP]M)?\]\s*([^:]+?):\s*(.*)$/;

function parseTimestamp(dateStr, timeStr) {
  // Heuristic: try DD/MM/YYYY first (international), fall back to MM/DD/YYYY
  const dm = dateStr.split('/');
  let day, month, year;
  if (dm[0].length === 4) {
    [year, month, day] = dm.map(Number);
  } else {
    day = parseInt(dm[0], 10);
    month = parseInt(dm[1], 10);
    year = parseInt(dm[2], 10);
    if (year < 100) year += 2000;
  }
  const [h, mn, sec] = timeStr.split(':').map(Number);
  const dt = new Date(year, (month || 1) - 1, day || 1, h || 0, mn || 0, sec || 0);
  return dt.getTime();
}

export function parseWhatsappFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const filename = path.basename(filePath, '.txt');
  const threadId = `wa:${filename}`;

  // Try to extract participant name from filename
  let other = filename
    .replace(/^WhatsApp Chat (?:with|-)\s*/i, '')
    .trim();
  const isGroup = /group|chat -/i.test(filename);

  const messages = [];
  let idx = 0;
  let current = null;

  for (const line of lines) {
    const m = IOS_RE.exec(line) || ANDROID_RE.exec(line);
    if (m) {
      // Push previous
      if (current) messages.push(current);

      const [, dateStr, timeStr, sender, body] = m;
      const ts = parseTimestamp(dateStr.trim(), timeStr.trim());
      const senderName = sender.trim();

      let attachmentType = null;
      if (/<Media omitted>|image omitted|video omitted|audio omitted|GIF omitted|sticker omitted|document omitted/i.test(body)) {
        attachmentType = 'media';
      }

      current = {
        id: `${threadId}#${idx++}`,
        ts,
        from: senderName === 'Demo User' ? 'me' : 'them',
        senderName,
        body: body.trim(),
        threadId,
        source: 'whatsapp',
        isGroup,
        participants: [other],
        attachmentType,
      };
    } else if (current) {
      // Continuation line
      current.body += '\n' + line;
    }
  }
  if (current) messages.push(current);

  if (messages.length === 0) return null;

  return {
    threadId,
    isGroup,
    participants: [other],
    sources: ['whatsapp'],
    messages,
  };
}

export function parseWhatsappExport(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const threads = [];
  for (const f of fs.readdirSync(dirPath)) {
    if (!f.endsWith('.txt')) continue;
    try {
      const t = parseWhatsappFile(path.join(dirPath, f));
      if (t) threads.push(t);
    } catch (err) {
      console.warn(`WhatsApp: skipping ${f}: ${err.message}`);
    }
  }
  console.log(`WhatsApp: parsed ${threads.length} threads`);
  return threads;
}
