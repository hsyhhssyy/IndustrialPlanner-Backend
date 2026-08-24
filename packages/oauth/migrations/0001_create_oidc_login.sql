CREATE TABLE oauth_mappings (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE INDEX idx_oauth_mappings_account_id
  ON oauth_mappings(account_id);

CREATE TABLE oauth_login_transactions (
  state_hash TEXT PRIMARY KEY,
  state_value TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_login_transactions_expires_at
  ON oauth_login_transactions(expires_at);

CREATE TABLE oauth_callback_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_callback_codes_expires_at
  ON oauth_callback_codes(expires_at);
