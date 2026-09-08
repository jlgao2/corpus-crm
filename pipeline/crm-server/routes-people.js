import express from 'express';
import { randomUUID } from 'node:crypto';

function rowToPerson(db, row) {
  if (!row) return null;
  const tags = db.prepare('SELECT tag FROM person_tags WHERE person_id = ?').all(row.id).map(r => r.tag);
  return { ...row, tags };
}

export function peopleRouter(db) {
  const r = express.Router();

  r.get('/people', (_req, res) => {
    const rows = db.prepare('SELECT * FROM people WHERE deleted_at IS NULL ORDER BY updated_at DESC').all();
    res.json(rows.map(row => rowToPerson(db, row)));
  });

  r.get('/people/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM people WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const person = rowToPerson(db, row);
    person.interactions = db.prepare(
      'SELECT * FROM interactions WHERE person_id = ? AND deleted_at IS NULL ORDER BY occurred_at DESC'
    ).all(req.params.id);
    res.json(person);
  });

  r.post('/people', (req, res) => {
    const { name, relationship, email, phone, location, birthday, notes, avatar, follow_up, tags = [], id } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name_required' });
    const now = Date.now();
    const personId = id || randomUUID();
    const insert = db.prepare(`
      INSERT INTO people (id, name, relationship, email, phone, location, birthday, notes, avatar, follow_up, created_at, updated_at)
      VALUES (@id, @name, @relationship, @email, @phone, @location, @birthday, @notes, @avatar, @follow_up, @now, @now)
    `);
    const txn = db.transaction(() => {
      insert.run({ id: personId, name, relationship: relationship||null, email: email||null, phone: phone||null, location: location||null, birthday: birthday||null, notes: notes||null, avatar: avatar||null, follow_up: follow_up||null, now });
      const insTag = db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag) VALUES (?, ?)');
      for (const t of tags) insTag.run(personId, t);
    });
    txn();
    const row = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
    res.status(201).json(rowToPerson(db, row));
  });

  r.patch('/people/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM people WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const fields = ['name','relationship','email','phone','location','birthday','notes','avatar','follow_up'];
    const sets = []; const params = { id: req.params.id, updated_at: Date.now() };
    for (const f of fields) if (f in req.body) { sets.push(`${f} = @${f}`); params[f] = req.body[f]; }
    const txn = db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE people SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
      } else {
        db.prepare('UPDATE people SET updated_at = @updated_at WHERE id = @id').run(params);
      }
      if (Array.isArray(req.body.tags)) {
        db.prepare('DELETE FROM person_tags WHERE person_id = ?').run(req.params.id);
        const ins = db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag) VALUES (?, ?)');
        for (const t of req.body.tags) ins.run(req.params.id, t);
      }
    });
    txn();
    const updated = db.prepare('SELECT * FROM people WHERE id = ?').get(req.params.id);
    res.json(rowToPerson(db, updated));
  });

  r.delete('/people/:id', (req, res) => {
    const result = db.prepare('UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), Date.now(), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  return r;
}
