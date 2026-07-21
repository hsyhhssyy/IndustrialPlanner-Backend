use std::sync::Arc;

use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use serde::Serialize;
use tracing::error;

use crate::{
    database::DatabasePool,
    logs::{self, LogBuffer},
    telemetry::{self, TelemetryHttpState},
};

#[derive(Clone)]
pub(crate) struct ApiState {
    pub(crate) database: DatabasePool,
    pub(crate) environment: Arc<str>,
    pub(crate) log_buffer: Arc<LogBuffer>,
}

pub(crate) fn router(
    database: DatabasePool,
    telemetry: TelemetryHttpState,
    environment: String,
    log_buffer: Arc<LogBuffer>,
) -> Router {
    let state = ApiState {
        database,
        environment: environment.into(),
        log_buffer,
    };
    Router::new()
        .route("/health", get(readiness))
        .route("/livez", get(liveness))
        .route("/readyz", get(readiness))
        .route("/logs", get(logs::get_logs))
        .with_state(state)
        .merge(telemetry::router(telemetry))
}

async fn liveness(State(state): State<ApiState>) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(StatusResponse {
            status: "live",
            environment: Arc::clone(&state.environment),
        }),
    )
}

async fn readiness(State(state): State<ApiState>) -> impl IntoResponse {
    match state.database.health_check().await {
        Ok(()) => (
            StatusCode::OK,
            Json(StatusResponse {
                status: "ready",
                environment: Arc::clone(&state.environment),
            }),
        )
            .into_response(),
        Err(error) => {
            error!(%error, "readiness database check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "database_unavailable",
                }),
            )
                .into_response()
        }
    }
}

#[derive(Serialize)]
struct StatusResponse {
    status: &'static str,
    environment: Arc<str>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}
