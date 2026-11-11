-- App settings the Worker manages itself (e.g. the push notification key pair, created on first run).
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
