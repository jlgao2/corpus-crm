import express from 'express';
import { randomUUID } from 'node:crypto';

export function interactionsRouter(db) {
  const r = express.Router();

  r.post('/people/:id/interactions', (req, res) => {
    const person = db.prepare('SELECT id FROM people WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!person) return res.status(404).json({ error: 'person_not_found' });
    const { kind, body, occurred_at, id } = req.body || {};
    if (!kind || typeof occurred_at !== 'number') return res.status(400).json({ error: 'kind_and_occurred_at_required' });
    const now = Date.now();
    const intId = id || randomUUID();
    db.prepare(`
      INSERT INTO interactions (id, person_id, kind, body, occurred_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(intId, req.params.id, kind, body || null, occurred_at, now, now);
    const row = db.prepare('SELECT * FROM interactions WHERE id = ?').get(intId);
    res.status(201).json(row);
  });

  r.patch('/interactions/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM interactions WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const fields = ['kind','body','occurred_at'];
    const sets = []; const params = { id: req.params.id, updated_at: Date.now() };
    for (const f of fields) if (f in req.body) { sets.push(`${f} = @${f}`); params[f] = req.body[f]; }
    if (sets.length) {
      db.prepare(`UPDATE interactions SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params);
    }
    res.json(db.prepare('SELECT * FROM interactions WHERE id = ?').get(req.params.id));
  });

  r.delete('/interactions/:id', (req, res) => {
    const result = db.prepare('UPDATE interactions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), Date.now(), req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  return r;
}
