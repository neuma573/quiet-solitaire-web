PRAGMA foreign_keys = ON;

CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0 CHECK (xp BETWEEN 0 AND 9007199254740991),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('casual', 'normal', 'challenge')),
  draw INTEGER NOT NULL CHECK (draw IN (1, 3)),
  scoring TEXT NOT NULL CHECK (scoring IN ('standard', 'vegas')),
  ruleset TEXT NOT NULL CHECK (ruleset = 'quiet-xp-v1'),
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX runs_user ON runs(user_id, started_at);
CREATE INDEX runs_expiry ON runs(expires_at);

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 1522580),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms BETWEEN 1000 AND 86400000),
  moves INTEGER NOT NULL CHECK (moves BETWEEN 1 AND 100000),
  xp_awarded INTEGER NOT NULL CHECK (xp_awarded BETWEEN 0 AND 107275),
  verification TEXT NOT NULL CHECK (verification = 'client-reported'),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX results_user ON results(user_id);
CREATE INDEX guests_ranking ON guests(xp DESC, created_at ASC, id ASC);

-- A unique contribution and its total are committed in the same SQL transaction.
-- INSERT OR IGNORE on an existing run/key never fires this trigger a second time.
CREATE TRIGGER credit_result AFTER INSERT ON results BEGIN
  UPDATE guests SET xp = xp + NEW.xp_awarded, updated_at = NEW.created_at
    WHERE id = NEW.user_id;
END;

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
