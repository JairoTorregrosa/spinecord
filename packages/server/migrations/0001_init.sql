-- CONTRACT.md §10. No personal data, no images.
CREATE TABLE robots (
  id TEXT PRIMARY KEY,
  owner_principal TEXT,
  backend TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  devices_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per call, written once at its terminal state.
-- Beyond §10: principal (who), moving (episode counter "moving calls"), trace_id (joins with the logs).
CREATE TABLE calls (
  id TEXT PRIMARY KEY,
  robot_id TEXT,
  tool TEXT NOT NULL,
  request_id TEXT,
  state TEXT NOT NULL,
  code TEXT,
  ms INTEGER NOT NULL,
  episode_id TEXT,
  created_at INTEGER NOT NULL,
  principal TEXT,
  moving INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT
);
CREATE INDEX calls_robot_time ON calls (robot_id, created_at);
CREATE INDEX calls_episode ON calls (episode_id);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  robot_id TEXT NOT NULL,
  label TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  metrics_json TEXT
);
CREATE INDEX episodes_robot ON episodes (robot_id, started_at);

CREATE TABLE episode_marks (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX marks_episode ON episode_marks (episode_id, at);

-- Beyond §10: verified_on_json = {twin_id, profile_hash, at} recorded by verify_program (CONTRACT §1 Program).
CREATE TABLE programs (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  author TEXT NOT NULL,
  description TEXT NOT NULL,
  body_json TEXT NOT NULL,
  success_json TEXT,
  requires_json TEXT NOT NULL,
  pass_rate REAL NOT NULL,
  state TEXT NOT NULL,
  success_rate REAL,
  verified_on_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);

CREATE TABLE program_runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  robot_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  outcome TEXT NOT NULL,
  ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX runs_program ON program_runs (name, version, created_at);
