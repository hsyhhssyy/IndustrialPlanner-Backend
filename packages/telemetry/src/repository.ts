// D1 持久化 — 遥测记录存储

import type { TelemetryRecord } from "./model";

// D1 数据库绑定类型
export interface TelemetryDb {
  prepare(query: string): D1PreparedStatement;
  exec(query: string): Promise<D1Result>;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Result<T = Record<string, unknown>> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: {
    rows_read?: number;
    rows_written?: number;
  };
}

// 写入遥测记录（使用 INSERT OR REPLACE 实现幂等：同一天 + 同一 install_id + 同一 trigger 只保留最新一条）
export async function insertTelemetry(
  db: TelemetryDb,
  record: TelemetryRecord,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const createdDate = record.createdAt.slice(0, 10); // YYYY-MM-DD

    const stmt = db
      .prepare(
        `INSERT OR REPLACE INTO telemetry_shadow (install_id_hash, created_date, trigger, created_at, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        record.installIdHash,
        createdDate,
        record.trigger,
        record.createdAt,
        record.payload ?? null,
      );

    await stmt.run();
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

// 健康检查：验证数据库可访问
export async function checkDbHealth(db: TelemetryDb): Promise<boolean> {
  try {
    const stmt = db.prepare("SELECT 1 as ok");
    const result = await stmt.first<{ ok: number }>();
    return result?.ok === 1;
  } catch {
    return false;
  }
}
