CREATE TABLE instance_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  high_seq INTEGER NOT NULL DEFAULT 0,
  complete_from_seq INTEGER NOT NULL DEFAULT 1,
  daemon_epoch INTEGER NOT NULL DEFAULT 0,
  boot_id TEXT
);
INSERT INTO instance_meta(id) VALUES (1);
CREATE TABLE runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE events (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE cursors (
  run_id TEXT NOT NULL REFERENCES runs(id), segment INTEGER NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0, finished_offset INTEGER, PRIMARY KEY(run_id, segment)
);
CREATE TABLE consumed (
  run_id TEXT NOT NULL REFERENCES runs(id), segment INTEGER NOT NULL, seq INTEGER NOT NULL,
  digest TEXT NOT NULL, end_offset INTEGER NOT NULL, PRIMARY KEY(run_id, segment, seq)
);
CREATE TABLE activity (
  run_id TEXT NOT NULL REFERENCES runs(id), run_seq INTEGER NOT NULL, segment INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(run_id, run_seq)
);
CREATE TABLE diagnostics (id INTEGER PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE commands (
  run_id TEXT NOT NULL REFERENCES runs(id), segment INTEGER NOT NULL,
  command_id TEXT NOT NULL, method TEXT NOT NULL, params TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run_id, segment, command_id)
);
