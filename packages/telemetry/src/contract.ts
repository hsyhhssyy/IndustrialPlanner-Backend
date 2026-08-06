// 请求体契约校验
// 与前端当前实际发送的 JSON 合约对齐

import type {
  TelemetryShadowV1,
} from "@industrial/shared";
import type { TelemetryRecord, TelemetryValidation } from "./model";

// 允许的最大 body 大小 (1KB)
const MAX_BODY_BYTES = 1024;

// trigger 字段最大长度
const MAX_TRIGGER_LENGTH = 128;

// install_id hash 格式：32 位 hex 字符串
const HASH_PATTERN = /^[a-f0-9]{32}$/i;

export function validateTelemetryV1(
  body: unknown,
  clientIp: string,
): TelemetryValidation {
  if (body === null || typeof body !== "object") {
    return { valid: false, error: "请求体必须是 JSON 对象" };
  }

  const data = body as TelemetryShadowV1;

  // schemaVersion
  if (data.schemaVersion !== 1) {
    return { valid: false, error: `不支持的 schemaVersion: ${data.schemaVersion}` };
  }

  // installIdHash
  if (typeof data.installIdHash !== "string" || !HASH_PATTERN.test(data.installIdHash)) {
    return { valid: false, error: "installIdHash 必须是 32 位十六进制字符串" };
  }

  // trigger
  if (typeof data.trigger !== "string" || data.trigger.length === 0) {
    return { valid: false, error: "trigger 不能为空" };
  }
  if (data.trigger.length > MAX_TRIGGER_LENGTH) {
    return { valid: false, error: `trigger 不能超过 ${MAX_TRIGGER_LENGTH} 个字符` };
  }

  // body 大小校验
  const bodyStr = JSON.stringify(data);
  if (bodyStr.length > MAX_BODY_BYTES) {
    return { valid: false, error: `请求体不能超过 ${MAX_BODY_BYTES} 字节` };
  }

  const now = new Date().toISOString();
  const record: TelemetryRecord = {
    installIdHash: data.installIdHash.toLowerCase(),
    trigger: data.trigger,
    createdAt: now,
    payload: data.payload ? JSON.stringify(data.payload) : undefined,
  };

  return { valid: true, record };
}
