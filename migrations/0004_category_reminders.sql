-- Each person's default reminders per category (e.g. tournaments: 1 week before).
CREATE TABLE category_reminders (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  kinds       TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (user_id, category_id)
);
