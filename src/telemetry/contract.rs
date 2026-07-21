use std::collections::BTreeMap;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const MAX_TRIGGER_LENGTH: usize = 128;
const MAX_APP_VERSION_LENGTH: usize = 128;
const MAX_HASH_LENGTH: usize = 128;
const MAX_DIAGNOSTICS: usize = 50;
const MAX_COMPACT_SUMMARIES: usize = 20;
const MAX_DIAGNOSTIC_STRING_LENGTH: usize = 128;
const MAX_DETAIL_FIELDS: usize = 32;
const MAX_DETAIL_KEY_LENGTH: usize = 64;
const MAX_DETAIL_STRING_LENGTH: usize = 200;
const MAX_SCREEN_DIMENSION: u32 = 16384;
const MIN_DEVICE_PIXEL_RATIO: f64 = 0.1;
const MAX_DEVICE_PIXEL_RATIO: f64 = 10.0;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TelemetryPayload {
    pub(crate) schema_version: u8,
    pub(crate) source: String,
    pub(crate) trigger: String,
    pub(crate) created_at: DateTime<Utc>,
    pub(crate) app_version: Option<String>,
    pub(crate) user_agent_hash: Option<String>,
    pub(crate) install_id_hash: String,
    pub(crate) device_id_hash: String,
    pub(crate) owner_kind: OwnerKind,
    pub(crate) owner_scope_hash: String,
    pub(crate) device_type: Option<DeviceType>,
    pub(crate) screen_width: Option<u32>,
    pub(crate) screen_height: Option<u32>,
    pub(crate) device_pixel_ratio: Option<f64>,
    pub(crate) diagnostics: Vec<DiagnosticEvent>,
    pub(crate) compact_summaries: Vec<CompactSummary>,
}

impl TelemetryPayload {
    pub(crate) fn validate(&self, now: DateTime<Utc>) -> Result<(), ValidationError> {
        if self.schema_version != 1 || self.source != "industrial-planner" {
            return Err(ValidationError::UnsupportedSchema);
        }
        validate_text(&self.trigger, MAX_TRIGGER_LENGTH)?;
        validate_optional_text(&self.app_version, MAX_APP_VERSION_LENGTH)?;
        validate_optional_hash(&self.user_agent_hash)?;
        validate_hash(&self.install_id_hash)?;
        validate_hash(&self.device_id_hash)?;
        validate_hash(&self.owner_scope_hash)?;

        if self.created_at > now + Duration::days(1) {
            return Err(ValidationError::FutureTimestamp);
        }
        if self.diagnostics.len() > MAX_DIAGNOSTICS
            || self.compact_summaries.len() > MAX_COMPACT_SUMMARIES
        {
            return Err(ValidationError::TooManyItems);
        }
        if let Some(w) = self.screen_width {
            if w == 0 || w > MAX_SCREEN_DIMENSION {
                return Err(ValidationError::InvalidDeviceInfo);
            }
        }
        if let Some(h) = self.screen_height {
            if h == 0 || h > MAX_SCREEN_DIMENSION {
                return Err(ValidationError::InvalidDeviceInfo);
            }
        }
        if let Some(dpr) = self.device_pixel_ratio {
            if !(MIN_DEVICE_PIXEL_RATIO..=MAX_DEVICE_PIXEL_RATIO).contains(&dpr)
                || dpr.is_nan()
                || dpr.is_infinite()
            {
                return Err(ValidationError::InvalidDeviceInfo);
            }
        }
        for diagnostic in &self.diagnostics {
            diagnostic.validate()?;
        }
        for summary in &self.compact_summaries {
            summary.validate()?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OwnerKind {
    Anonymous,
    Account,
}

impl OwnerKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Anonymous => "anonymous",
            Self::Account => "account",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DeviceType {
    Tablet,
    Mobile,
    Pc,
}

impl DeviceType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Tablet => "tablet",
            Self::Mobile => "mobile",
            Self::Pc => "pc",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiagnosticEvent {
    severity: String,
    category: String,
    code: String,
    asset_type: String,
    asset_id_hash: Option<String>,
    local_sequence: Option<i64>,
    details: BTreeMap<String, DetailValue>,
    created_at: DateTime<Utc>,
}

impl DiagnosticEvent {
    fn validate(&self) -> Result<(), ValidationError> {
        validate_text(&self.severity, MAX_DIAGNOSTIC_STRING_LENGTH)?;
        validate_text(&self.category, MAX_DIAGNOSTIC_STRING_LENGTH)?;
        validate_text(&self.code, MAX_DIAGNOSTIC_STRING_LENGTH)?;
        validate_text(&self.asset_type, MAX_DIAGNOSTIC_STRING_LENGTH)?;
        validate_optional_hash(&self.asset_id_hash)?;
        if self.details.len() > MAX_DETAIL_FIELDS {
            return Err(ValidationError::TooManyItems);
        }
        for (key, value) in &self.details {
            validate_text(key, MAX_DETAIL_KEY_LENGTH)?;
            if let DetailValue::Text(value) = value {
                validate_text(value, MAX_DETAIL_STRING_LENGTH)?;
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum DetailValue {
    Text(String),
    Number(serde_json::Number),
    Boolean(bool),
    Null(()),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CompactSummary {
    asset_type: String,
    asset_id_hash: String,
    from_local_sequence: i64,
    to_local_sequence: i64,
    operation_count: i64,
    base_content_hash: String,
    compacted_at: DateTime<Utc>,
}

impl CompactSummary {
    fn validate(&self) -> Result<(), ValidationError> {
        if self.asset_type != "world-document"
            || self.from_local_sequence < 0
            || self.to_local_sequence < self.from_local_sequence
            || self.operation_count < 0
        {
            return Err(ValidationError::InvalidSummary);
        }
        validate_hash(&self.asset_id_hash)?;
        validate_hash(&self.base_content_hash)
    }
}

fn validate_optional_text(
    value: &Option<String>,
    max_length: usize,
) -> Result<(), ValidationError> {
    if let Some(value) = value {
        validate_text(value, max_length)?;
    }
    Ok(())
}

fn validate_optional_hash(value: &Option<String>) -> Result<(), ValidationError> {
    if let Some(value) = value {
        validate_hash(value)?;
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), ValidationError> {
    validate_text(value, MAX_HASH_LENGTH)?;
    let Some((algorithm, digest)) = value.split_once(':') else {
        return Err(ValidationError::InvalidHash);
    };
    let expected_length = match algorithm {
        "fnv1a32" => 8,
        "sha256" => 64,
        _ => return Err(ValidationError::InvalidHash),
    };
    if digest.len() != expected_length
        || !digest
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(ValidationError::InvalidHash);
    }
    Ok(())
}

fn validate_text(value: &str, max_length: usize) -> Result<(), ValidationError> {
    if value.trim().is_empty() || value.len() > max_length || value.contains('\0') {
        return Err(ValidationError::InvalidField);
    }
    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum ValidationError {
    #[error("unsupported telemetry schema")]
    UnsupportedSchema,
    #[error("telemetry timestamp is too far in the future")]
    FutureTimestamp,
    #[error("telemetry payload has too many items")]
    TooManyItems,
    #[error("telemetry payload has an invalid field")]
    InvalidField,
    #[error("telemetry hash has an invalid format")]
    InvalidHash,
    #[error("telemetry compact summary is invalid")]
    InvalidSummary,
    #[error("telemetry device info is invalid")]
    InvalidDeviceInfo,
}

impl ValidationError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedSchema => "unsupported_schema",
            Self::FutureTimestamp => "future_timestamp",
            Self::TooManyItems => "too_many_items",
            Self::InvalidField => "invalid_field",
            Self::InvalidHash => "invalid_hash",
            Self::InvalidSummary => "invalid_summary",
            Self::InvalidDeviceInfo => "invalid_device_info",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_payload() -> TelemetryPayload {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "source": "industrial-planner",
            "trigger": "sync-shadow-heartbeat",
            "createdAt": "2026-07-15T00:00:00Z",
            "appVersion": "1.4.0",
            "userAgentHash": "fnv1a32:12345678",
            "installIdHash": "fnv1a32:12345678",
            "deviceIdHash": "fnv1a32:12345678",
            "ownerKind": "anonymous",
            "ownerScopeHash": "fnv1a32:12345678",
            "diagnostics": [],
            "compactSummaries": []
        }))
        .expect("fixture is valid JSON")
    }

    #[test]
    fn accepts_the_frontend_contract() {
        assert!(valid_payload().validate(Utc::now()).is_ok());
    }

    #[test]
    fn rejects_unknown_top_level_fields() {
        let mut value = serde_json::to_value(valid_payload()).unwrap();
        value["rawOwnerId"] = serde_json::json!("must-not-be-accepted");
        assert!(serde_json::from_value::<TelemetryPayload>(value).is_err());
    }

    #[test]
    fn rejects_unhashed_identity_values() {
        let mut payload = valid_payload();
        payload.install_id_hash = "plain-text-value".to_owned();
        assert!(matches!(
            payload.validate(Utc::now()),
            Err(ValidationError::InvalidHash)
        ));
    }
}
