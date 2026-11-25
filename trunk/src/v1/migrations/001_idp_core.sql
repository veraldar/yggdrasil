-- IDP core (spec §6). Times are unix milliseconds. Every *_enc column is AES-256-GCM under trunk-kek.
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  pw_hash     TEXT,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE totp (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id),
  secret_enc   BLOB NOT NULL,
  enrolled_at  INTEGER,            -- NULL = pending (signup / reset not confirmed yet)
  last_step    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recovery_codes (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  code_hash   TEXT NOT NULL,
  used_at     INTEGER,
  PRIMARY KEY (account_id, code_hash)
);

CREATE TABLE passkeys (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  cred_id     TEXT NOT NULL UNIQUE,
  public_key  BLOB NOT NULL,
  sign_count  INTEGER NOT NULL DEFAULT 0,
  aaguid      TEXT,
  transports  TEXT,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

CREATE TABLE oauth_ids (
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  issuer      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  email       TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (issuer, subject)
);

CREATE TABLE devices (
  id            TEXT PRIMARY KEY,           -- dev_…
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  name          TEXT NOT NULL CHECK (length(name) <= 40),
  created_via   TEXT NOT NULL CHECK (created_via IN ('login', 'qr', 'claim')),
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  first_region  TEXT NOT NULL,
  last_region   TEXT NOT NULL,
  moved_count   INTEGER NOT NULL DEFAULT 0,
  last_2fa_at   INTEGER,
  door_root     TEXT,
  ua_family     TEXT,
  revoked_at    INTEGER,
  revoked_by    TEXT,
  revoked_why   TEXT
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE refresh_tokens (
  hash         TEXT PRIMARY KEY,            -- sha256 hex of bfnr-…
  device_id    TEXT NOT NULL REFERENCES devices(id),
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  retired_at   INTEGER,
  replaced_by  TEXT
);
CREATE INDEX refresh_device ON refresh_tokens(device_id);

CREATE TABLE pins_seen (
  device_id   TEXT NOT NULL,
  root_id     TEXT NOT NULL,
  dtls_fp     TEXT NOT NULL,
  first_seen  INTEGER NOT NULL,
  PRIMARY KEY (device_id, root_id, dtls_fp)
);

CREATE TABLE pair_tokens (
  id                  TEXT PRIMARY KEY,
  hash                TEXT NOT NULL UNIQUE,
  minted_by_device    TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER,
  consumed_by_device  TEXT,
  burned_at           INTEGER,
  burn_why            TEXT
);

-- one row (id = 1)
CREATE TABLE claim (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  code_hash       TEXT,
  rotated_at      INTEGER,
  attempts_total  INTEGER NOT NULL DEFAULT 0,
  locked          INTEGER NOT NULL DEFAULT 0,
  ticket_hash     TEXT,
  ticket_expires  INTEGER,
  ticket_state    TEXT                       -- begun | approved (signup allowed) | NULL
);
INSERT INTO claim (id) VALUES (1);

CREATE TABLE limits (
  key           TEXT PRIMARY KEY,
  tokens        INTEGER NOT NULL DEFAULT 0, -- password: lockouts since the last success (doubling)
  updated_at    INTEGER NOT NULL,           -- start of the current failure window
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER
);

CREATE TABLE signing_keys (
  kid          TEXT PRIMARY KEY,
  alg          TEXT NOT NULL,
  public       BLOB NOT NULL,
  private_enc  BLOB NOT NULL,
  created_at   INTEGER NOT NULL,
  retired_at   INTEGER
);

CREATE TABLE audit (
  seq            INTEGER PRIMARY KEY,
  ts             INTEGER NOT NULL,
  actor_account  TEXT,
  actor_device   TEXT,
  actor_root     TEXT,
  action         TEXT NOT NULL,
  target_kind    TEXT,
  target_id      TEXT,
  region         TEXT,
  ip_trunc       TEXT,
  detail_json    TEXT NOT NULL DEFAULT '{}',
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
