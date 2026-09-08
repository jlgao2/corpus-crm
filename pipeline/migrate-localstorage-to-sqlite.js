#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb } from './crm-server/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function migrate({ dump, dbPath }) {
  const db = openDb(dbPath);
  const now = Date.now();
  const insPerson = db.prepare(`
    INSERT OR IGNORE INTO people (id, name, relationship, email, phone, location, birthday, notes, avatar, follow_up, created_at, updated_at)
    VALUES (@id, @name, @relationship, @email, @phone, @location, @birthday, @notes, @avatar, @follow_up, @now, @now)
  `);
  const insTag = db.prepare('INSERT OR IGNORE INTO person_tags (person_id, tag) VALUES (?, ?)');
  const insInt = db.prepare(`
    INSERT OR IGNORE INTO interactions (id, person_id, kind, body, occurred_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insConn = db.prepare(`
    INSERT INTO connections (source_id, target_id, strength, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id, target_id) DO UPDATE SET strength = excluded.strength, updated_at = excluded.updated_at
  `);

  const txn = db.transaction(() => {
    for (const p of dump.people || []) {
      const id = p.id || randomUUID();
      insPerson.run({
        id, name: p.name || '(unnamed)', relationship: p.relationship || null, email: p.email || null,
        phone: p.phone || null, location: p.location || null, birthday: p.birthday || null,
        notes: p.notes || null, avatar: p.avatar || null, follow_up: p.followUp || null, now,
      });
      for (const t of p.tags || []) insTag.run(id, t);
      for (const it of p.interactions || []) {
        const occurred_at = it.date ? new Date(it.date).getTime() : now;
        insInt.run(it.id || randomUUID(), id, it.type || 'note', it.notes || null, occurred_at, now, now);
      }
    }
    for (const c of dump.connections || []) {
      insConn.run(c.source, c.target, c.strength ?? 1, now);
    }
  });
  txn();
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inFile = process.argv[2];
  const dbPath = process.argv[3] || path.join(__dirname, 'output', 'crm.sqlite');
  if (!inFile) {
    console.error('usage: migrate-localstorage-to-sqlite.js <export.json> [db-path]');
    process.exit(1);
  }
  const dump = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  migrate({ dump, dbPath });
  console.log(`migrated ${dump.people?.length || 0} people into ${dbPath}`);
}
