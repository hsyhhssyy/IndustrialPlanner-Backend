use std::{net::IpAddr, num::NonZeroU32};

use redis::{AsyncCommands, aio::ConnectionManager};
use tracing::warn;

#[derive(Clone, Copy)]
pub(crate) struct RateLimitConfig {
    pub(crate) window_seconds: NonZeroU32,
    pub(crate) global_limit: NonZeroU32,
    pub(crate) identity_limit: NonZeroU32,
    pub(crate) ip_limit: NonZeroU32,
}

pub(crate) struct RateLimiter {
    connection: Option<ConnectionManager>,
    config: RateLimitConfig,
}

pub(crate) enum Admission {
    Allowed,
    Limited { retry_after_seconds: u32 },
}

impl RateLimiter {
    pub(crate) async fn new(redis_url: Option<&str>, config: RateLimitConfig) -> Self {
        let connection = match redis_url {
            Some(redis_url) => match redis::Client::open(redis_url) {
                Ok(client) => match ConnectionManager::new(client).await {
                    Ok(connection) => Some(connection),
                    Err(error) => {
                        warn!(%error, "Redis connection could not be established; rate limiting is disabled");
                        None
                    }
                },
                Err(error) => {
                    warn!(%error, "REDIS_URL is invalid; rate limiting is disabled");
                    None
                }
            },
            None => None,
        };

        Self { connection, config }
    }

    pub(crate) fn is_distributed(&self) -> bool {
        self.connection.is_some()
    }

    pub(crate) async fn admit(
        &self,
        install_id_hash: &str,
        remote_ip: Option<IpAddr>,
    ) -> Admission {
        let Some(connection) = &self.connection else {
            return Admission::Allowed;
        };
        let mut connection = connection.clone();

        let mut keys = vec![
            (
                "industrial-planner:telemetry:rate:global".to_owned(),
                self.config.global_limit,
            ),
            (
                format!(
                    "industrial-planner:telemetry:rate:install:{}",
                    install_id_hash
                ),
                self.config.identity_limit,
            ),
        ];
        if let Some(remote_ip) = remote_ip {
            keys.push((
                format!("industrial-planner:telemetry:rate:ip:{remote_ip}"),
                self.config.ip_limit,
            ));
        }

        for (key, limit) in keys {
            match consume(&mut connection, &key, limit, self.config.window_seconds).await {
                Ok(true) => {}
                Ok(false) => {
                    return Admission::Limited {
                        retry_after_seconds: self.config.window_seconds.get(),
                    };
                }
                Err(error) => {
                    warn!(%error, "Redis rate limit check failed; allowing telemetry request");
                    return Admission::Allowed;
                }
            }
        }

        Admission::Allowed
    }
}

async fn consume(
    connection: &mut ConnectionManager,
    key: &str,
    limit: NonZeroU32,
    window_seconds: NonZeroU32,
) -> redis::RedisResult<bool> {
    let count: u64 = connection.incr(key, 1).await?;
    if count == 1 {
        let _: bool = connection
            .expire(key, i64::from(window_seconds.get()))
            .await?;
    }
    Ok(count <= u64::from(limit.get()))
}
