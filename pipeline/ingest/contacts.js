import fs from 'fs';

/**
 * Parse a vCard (.vcf) file and produce a phone/email -> name map.
 *
 * Apple's vCard exports include phone numbers in TEL: fields, sometimes in
 * NOTE: text, sometimes with item1.TEL: prefixes for non-default labels, and
 * occasionally with directional unicode marks. This parser handles those.
 */

function stripControlChars(s) {
  return [...s].filter(c => c.codePointAt(0) >= 0x20 || c === '\n' || c === '\r' || c === '\t').join('');
}

function digitsOnly(s) {
  return s.replace(/\D/g, '');
}

/**
 * Parse Apple's BDAY format which uses 1604 as a sentinel for "year unknown."
 * Returns { month, day, year, year_known } or null if unparseable.
 *
 * Examples:
 *   BDAY:1998-06-20                          → { 1998, 6, 20, true }
 *   BDAY;X-APPLE-OMIT-YEAR=1604:1604-10-26   → { null, 10, 26, false }
 *   BDAY:--04-15                             → { null, 4, 15, false }
 */
export function parseBday(rawBdayLine) {
  // rawBdayLine is the value AFTER the colon, e.g. "1998-06-20" or "1604-10-26"
  // The "year unknown" parameter is on the property: BDAY;X-APPLE-OMIT-YEAR=1604:...
  const trimmed = String(rawBdayLine || '').trim();

  // YYYY-MM-DD with year-unknown indicator (year=1604)
  const m1 = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (m1) {
    const [, yyyy, mm, dd] = m1;
    const year = parseInt(yyyy, 10);
    const month = parseInt(mm, 10);
    const day = parseInt(dd, 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (year === 1604) {
      return { year: null, month, day, year_known: false };
    }
    return { year, month, day, year_known: true };
  }

  // --MM-DD (year omitted entirely)
  const m2 = /^--(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (m2) {
    const month = parseInt(m2[1], 10);
    const day = parseInt(m2[2], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year: null, month, day, year_known: false };
  }

  return null;
}

export function parseVcf(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Contacts: file not found at ${filePath}, name resolution will be limited`);
    return { phones: {}, emails: {}, birthdays: [] };
  }

  const raw = stripControlChars(fs.readFileSync(filePath, 'utf-8'));
  const cards = raw.split('BEGIN:VCARD');

  const phones = {};
  const emails = {};
  const birthdays = [];

  for (const card of cards) {
    const fnMatch = /^FN[^:]*:(.+)$/m.exec(card);
    const nMatch = /^N[^:]*:(.+)$/m.exec(card);
    const name = (fnMatch && fnMatch[1].trim())
      || (nMatch && nMatch[1].split(';').filter(Boolean).join(' ').trim())
      || null;
    if (!name) continue;

    // TEL fields
    for (const m of card.matchAll(/TEL[^:]*:([^\r\n]+)/g)) {
      const d = digitsOnly(m[1]);
      if (d.length >= 7) {
        const key = '+' + d;
        if (!phones[key]) phones[key] = name;
      }
    }
    // Phone numbers in NOTE
    for (const m of card.matchAll(/NOTE[^:]*:([^\r\n]+)/g)) {
      for (const phone of m[1].matchAll(/\+?[\d\s\-()]{8,}/g)) {
        const d = digitsOnly(phone[0]);
        if (d.length >= 8) {
          const key = '+' + d;
          if (!phones[key]) phones[key] = name;
        }
      }
    }
    // EMAIL fields
    for (const m of card.matchAll(/EMAIL[^:]*:([^\r\n]+)/g)) {
      const e = m[1].trim().toLowerCase();
      if (!emails[e]) emails[e] = name;
    }
    // BDAY field
    const bdayMatch = /^BDAY[^:]*:([^\r\n]+)/m.exec(card);
    if (bdayMatch) {
      const parsed = parseBday(bdayMatch[1]);
      if (parsed) {
        birthdays.push({ name, ...parsed });
      }
    }
  }

  console.log(`Contacts: ${Object.keys(phones).length} phones, ${Object.keys(emails).length} emails, ${birthdays.length} birthdays mapped`);
  return { phones, emails, birthdays };
}
