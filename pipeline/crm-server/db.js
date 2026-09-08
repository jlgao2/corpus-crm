import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  // CREATE IF NOT EXISTS doesn't add columns to pre-existing tables.
  const cols = db.prepare('PRAGMA table_info(people)').all().map((c) => c.name);
  if (!cols.includes('anchor')) db.exec('ALTER TABLE people ADD COLUMN anchor TEXT');
  return db;
}
