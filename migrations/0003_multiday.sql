-- Multi-day events: the last day of the event (NULL = a single day).
ALTER TABLE events ADD COLUMN end_date TEXT;
