-- SpareTime schema. Times are stored as local wall-clock values in the TIMEZONE var
-- (dates 'YYYY-MM-DD', times 'HH:MM'); created_at/updated_at are UTC.

CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  pass_hash  TEXT NOT NULL,
  pass_salt  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- owner_id NULL = a shared category either person can change.
CREATE TABLE categories (
  id         INTEGER PRIMARY KEY,
  owner_id   INTEGER REFERENCES users(id),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  outdoor    INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);

-- owner_id NULL = a "Both of us" event.
CREATE TABLE events (
  id             INTEGER PRIMARY KEY,
  owner_id       INTEGER REFERENCES users(id),
  category_id    INTEGER REFERENCES categories(id),
  title          TEXT NOT NULL,
  date           TEXT NOT NULL,
  start_time     TEXT,
  end_time       TEXT,
  all_day        INTEGER NOT NULL DEFAULT 0,
  location       TEXT,
  notes          TEXT,
  repeat         TEXT NOT NULL DEFAULT 'none',   -- none | daily | weekly | biweekly | monthly
  repeat_until   TEXT,
  exdates        TEXT NOT NULL DEFAULT '[]',     -- JSON array of skipped dates
  visibility     TEXT NOT NULL DEFAULT 'shared', -- shared | busy | private
  notify_partner INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX events_date ON events(date);

-- Per-person reminders on an event. kinds: JSON array of "night" | "morning" | "hour" | minutes (number).
CREATE TABLE event_reminders (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id),
  kinds    TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE reactions (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occ_date   TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX reactions_event ON reactions(event_id, occ_date);

CREATE TABLE statuses (
  event_id   INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  occ_date   TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  status     TEXT NOT NULL,                      -- on_way | late
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, occ_date, user_id)
);

CREATE TABLE activity (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),   -- who sees it
  kind       TEXT NOT NULL,
  actor_id   INTEGER REFERENCES users(id),
  event_id   INTEGER,
  occ_date   TEXT,
  lead       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at    TEXT
);
CREATE INDEX activity_user ON activity(user_id, created_at);

CREATE TABLE prefs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  key     TEXT NOT NULL,
  value   INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE push_subs (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- De-duplicates scheduled notifications (reminders, recaps, weather) across overlapping cron runs.
CREATE TABLE sent (
  key TEXT PRIMARY KEY,
  at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
