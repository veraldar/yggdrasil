-- M4 (spec §7 OAuth + passkeys): one-use, short-lived challenges. The browser holds a random
-- handle (the OAuth `state`, a passkey challenge id); the trunk keeps only its sha256 and the
-- ceremony's state sealed under trunk-kek (PKCE verifier, nonce, claim ticket, WebAuthn state).
-- A row is deleted when it is used (success or not) or when it expires.
CREATE TABLE auth_challenges (
  id_hash     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('oauth', 'passkey.register', 'passkey.login', 'passkey.step_up', 'passkey.mfa')),
  account_id  TEXT,
  device_id   TEXT,
  net         TEXT NOT NULL,              -- the client's /24 or /48 (a cap per network)
  data_enc    BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX auth_challenges_net ON auth_challenges(net);
CREATE INDEX auth_challenges_expires ON auth_challenges(expires_at);
