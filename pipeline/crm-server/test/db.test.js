import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';

test('openDb creates schema and returns a working connection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-db-'));
  const db = openDb(path.join(tmp, 'test.sqlite'));
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.deepEqual(tables, ['connections', 'interactions', 'people', 'person_tags']);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
