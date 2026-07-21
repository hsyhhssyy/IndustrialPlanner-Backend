//! 临时匿名遥测能力的最小公开出口。
//!
//! 协议、HTTP、持久化和限流适配分别保留在本能力内部，删除本模块不会影响正式业务能力。

#[path = "telemetry/contract.rs"]
mod contract;
#[path = "telemetry/http.rs"]
mod http;
#[path = "telemetry/rate_limit.rs"]
mod rate_limit;
#[path = "telemetry/repository.rs"]
mod repository;

pub(crate) use contract::{DeviceType, TelemetryPayload};
pub(crate) use http::{TelemetryHttpState, router};
pub(crate) use rate_limit::{Admission, RateLimitConfig, RateLimiter};
pub(crate) use repository::TelemetryRepository;
