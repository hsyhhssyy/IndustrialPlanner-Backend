ALTER TABLE oauth_login_transactions
  ADD COLUMN frontend_redirect_uri TEXT NOT NULL DEFAULT '';

ALTER TABLE oauth_login_transactions
  ADD COLUMN oauth_channel TEXT NOT NULL DEFAULT '';
