-- Stage 2：存量空间归类为匿名空间；账户空间由 owner_id 唯一约束保证一账户一空间。
ALTER TABLE sync_spaces
  ADD COLUMN owner_kind TEXT NOT NULL DEFAULT 'anonymous'
  CHECK (owner_kind IN ('anonymous', 'account'));

ALTER TABLE sync_spaces
  ADD COLUMN owner_id TEXT;

CREATE UNIQUE INDEX idx_sync_spaces_account_owner
  ON sync_spaces(owner_id)
  WHERE owner_kind = 'account';

CREATE INDEX idx_sync_spaces_owner_kind
  ON sync_spaces(owner_kind);

CREATE TRIGGER trg_sync_spaces_owner_insert
BEFORE INSERT ON sync_spaces
WHEN
  (NEW.owner_kind = 'anonymous' AND NEW.owner_id IS NOT NULL)
  OR
  (NEW.owner_kind = 'account' AND (NEW.owner_id IS NULL OR length(trim(NEW.owner_id)) = 0))
BEGIN
  SELECT RAISE(ABORT, 'invalid sync space owner');
END;

CREATE TRIGGER trg_sync_spaces_owner_update
BEFORE UPDATE OF owner_kind, owner_id ON sync_spaces
WHEN
  (NEW.owner_kind = 'anonymous' AND NEW.owner_id IS NOT NULL)
  OR
  (NEW.owner_kind = 'account' AND (NEW.owner_id IS NULL OR length(trim(NEW.owner_id)) = 0))
BEGIN
  SELECT RAISE(ABORT, 'invalid sync space owner');
END;
