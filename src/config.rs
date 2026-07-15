use std::{env, net::SocketAddr, num::NonZeroU32};

use ipnet::IpNet;
use thiserror::Error;

pub(crate) struct Config {
    pub(crate) database_url: String,
    pub(crate) redis_url: Option<String>,
    pub(crate) http_bind_addr: SocketAddr,
    pub(crate) trusted_proxy_cidrs: Vec<IpNet>,
    pub(crate) telemetry_max_body_bytes: usize,
    pub(crate) telemetry_rate_window_seconds: NonZeroU32,
    pub(crate) telemetry_global_rate_limit: NonZeroU32,
    pub(crate) telemetry_identity_rate_limit: NonZeroU32,
    pub(crate) telemetry_ip_rate_limit: NonZeroU32,
    pub(crate) database_max_connections: u32,
}

#[derive(Debug, Error)]
pub(crate) enum ConfigError {
    #[error("environment variable {name} must be set")]
    Missing { name: &'static str },
    #[error("environment variable {name} has an invalid value: {reason}")]
    Invalid { name: &'static str, reason: String },
}

impl Config {
    pub(crate) fn from_env() -> Result<Self, ConfigError> {
        let trusted_proxy_cidrs = env::var("TRUSTED_PROXY_CIDRS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|value| {
                let value = value.trim();
                (!value.is_empty()).then_some(value)
            })
            .map(|value| {
                value
                    .parse::<IpNet>()
                    .map_err(|error| ConfigError::Invalid {
                        name: "TRUSTED_PROXY_CIDRS",
                        reason: error.to_string(),
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            database_url: required("DATABASE_URL")?,
            redis_url: optional("REDIS_URL"),
            http_bind_addr: parse("HTTP_BIND_ADDR", "0.0.0.0:8080")?,
            trusted_proxy_cidrs,
            telemetry_max_body_bytes: parse("TELEMETRY_MAX_BODY_BYTES", "65536")?,
            telemetry_rate_window_seconds: parse_nonzero("TELEMETRY_RATE_WINDOW_SECONDS", "60")?,
            telemetry_global_rate_limit: parse_nonzero("TELEMETRY_GLOBAL_RATE_LIMIT", "600")?,
            telemetry_identity_rate_limit: parse_nonzero("TELEMETRY_IDENTITY_RATE_LIMIT", "30")?,
            telemetry_ip_rate_limit: parse_nonzero("TELEMETRY_IP_RATE_LIMIT", "60")?,
            database_max_connections: parse("DATABASE_MAX_CONNECTIONS", "10")?,
        })
    }
}

fn required(name: &'static str) -> Result<String, ConfigError> {
    optional(name).ok_or(ConfigError::Missing { name })
}

fn optional(name: &'static str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn parse<T>(name: &'static str, default: &'static str) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    env::var(name)
        .unwrap_or_else(|_| default.to_owned())
        .parse::<T>()
        .map_err(|error| ConfigError::Invalid {
            name,
            reason: error.to_string(),
        })
}

fn parse_nonzero(name: &'static str, default: &'static str) -> Result<NonZeroU32, ConfigError> {
    parse(name, default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_environment_value_ignores_empty_values() {
        assert_eq!("", "".trim());
    }

    #[test]
    fn nonzero_values_reject_zero() {
        assert!(parse_nonzero("UNUSED_FOR_TEST", "0").is_err());
    }
}
