CREATE TABLE sync_shadow_telemetry (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    received_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    created_at DATETIME(6) NOT NULL,
    schema_version SMALLINT NOT NULL,
    source VARCHAR(64) NOT NULL,
    trigger VARCHAR(128) NOT NULL,
    app_version VARCHAR(128) NULL,
    user_agent_hash VARCHAR(128) NULL,
    install_id_hash VARCHAR(128) NOT NULL,
    device_id_hash VARCHAR(128) NOT NULL,
    owner_kind VARCHAR(16) NOT NULL,
    owner_scope_hash VARCHAR(128) NOT NULL,
    diagnostics JSON NOT NULL,
    compact_summaries JSON NOT NULL,
    remote_ip VARCHAR(45) NULL,
    request_id BINARY(16) NOT NULL,
    CONSTRAINT sync_shadow_telemetry_owner_kind_check
        CHECK (owner_kind IN ('anonymous', 'account')),
    PRIMARY KEY (id),
    UNIQUE KEY sync_shadow_telemetry_deduplication_idx
        (install_id_hash, created_at, trigger),
    KEY sync_shadow_telemetry_received_at_idx (received_at),
    KEY sync_shadow_telemetry_created_at_idx (created_at),
    KEY sync_shadow_telemetry_trigger_idx (trigger),
    KEY sync_shadow_telemetry_owner_kind_idx (owner_kind),
    KEY sync_shadow_telemetry_app_version_idx (app_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
