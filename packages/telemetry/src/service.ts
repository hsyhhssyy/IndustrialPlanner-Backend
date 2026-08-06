// 业务用例编排

import type { TelemetryRecord } from "./model";
import { validateTelemetryV1 } from "./contract";
import type { TelemetryDb } from "./repository";
import { insertTelemetry, checkDbHealth } from "./repository";
import type { RateLimitKv } from "./rate_limit";
import { checkRateLimit } from "./rate_limit";
import { parseJsonBody } from "@industrial/shared";

// 遥测上传结果
export type TelemetryResult =
  | { ok: true }
  | { ok: false; status: number; error: string; message: string; retryAfter?: number };

// 处理匿名遥测上传
export async function handleTelemetryUpload(
  request: Request,
  db: TelemetryDb,
  kv: RateLimitKv,
  clientIp: string,
): Promise<TelemetryResult> {
  // 1. 限流检查
  const rateLimit = await checkRateLimit(kv, clientIp);
  if (!rateLimit.allowed) {
    return {
      ok: false,
      status: 429,
      error: "too_many_requests",
      message: "请求过于频繁",
      retryAfter: rateLimit.retryAfter,
    };
  }

  // 2. 解析请求体
  const bodyResult = await parseJsonBody(request);
  if (!bodyResult.ok) {
    return {
      ok: false,
      status: 400,
      error: "bad_request",
      message: bodyResult.error,
    };
  }

  // 3. 校验遥测数据
  const validation = validateTelemetryV1(bodyResult.data, clientIp);
  if (!validation.valid) {
    return {
      ok: false,
      status: 400,
      error: "bad_request",
      message: validation.error,
    };
  }

  // 4. 写入数据库（幂等）
  const insertResult = await insertTelemetry(db, validation.record);
  if (!insertResult.success) {
    return {
      ok: false,
      status: 500,
      error: "internal_error",
      message: "遥测存储失败",
    };
  }

  return { ok: true };
}

// 健康检查
export async function handleHealthCheck(db: TelemetryDb): Promise<TelemetryResult> {
  const dbHealthy = await checkDbHealth(db);
  if (!dbHealthy) {
    return {
      ok: false,
      status: 503,
      error: "service_unavailable",
      message: "数据库不可用",
    };
  }
  return { ok: true };
}
