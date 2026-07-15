CREATE TABLE sync_shadow_telemetry (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL,
    schema_version SMALLINT NOT NULL,
    source TEXT NOT NULL,
    trigger TEXT NOT NULL,
    app_version TEXT,
    user_agent_hash TEXT,
    install_id_hash TEXT NOT NULL,
    device_id_hash TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('anonymous', 'account')),
    owner_scope_hash TEXT NOT NULL,
    diagnostics JSONB NOT NULL,
    compact_summaries JSONB NOT NULL,
    remote_ip INET,
    request_id UUID NOT NULL
);

CREATE INDEX sync_shadow_telemetry_received_at_idx
    ON sync_shadow_telemetry (received_at DESC);

CREATE INDEX sync_shadow_telemetry_created_at_idx
    ON sync_shadow_telemetry (created_at DESC);

CREATE INDEX sync_shadow_telemetry_trigger_idx
    ON sync_shadow_telemetry (trigger);

CREATE INDEX sync_shadow_telemetry_owner_kind_idx
    ON sync_shadow_telemetry (owner_kind);

CREATE INDEX sync_shadow_telemetry_app_version_idx
    ON sync_shadow_telemetry (app_version)
    WHERE app_version IS NOT NULL;

CREATE UNIQUE INDEX sync_shadow_telemetry_deduplication_idx
    ON sync_shadow_telemetry (install_id_hash, created_at, trigger);
