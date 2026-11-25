-- WIRE (spec §6): the roots of this trunk and their enrollments.
-- Ids are never reused (a revoked root keeps its row and its id; a WireGuard key is never taken
-- twice: UNIQUE). Bearer secrets are stored as sha256 only; the one-time enrollment result is
-- kept sealed under trunk-kek until the installer collects it (C6 fix).

CREATE TABLE roots (
  id                  TEXT PRIMARY KEY,            -- rt_…  (never reused)
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  hostname            TEXT NOT NULL,
  os                  TEXT NOT NULL,
  arch                TEXT NOT NULL,
  version             TEXT NOT NULL DEFAULT '',
  build_id            TEXT NOT NULL DEFAULT '',
  has_app             INTEGER NOT NULL DEFAULT 0,
  has_voice           INTEGER NOT NULL DEFAULT 0,
  root_pub            TEXT NOT NULL UNIQUE,         -- b64url Ed25519 (the link key)
  wg_pub              TEXT NOT NULL UNIQUE,         -- std base64 x25519
  wg_addr             TEXT NOT NULL UNIQUE,         -- in meta wg_net, never reused
  dtls_fp             TEXT NOT NULL DEFAULT '',
  peer_token_hash     TEXT NOT NULL,                -- sha256 hex of the root's own peer token
  share_model_from    TEXT,
  rebind_secret_hash  TEXT,                         -- import-v0 only; burned by POST /t/roots/rebind
  enrolled_by_device  TEXT,
  enrolled_at         INTEGER NOT NULL,
  last_seen           INTEGER,
  revoked_at          INTEGER,
  revoked_by          TEXT,
  revoked_why         TEXT
);

CREATE TABLE enrollments (
  id                  TEXT PRIMARY KEY,            -- enr_…
  poll_secret_hash    TEXT NOT NULL,               -- sha256 hex of the installer's poll secret
  code_seed_enc       BLOB NOT NULL,               -- the rotating 6-digit code's seed, sealed (never the code)
  code_epoch          INTEGER NOT NULL,            -- ms the first code window began
  attempts            INTEGER NOT NULL DEFAULT 0,  -- wrong codes for this enrollment (5 → killed)
  start_region        TEXT NOT NULL,
  start_ip_trunc      TEXT NOT NULL,
  hostname            TEXT NOT NULL,
  os                  TEXT NOT NULL,
  arch                TEXT NOT NULL,
  version             TEXT NOT NULL DEFAULT '',
  build_id            TEXT NOT NULL DEFAULT '',
  has_app             INTEGER NOT NULL DEFAULT 0,
  has_voice           INTEGER NOT NULL DEFAULT 0,
  name                TEXT NOT NULL,
  root_pub            TEXT NOT NULL,
  wg_pub              TEXT NOT NULL,
  dtls_fp             TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'refused', 'expired', 'delivered')),
  approved_by_device  TEXT,
  root_id             TEXT,
  result_enc          BLOB,                        -- sealed poll result until collected, then NULL
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL
);
CREATE INDEX enrollments_status ON enrollments(status);
