// 跨 Worker 共享的错误响应格式
export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  /** 非生产环境时附带的原始错误消息 */
  originalError?: string;
  /** 非生产环境时附带的原始错误堆栈 */
  originalStack?: string;
}

// 成功响应包装
export interface ApiResponse<T> {
  data: T;
}

// 健康检查响应
export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
}

// 遥测请求体（v1）
export interface TelemetryShadowV1 {
  schemaVersion: 1;
  installIdHash: string;
  trigger: string;
  payload?: Record<string, unknown>;
}

// 账户 ID 类型（供跨 Worker 引用）
export type AccountId = string;

// 资产 ID 类型
export type AssetId = string;

// 内部端点响应：账户存在性
export interface AccountExistsResponse {
  exists: boolean;
}

// 内部端点响应：资产 Meta
export interface AssetMetaResponse {
  id: AssetId;
  accountId: AccountId;
  type: string;
  revision: number;
  contentHash: string | null;
  r2Key: string | null;
  size: number;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
