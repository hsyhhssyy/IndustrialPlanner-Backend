use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
};

use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use chrono::Utc;
use serde::Serialize;
use tracing::{debug, error};
use uuid::Uuid;

use super::{Admission, RateLimiter, TelemetryPayload, TelemetryRepository};

#[derive(Clone)]
pub(crate) struct TelemetryHttpState {
    repository: TelemetryRepository,
    rate_limiter: Arc<RateLimiter>,
    trusted_proxy_cidrs: Arc<Vec<ipnet::IpNet>>,
}

impl TelemetryHttpState {
    pub(crate) fn new(
        repository: TelemetryRepository,
        rate_limiter: Arc<RateLimiter>,
        trusted_proxy_cidrs: Arc<Vec<ipnet::IpNet>>,
    ) -> Self {
        Self {
            repository,
            rate_limiter,
            trusted_proxy_cidrs,
        }
    }
}

pub(crate) fn router(state: TelemetryHttpState) -> Router {
    Router::new()
        .route(
            "/v1/telemetry/sync-shadow",
            post(receive_sync_shadow_telemetry),
        )
        .with_state(state)
}

async fn receive_sync_shadow_telemetry(
    State(state): State<TelemetryHttpState>,
    ConnectInfo(peer_address): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    payload: Result<Json<TelemetryPayload>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let payload = match payload {
        Ok(Json(payload)) => payload,
        Err(rejection) => return rejection.into_response(),
    };

    if let Err(error) = payload.validate(Utc::now()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: error.code(),
            }),
        )
            .into_response();
    }

    let remote_ip = resolve_client_ip(peer_address.ip(), &headers, &state.trusted_proxy_cidrs);
    let request_id = Uuid::new_v4();

    match state
        .rate_limiter
        .admit(&payload.install_id_hash, remote_ip)
        .await
    {
        Admission::Allowed => {}
        Admission::Limited {
            retry_after_seconds,
        } => {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(ErrorResponse {
                    error: "rate_limited",
                }),
            )
                .into_response();
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&retry_after_seconds.to_string())
                    .expect("retry-after value is valid"),
            );
            response.headers_mut().insert(
                HeaderName::from_static("x-request-id"),
                HeaderValue::from_str(&request_id.to_string())
                    .expect("UUID is a valid header value"),
            );
            return response;
        }
    }

    match state
        .repository
        .insert_sync_shadow(&payload, remote_ip, request_id)
        .await
    {
        Ok(()) => {
            debug!(%request_id, "sync-shadow telemetry accepted");
            no_content(request_id)
        }
        Err(error) => {
            error!(%error, %request_id, "failed to save sync-shadow telemetry");
            let mut response = (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ErrorResponse {
                    error: "storage_unavailable",
                }),
            )
                .into_response();
            response.headers_mut().insert(
                HeaderName::from_static("x-request-id"),
                HeaderValue::from_str(&request_id.to_string())
                    .expect("UUID is a valid header value"),
            );
            response
        }
    }
}

fn no_content(request_id: Uuid) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        HeaderName::from_static("x-request-id"),
        HeaderValue::from_str(&request_id.to_string()).expect("UUID is a valid header value"),
    );
    response
}

fn resolve_client_ip(
    peer_ip: IpAddr,
    headers: &HeaderMap,
    trusted_proxy_cidrs: &[ipnet::IpNet],
) -> Option<IpAddr> {
    if !trusted_proxy_cidrs
        .iter()
        .any(|cidr| cidr.contains(&peer_ip))
    {
        return Some(peer_ip);
    }

    let forwarded_for = headers.get("x-forwarded-for")?.to_str().ok()?;
    let addresses = forwarded_for
        .split(',')
        .map(str::trim)
        .map(str::parse::<IpAddr>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;

    addresses
        .into_iter()
        .rev()
        .find(|address| {
            !trusted_proxy_cidrs
                .iter()
                .any(|cidr| cidr.contains(address))
        })
        .or(Some(peer_ip))
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use ipnet::IpNet;

    use super::*;

    #[test]
    fn ignores_forwarded_headers_from_an_untrusted_peer() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("198.51.100.10"));

        assert_eq!(
            resolve_client_ip("203.0.113.7".parse().unwrap(), &headers, &[]),
            Some("203.0.113.7".parse().unwrap()),
        );
    }

    #[test]
    fn takes_the_last_untrusted_address_from_a_trusted_proxy_chain() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-for",
            HeaderValue::from_static("198.51.100.10, 10.42.0.5"),
        );
        let trusted = vec!["10.42.0.0/16".parse::<IpNet>().unwrap()];

        assert_eq!(
            resolve_client_ip("10.42.0.5".parse().unwrap(), &headers, &trusted),
            Some("198.51.100.10".parse().unwrap()),
        );
    }
}
