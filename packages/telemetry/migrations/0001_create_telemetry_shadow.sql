-- 遥测记录表
-- 幂等约束：同一 install_id + 同一天 + 同一 trigger 只保留最新一条
CREATE TABLE IF NOT EXISTS telemetry_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id_hash TEXT NOT NULL,
  created_date TEXT NOT NULL,  -- YYYY-MM-DD
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL,    -- ISO 8601
  payload TEXT,                -- JSON string

  UNIQUE(install_id_hash, created_date, trigger)
);

CREATE INDEX IF NOT EXISTS idx_telemetry_date ON telemetry_shadow(created_date);
