ALTER TABLE oauth_mappings
  RENAME COLUMN issuer TO provider_key;

ALTER TABLE oauth_login_transactions
  RENAME COLUMN nonce TO provider_context;

ALTER TABLE oauth_login_transactions
  ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'oidc'
  CHECK(provider_type IN ('oidc', 'orangeauth'));
