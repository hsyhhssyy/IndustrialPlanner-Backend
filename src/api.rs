use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use serde::Serialize;
use tracing::error;

use crate::{
    database::DatabasePool,
    telemetry::{self, TelemetryHttpState},
};

pub(crate) fn router(database: DatabasePool, telemetry: TelemetryHttpState) -> Router {
    Router::new()
        .route("/health", get(readiness))
        .route("/livez", get(liveness))
        .route("/readyz", get(readiness))
        .with_state(database)
        .merge(telemetry::router(telemetry))
}

async fn liveness() -> impl IntoResponse {
    (StatusCode::OK, Json(StatusResponse { status: "live" }))
}

async fn readiness(State(database): State<DatabasePool>) -> impl IntoResponse {
    match database.health_check().await {
        Ok(()) => (StatusCode::OK, Json(StatusResponse { status: "ready" })).into_response(),
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
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}
