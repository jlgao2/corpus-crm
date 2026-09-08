// Re-attach the crm.sqlite annotation store to a rebuilt corpus.
//
// build-db renumbers canonical ids; anchors (names + handles captured at
// annotation time) survive. For each person row: if its id still exists we
// keep it (backfilling the anchor if missing); otherwise we resolve the
// anchor against the live identities and rewrite the id across every table.
// Unresolved rows are reported and left untouched — detached is recoverable,
// mis-attached is not.

import { buildAnchor, resolveAnchor } from './person-anchors.js';
import { IDENTITY_TZ_RULES, TZ_RULE_PEOPLE } from './local-time.js';

function toArray(v) {
  return Array.isArray(v) ? v : (v?.items ?? []);
}

export function relinkCrm({ db, identities }) {
  const liveIds = new Set(identities.map((i) => i.canonical_id));
  const byId = new Map(identities.map((i) => [i.canonical_id, i]));
  const report = { ok: [], backfilled: [], rewritten: [], merged: [], unresolved: [] };

  const rewrite = db.transaction((from, to) => {
    const targetExists = db.prepare('SELECT 1 FROM people WHERE id = ?').get(to);
    db.prepare('UPDATE interactions SET person_id = ? WHERE person_id = ?').run(to, from);
    db.prepare('UPDATE OR IGNORE person_tags SET person_id = ? WHERE person_id = ?').run(to, from);
    db.prepare('DELETE FROM person_tags WHERE person_id = ?').run(from);
    db.prepare('UPDATE OR IGNORE connections SET source_id = ? WHERE source_id = ?').run(to, from);
    db.prepare('UPDATE OR IGNORE connections SET target_id = ? WHERE target_id = ?').run(to, from);
    db.prepare('DELETE FROM connections WHERE source_id = ? OR target_id = ?').run(from, from);
    if (targetExists) {
      db.prepare('DELETE FROM people WHERE id = ?').run(from);
      return 'merged';
    }
    db.prepare('UPDATE people SET id = ?, updated_at = ? WHERE id = ?').run(to, Date.now(), from);
    return 'rewritten';
  });

  // Ordinal ids get REUSED across rebuilds — an id that still exists may
  // point at a different human now. The id is only trusted when the row's
  // name (or a captured anchor name) matches the identity living at it.
  const lower = (s) => String(s ?? '').toLowerCase();
  const matchesIdentity = (person, identity) => {
    const anchorNames = person.anchor ? (JSON.parse(person.anchor).names ?? []) : [];
    const rowNames = new Set([person.name, ...anchorNames].map(lower));
    return rowNames.has(lower(identity.display_name))
      || toArray(identity.aliases).some((a) => rowNames.has(lower(a)));
  };

  const people = db.prepare('SELECT id, name, anchor FROM people WHERE deleted_at IS NULL').all();
  for (const person of people) {
    const current = byId.get(person.id);
    if (current && matchesIdentity(person, current)) {
      if (!person.anchor) {
        db.prepare('UPDATE people SET anchor = ? WHERE id = ?')
          .run(JSON.stringify(buildAnchor(current)), person.id);
        report.backfilled.push(person.id);
      } else {
        report.ok.push(person.id);
      }
      continue;
    }
    // Stale or reused id. Resolve names-first: the stored row name is what
    // the human meant; a poisoned anchor's handles must not outvote it.
    const anchor = person.anchor ? JSON.parse(person.anchor) : { names: [], handles: [] };
    const newId = resolveAnchor({
      names: anchor.names?.length ? anchor.names : [person.name],
      handles: anchor.handles ?? [],
    }, identities);
    if (!newId) {
      report.unresolved.push({ id: person.id, name: person.name });
      continue;
    }
    // FK enforcement would reject re-pointing children before the parent id
    // exists; the whole rewrite is atomic, so suspend FKs around it.
    // (The pragma is a no-op inside a transaction — toggle outside.)
    db.pragma('foreign_keys = OFF');
    let outcome;
    try {
      outcome = rewrite(person.id, newId);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    if (outcome === 'merged') report.merged.push({ from: person.id, to: newId });
    else report.rewritten.push({ from: person.id, to: newId, name: person.name });
  }
  return report;
}

/**
 * The tz rule table is hand-authored source keyed by canonical_id. Resolve
 * each named person and flag keys the table no longer covers, with a
 * paste-ready line. Advisory — the table is code, we don't rewrite it.
 */
export function checkTzRules(identities) {
  const stale = [];
  for (const [name, knownKey] of Object.entries(TZ_RULE_PEOPLE)) {
    const currentId = resolveAnchor({ names: [name], handles: [] }, identities);
    if (!currentId) continue; // person not in this corpus — nothing to key
    if (!(currentId in IDENTITY_TZ_RULES)) {
      stale.push({
        name,
        currentId,
        pasteLine: `IDENTITY_TZ_RULES['${currentId}'] = IDENTITY_TZ_RULES['${knownKey}']; // ${name} — re-keyed after rebuild`,
      });
    }
  }
  return stale;
}
