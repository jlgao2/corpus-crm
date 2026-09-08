import express from 'express';

const OP_HANDLERS = {
  add_person(db, p) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO people (id, name, relationship, email, phone, location, birthday, notes, avatar, follow_up, created_at, updated_at)
      VALUES (@id, @name, @relationship, @email, @phone, @location, @birthday, @notes, @avatar, @follow_up, @now, @now)
    `).run({
      id: p.id, name: p.name, relationship: p.relationship||null, email: p.email||null, phone: p.phone||null,
      location: p.location||null, birthday: p.birthday||null, notes: p.notes||null, avatar: p.avatar||null,
      follow_up: p.follow_up||null, now,
    });
    if (Array.isArray(p.tags)) {
      const ins = db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag) VALUES (?, ?)');
      for (const t of p.tags) ins.run(p.id, t);
    }
  },
  update_person(db, p) {
    const fields = ['name','relationship','email','phone','location','birthday','notes','avatar','follow_up'];
    const sets = []; const params = { id: p.id, updated_at: Date.now() };
    for (const f of fields) if (f in p) { sets.push(`${f} = @${f}`); params[f] = p[f]; }
    if (sets.length) db.prepare(`UPDATE people SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id AND deleted_at IS NULL`).run(params);
    if (Array.isArray(p.tags)) {
      db.prepare('DELETE FROM person_tags WHERE person_id = ?').run(p.id);
      const ins = db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag) VALUES (?, ?)');
      for (const t of p.tags) ins.run(p.id, t);
    }
  },
  delete_person(db, p) {
    const now = Date.now();
    db.prepare('UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, p.id);
  },
  add_interaction(db, p) {
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO interactions (id, person_id, kind, body, occurred_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(p.id, p.person_id, p.kind, p.body||null, p.occurred_at, now, now);
  },
  update_interaction(db, p) {
    const fields = ['kind','body','occurred_at'];
    const sets = []; const params = { id: p.id, updated_at: Date.now() };
    for (const f of fields) if (f in p) { sets.push(`${f} = @${f}`); params[f] = p[f]; }
    if (sets.length) db.prepare(`UPDATE interactions SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id AND deleted_at IS NULL`).run(params);
  },
  delete_interaction(db, p) {
    const now = Date.now();
    db.prepare('UPDATE interactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, now, p.id);
  },
  upsert_connection(db, p) {
    db.prepare(`
      INSERT INTO connections (source_id, target_id, strength, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, target_id) DO UPDATE SET strength = excluded.strength, updated_at = excluded.updated_at
    `).run(p.source_id, p.target_id, p.strength ?? 1, Date.now());
  },
};

function rowToPersonWithTags(db, row) {
  const tags = db.prepare('SELECT tag FROM person_tags WHERE person_id = ?').all(row.id).map(r => r.tag);
  return { ...row, tags };
}

export function syncRouter(db) {
  const r = express.Router();

  r.post('/sync', (req, res) => {
    const { since = 0, ops = [] } = req.body || {};
    const apply = db.transaction(() => {
      for (const op of ops) {
        const h = OP_HANDLERS[op.kind];
        if (!h) continue;
        try { h(db, op.payload || {}); } catch (err) {
          // last-write-wins on errors that are recoverable; log and skip
          console.warn('[sync] op skipped', op.op_id, op.kind, err.message);
        }
      }
    });
    apply();
    const now = Date.now();
    const peopleRows = db.prepare('SELECT * FROM people WHERE updated_at > ?').all(since);
    const people = peopleRows.map(row => rowToPersonWithTags(db, row));
    const interactions = db.prepare('SELECT * FROM interactions WHERE updated_at > ?').all(since);
    const connections  = db.prepare('SELECT * FROM connections  WHERE updated_at > ?').all(since);
    res.json({ now, people, interactions, connections });
  });

  return r;
}
