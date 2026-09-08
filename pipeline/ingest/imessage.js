import fs from 'fs';
import path from 'path';

/**
 * Parse imessage-exporter txt output.
 *
 * Expected layout:
 *   inputs/imessage/<phone or email>.txt
 *
 * Format of each block:
 *   Mon DD, YYYY  H:MM:SS AM/PM (Read by ...)
 *   Sender Name (or "Me")
 *   Message body (possibly multi-line)
 *   <blank line>
 */

const DATE_RE = /^([A-Z][a-z]{2} \d{1,2}, \d{4}\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M)/;

const MONTH_TO_NUM = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseDate(s) {
  // "Mon DD, YYYY  H:MM:SS AM/PM"
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP])M/.exec(s);
  if (!m) return 0;
  const [, mon, d, y, h12, mn, sec, ap] = m;
  let h = parseInt(h12, 10);
  if (ap === 'P' && h !== 12) h += 12;
  if (ap === 'A' && h === 12) h = 0;
  const dt = new Date(parseInt(y, 10), MONTH_TO_NUM[mon], parseInt(d, 10), h, parseInt(mn, 10), parseInt(sec, 10));
  return dt.getTime();
}

export function parseImessageThread(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath, '.txt');
  const isGroup = filename.includes(',') || filename.includes(' - ');
  const threadId = `imsg:${filename}`;

  const blocks = text.split(/\n\n+/);
  const messages = [];

  let idx = 0;
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim());
    if (lines.length < 2) continue;
    if (!DATE_RE.test(lines[0])) continue;

    const ts = parseDate(lines[0]);
    const senderRaw = lines[1].trim();
    const body = lines.slice(2).join('\n').trim();

    if (!body) continue;

    // Skip Tapback acknowledgments and attachment markers
    if (/^Tapback/.test(body)) continue;
    let attachmentType = null;
    if (/Library\/Messages\/Attachments/.test(body)) {
      if (/\.(?:heic|jpe?g|png|gif|webp)/i.test(body)) attachmentType = 'image';
      else if (/\.(?:mov|mp4|webm)/i.test(body)) attachmentType = 'video';
      else attachmentType = 'other';
    }

    messages.push({
      id: `${threadId}#${idx++}`,
      ts,
      from: senderRaw === 'Me' ? 'me' : 'them',
      senderName: senderRaw === 'Me' ? 'Demo User' : senderRaw,
      body,
      threadId,
      source: 'imessage',
      isGroup,
      participants: isGroup ? filename.split(',').map(s => s.trim()) : [filename],
      attachmentType,
    });
  }

  if (messages.length === 0) return null;

  return {
    threadId,
    isGroup,
    participants: messages[0].participants,
    sources: ['imessage'],
    messages: messages.sort((a, b) => a.ts - b.ts),
  };
}

export function parseImessageExport(dirPath) {
  const threads = [];
  for (const f of fs.readdirSync(dirPath)) {
    if (!f.endsWith('.txt')) continue;
    try {
      const t = parseImessageThread(path.join(dirPath, f));
      if (t && t.messages.length > 0) threads.push(t);
    } catch (err) {
      console.warn(`Skipping ${f}: ${err.message}`);
    }
  }
  console.log(`iMessage: parsed ${threads.length} threads`);
  return threads;
}
