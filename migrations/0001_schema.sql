-- Rasco Holdings opportunity pipeline (D1: rasco-holdings)
CREATE TABLE IF NOT EXISTS stages (
  n INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL DEFAULT '',
  exit_test TEXT NOT NULL DEFAULT ''   -- what must be true before a card leaves this stage
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,                 -- RE-001 (real estate), BZ-001 (business), OP-001 (other)
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('real_estate','business','other')),
  stage TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  ask TEXT NOT NULL DEFAULT '',        -- asking price / terms, free text
  link TEXT NOT NULL DEFAULT '',       -- listing, data room or deck
  next_action TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',      -- append-only lines: [date actor] text
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT NOT NULL DEFAULT '',
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('human','bot')),
  action TEXT NOT NULL,                -- create | update:<field> | move | note | decision | delete | denied_move
  card_id TEXT,
  from_value TEXT,
  to_value TEXT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_at ON events(at DESC);
CREATE INDEX IF NOT EXISTS events_card ON events(card_id);
-- append-only: block edits and deletes on the log
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TABLE IF NOT EXISTS approval_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL REFERENCES cards(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  note TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS approval_decisions_card ON approval_decisions(card_id, created_at);
