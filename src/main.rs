mod api;
mod assets;
mod config;
mod database;
mod identity;
mod logs;
mod oauth;
mod sync;
mod telemetry;

use std::{net::SocketAddr, sync::Arc};

use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderName, Method, header},
};
use config::Config;
use database::DatabasePool;
use logs::LogBuffer;
use telemetry::{RateLimitConfig, RateLimiter, TelemetryHttpState, TelemetryRepository};
use tokio::net::TcpListener;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let log_buffer = Arc::new(LogBuffer::new(10_000));
    init_tracing(logs::LogCapture::new(log_buffer.clone()));

    let config = Config::from_env()?;
    let database =
        DatabasePool::connect(&config.database_url, config.database_max_connections).await?;
    database.migrate().await?;

    let rate_limiter = RateLimiter::new(
        config.redis_url.as_deref(),
        RateLimitConfig {
            window_seconds: config.telemetry_rate_window_seconds,
            global_limit: config.telemetry_global_rate_limit,
            identity_limit: config.telemetry_identity_rate_limit,
            ip_limit: config.telemetry_ip_rate_limit,
        },
    )
    .await;
    if !rate_limiter.is_distributed() {
        warn!("Redis is not configured or unavailable; telemetry rate limiting is disabled");
    }

    let telemetry = TelemetryHttpState::new(
        TelemetryRepository::new(database.clone()),
        Arc::new(rate_limiter),
        Arc::new(config.trusted_proxy_cidrs),
    );
    let app = build_app(
        database,
        telemetry,
        config.telemetry_max_body_bytes,
        config.environment.clone(),
        log_buffer,
    );

    let listener = TcpListener::bind(config.http_bind_addr).await?;
    info!(
        address = %config.http_bind_addr,
        environment = %config.environment,
        "HTTP server is listening"
    );

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}

fn build_app(
    database: DatabasePool,
    telemetry: TelemetryHttpState,
    telemetry_max_body_bytes: usize,
    environment: String,
    log_buffer: Arc<LogBuffer>,
) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            HeaderName::from_static("x-request-id"),
        ])
        .max_age(std::time::Duration::from_secs(86_400));

    Router::new()
        .merge(api::router(database, telemetry, environment, log_buffer))
        .layer(DefaultBodyLimit::max(telemetry_max_body_bytes))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
}

fn init_tracing(writer: logs::LogCapture) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("industrial_planner_backend=info,tower_http=info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_writer(writer)
        .init();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C signal handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }

    info!("shutdown signal received");
}
