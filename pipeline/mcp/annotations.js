// Annotation writes → crm.sqlite. Never touches the duckdb.
//
// person ids are duckdb canonical_ids (id-NNNN); the people row is created
// lazily from the identities table the first time an annotation lands.

import { randomUUID } from 'node:crypto';
import { buildAnchor } from '../lib/person-anchors.js';

export const INTERACTION_KINDS = ['note', 'call', 'meetup', 'message', 'other'];

function toMs(v) {
  if (v == null) return Date.now();
  if (typeof v === 'number') return v;
  const parsed = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(parsed)) throw new Error(`bad occurred_at: ${v}`);
  return parsed;
}

/**
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db  open crm.sqlite handle
 * @param {(id: string) => Promise<{canonical_id: string, display_name: string}|null>} deps.lookupIdentity
 */
export function createAnnotations({ db, lookupIdentity }) {
  async function ensurePerson(personId) {
    const existing = db.prepare('SELECT * FROM people WHERE id = ? AND deleted_at IS NULL').get(personId);
    if (existing) return existing;
    const identity = await lookupIdentity(personId);
    if (!identity) throw new Error(`unknown person: ${personId} (not in crm.sqlite or identities)`);
    const now = Date.now();
    db.prepare('INSERT INTO people (id, name, anchor, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(personId, identity.display_name, JSON.stringify(buildAnchor(identity)), now, now);
    return db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
  }

  async function logInteraction({ person_id, kind, body, occurred_at }) {
    if (!INTERACTION_KINDS.includes(kind)) {
      throw new Error(`bad kind: ${kind} (expected ${INTERACTION_KINDS.join('|')})`);
    }
    await ensurePerson(person_id);
    const now = Date.now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO interactions (id, person_id, kind, body, occurred_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, person_id, kind, body || null, toMs(occurred_at), now, now);
    return db.prepare('SELECT * FROM interactions WHERE id = ?').get(id);
  }

  async function setFollowUp({ person_id, text }) {
    await ensurePerson(person_id);
    db.prepare('UPDATE people SET follow_up = ?, updated_at = ? WHERE id = ?')
      .run(text, Date.now(), person_id);
    return db.prepare('SELECT * FROM people WHERE id = ?').get(person_id);
  }

  return { logInteraction, setFollowUp };
}
