PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  relationship  TEXT,
  email         TEXT,
  phone         TEXT,
  location      TEXT,
  birthday      TEXT,
  notes         TEXT,
  avatar        TEXT,
  follow_up     TEXT,
  anchor        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS person_tags (
  person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tag           TEXT NOT NULL,
  PRIMARY KEY (person_id, tag)
);

CREATE TABLE IF NOT EXISTS interactions (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  body          TEXT,
  occurred_at   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);

CREATE TABLE IF NOT EXISTS connections (
  source_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  target_id     TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  strength      INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_people_updated      ON people(updated_at);
CREATE INDEX IF NOT EXISTS idx_interactions_person ON interactions(person_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_interactions_updated ON interactions(updated_at);
