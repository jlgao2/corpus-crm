import fs from 'fs';
import path from 'path';

/**
 * Parse a birthday from a .ics (iCalendar) file.
 *
 * Designed for the output of fb2cal (https://github.com/mobeigi/fb2cal),
 * which produces YEARLY-recurring VEVENT entries like:
 *
 *   BEGIN:VEVENT
 *   UID:b-12345-6789@facebook.com
 *   SUMMARY:Jane Doe's Birthday
 *   DTSTART;VALUE=DATE:20260620
 *   DTEND;VALUE=DATE:20260621
 *   RRULE:FREQ=YEARLY
 *   END:VEVENT
 *
 * Notes:
 * - DTSTART's year reflects the next upcoming birthday, NOT the person's
 *   real birth year. We treat year_known as false for ICS-derived rows.
 * - SUMMARY usually ends with "'s Birthday" or " Birthday" — we strip it.
 *
 * @param {string} text
 * @returns {Array<{name, month, day, year, year_known}>}
 */
export function parseIcsBirthdays(text) {
  const out = [];
  // Unfold long lines — RFC 5545 allows wrapping where a continuation line
  // starts with whitespace.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const events = unfolded.split(/BEGIN:VEVENT/i).slice(1);

  for (const ev of events) {
    const summaryMatch = /^SUMMARY[^:]*:([^\r\n]+)/m.exec(ev);
    const dtstartMatch = /^DTSTART[^:]*:(\d{8})/m.exec(ev);
    if (!summaryMatch || !dtstartMatch) continue;

    let summary = summaryMatch[1].trim();
    // Strip common suffixes
    summary = summary
      .replace(/\\s/gi, ' ')          // ICS escapes
      .replace(/\\,/g, ',')
      .replace(/'s Birthday\s*$/i, '')
      .replace(/Birthday\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!summary) continue;

    const ds = dtstartMatch[1];
    const month = parseInt(ds.slice(4, 6), 10);
    const day = parseInt(ds.slice(6, 8), 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;

    out.push({
      name: summary,
      month,
      day,
      year: null,
      year_known: false,
    });
  }
  return out;
}

/**
 * Load all .ics files from a directory and return a flat birthdays array.
 *
 * @param {string} dir
 * @returns {Array<{name, month, day, year, year_known}>}
 */
export function loadIcsBirthdays(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.ics'));
  const all = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf-8');
      all.push(...parseIcsBirthdays(text));
    } catch (err) {
      console.warn(`birthdays-ics: failed to read ${f}: ${err.message}`);
    }
  }
  return all;
}
