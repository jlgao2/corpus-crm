/**
 * Common message schema across all sources.
 *
 * Every parsed message is normalized to this shape. Downstream analysis,
 * dedup, and agent stages all operate on this single format.
 */

/**
 * @typedef {Object} Message
 * @property {string} id            Source-unique id (filename + index, or DB rowid)
 * @property {number} ts            Unix milliseconds
 * @property {'me'|'them'} from     Direction
 * @property {string} senderName    Display name as it appears in the source
 * @property {string} body          Plain text content (mojibake fixed)
 * @property {string} threadId      Stable ID for the thread
 * @property {'imessage'|'instagram'|'whatsapp'|'messenger'} source
 * @property {boolean} isGroup      Group chat or 1-on-1
 * @property {string[]} participants  Names of all participants except 'me'
 * @property {string|null} attachmentType  'image'|'video'|'audio'|null
 */

/**
 * @typedef {Object} Identity
 * @property {string} canonicalId     Stable identifier across channels (the resolved person)
 * @property {string} displayName     Best-known name (from contacts when available)
 * @property {string[]} aliases       All known aliases — phone numbers, emails, IG handles, display names
 * @property {string[]} sources       Channels where this identity appears
 */

/**
 * @typedef {Object} Thread
 * @property {string} threadId
 * @property {Identity} other         The other party (for 1-on-1) — null for groups
 * @property {Identity[]} participants
 * @property {boolean} isGroup
 * @property {Message[]} messages
 * @property {string[]} sources
 * @property {Object} stats
 */

export const SCHEMA_VERSION = 1;

export function fixMojibake(s) {
  if (typeof s !== 'string') return s;
  // Instagram exports double-encode UTF-8 as Latin-1
  try {
    const buf = Buffer.from(s, 'latin1');
    return buf.toString('utf8');
  } catch {
    return s;
  }
}

export function isMeaningfulMessage(m) {
  if (!m.body) return false;
  if (m.attachmentType) return false;
  if (/^Reacted /.test(m.body)) return false;
  if (/^Liked /.test(m.body)) return false;
  if (/sent an attachment\.?$/.test(m.body)) return false;
  if (/^Tapback/.test(m.body)) return false;
  if (m.body.startsWith('http') && m.body.split(/\s+/).length < 3) return false;
  return true;
}
