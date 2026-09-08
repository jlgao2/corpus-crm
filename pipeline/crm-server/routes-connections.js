import express from 'express';

export function connectionsRouter(db) {
  const r = express.Router();

  r.get('/connections', (_req, res) => {
    res.json(db.prepare('SELECT * FROM connections').all());
  });

  r.put('/connections/:src/:tgt', (req, res) => {
    const { src, tgt } = req.params;
    const strength = Number.isFinite(req.body?.strength) ? req.body.strength : 1;
    db.prepare(`
      INSERT INTO connections (source_id, target_id, strength, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(source_id, target_id) DO UPDATE SET strength = excluded.strength, updated_at = excluded.updated_at
    `).run(src, tgt, strength, Date.now());
    res.json(db.prepare('SELECT * FROM connections WHERE source_id = ? AND target_id = ?').get(src, tgt));
  });

  r.delete('/connections/:src/:tgt', (req, res) => {
    db.prepare('DELETE FROM connections WHERE source_id = ? AND target_id = ?').run(req.params.src, req.params.tgt);
    res.status(204).end();
  });

  return r;
}
