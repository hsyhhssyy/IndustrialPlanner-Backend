ALTER TABLE oauth_callback_codes
  ADD COLUMN username TEXT NOT NULL DEFAULT '';
