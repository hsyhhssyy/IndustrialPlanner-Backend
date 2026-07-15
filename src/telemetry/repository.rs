use std::net::IpAddr;

use sqlx::types::Json as SqlJson;
use uuid::Uuid;

use crate::database::DatabasePool;

use super::TelemetryPayload;

#[derive(Clone)]
pub(crate) struct TelemetryRepository {
    database: DatabasePool,
}

impl TelemetryRepository {
    pub(crate) fn new(database: DatabasePool) -> Self {
        Self { database }
    }

    pub(crate) async fn insert_sync_shadow(
        &self,
        payload: &TelemetryPayload,
        remote_ip: Option<IpAddr>,
        request_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        let remote_ip = remote_ip.map(|ip| ip.to_string());

        match &self.database {
            DatabasePool::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO sync_shadow_telemetry (
                        created_at, schema_version, source, trigger, app_version, user_agent_hash,
                        install_id_hash, device_id_hash, owner_kind, owner_scope_hash, diagnostics,
                        compact_summaries, remote_ip, request_id
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::inet, $14
                    )
                    ON CONFLICT (install_id_hash, created_at, trigger) DO NOTHING
                    "#,
                )
                .bind(payload.created_at)
                .bind(i16::from(payload.schema_version))
                .bind(&payload.source)
                .bind(&payload.trigger)
                .bind(&payload.app_version)
                .bind(&payload.user_agent_hash)
                .bind(&payload.install_id_hash)
                .bind(&payload.device_id_hash)
                .bind(payload.owner_kind.as_str())
                .bind(&payload.owner_scope_hash)
                .bind(SqlJson(&payload.diagnostics))
                .bind(SqlJson(&payload.compact_summaries))
                .bind(&remote_ip)
                .bind(request_id)
                .execute(pool)
                .await?;
            }
            DatabasePool::MySql(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO sync_shadow_telemetry (
                        created_at, schema_version, source, trigger, app_version, user_agent_hash,
                        install_id_hash, device_id_hash, owner_kind, owner_scope_hash, diagnostics,
                        compact_summaries, remote_ip, request_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON DUPLICATE KEY UPDATE id = id
                    "#,
                )
                .bind(payload.created_at)
                .bind(i16::from(payload.schema_version))
                .bind(&payload.source)
                .bind(&payload.trigger)
                .bind(&payload.app_version)
                .bind(&payload.user_agent_hash)
                .bind(&payload.install_id_hash)
                .bind(&payload.device_id_hash)
                .bind(payload.owner_kind.as_str())
                .bind(&payload.owner_scope_hash)
                .bind(SqlJson(&payload.diagnostics))
                .bind(SqlJson(&payload.compact_summaries))
                .bind(&remote_ip)
                .bind(request_id)
                .execute(pool)
                .await?;
            }
        }

        Ok(())
    }
}
