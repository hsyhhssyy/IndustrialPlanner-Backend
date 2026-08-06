// Telemetry 领域模型

export interface TelemetryRecord {
  installIdHash: string;
  trigger: string;
  createdAt: string;   // ISO 8601
  payload?: string;     // JSON string
}

// 请求校验结果
export interface TelemetryValidation {
  valid: true;
  record: TelemetryRecord;
} | {
  valid: false;
  error: string;
}

// 幂等键：同一 install_id + 同一天 + 同一 trigger 只保留一条
export interface IdempotencyKey {
  installIdHash: string;
  createdDate: string;   // YYYY-MM-DD
  trigger: string;
}
