// JWT 签发与验证
// 
// 当前阶段只提供接口骨架，实际签名/验证逻辑在 identity-worker 实现阶段完成。
// Gateway 目前只透传 Authorization header，不解析 JWT 内容。
// AI-CORRECTION 2026-08-23: Stage 2 已启用真实 HS256 会话签发/验签；gateway 负责第一层验签，下游 Worker 继续独立验签授权。

import { SignJWT, jwtVerify } from "jose";

export const SESSION_JWT_ISSUER = "industrial-identity";
export const SESSION_JWT_AUDIENCE = "industrial-api";
const MINIMUM_SECRET_BYTES = 32;

export interface JwtPayload {
  sub: string;       // user_id
  exp: number;       // 过期时间 (unix timestamp)
  iat: number;       // 签发时间
}

export type JwtVerificationResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; code: "token_invalid" | "token_expired" };

export type RequestJwtResult =
  | { ok: true; accountId: string }
  | { ok: false; code: "token_missing" | "token_invalid" | "token_expired" };

function secretKey(secret: string): Uint8Array {
  const key = new TextEncoder().encode(secret);
  if (key.byteLength < MINIMUM_SECRET_BYTES) {
    throw new Error("JWT secret 至少需要 32 字节");
  }
  return key;
}

function isJwtPayload(value: unknown): value is JwtPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.sub === "string"
    && payload.sub.length > 0
    && Number.isSafeInteger(payload.iat)
    && Number.isSafeInteger(payload.exp)
    && (payload.iat as number) >= 0
    && (payload.exp as number) > (payload.iat as number);
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  if (!isJwtPayload(payload)) {
    throw new Error("JWT payload 无效");
  }
  return await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setSubject(payload.sub)
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(secretKey(secret));
}

export async function verifyJwt(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): Promise<JwtVerificationResult> {
  try {
    const result = await jwtVerify(token, secretKey(secret), {
      algorithms: ["HS256"],
      issuer: SESSION_JWT_ISSUER,
      audience: SESSION_JWT_AUDIENCE,
      currentDate: new Date(now * 1000),
    });
    if (!isJwtPayload(result.payload) || result.payload.iat > now) {
      return { ok: false, code: "token_invalid" };
    }
    return {
      ok: true,
      payload: {
        sub: result.payload.sub,
        iat: result.payload.iat,
        exp: result.payload.exp,
      },
    };
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ERR_JWT_EXPIRED"
    ) {
      return { ok: false, code: "token_expired" };
    }
    return { ok: false, code: "token_invalid" };
  }
}

// 从 Authorization header 提取 Bearer token
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return null;
  }
  return parts[1] ?? null;
}

export async function verifyRequestJwt(
  request: Request,
  secret: string,
): Promise<RequestJwtResult> {
  const header = request.headers.get("authorization");
  if (header === null) return { ok: false, code: "token_missing" };
  const match = /^Bearer ([^\s]+)$/iu.exec(header);
  if (!match?.[1]) return { ok: false, code: "token_invalid" };
  const result = await verifyJwt(match[1], secret);
  return result.ok
    ? { ok: true, accountId: result.payload.sub }
    : result;
}

// JWT 验证（当前为骨架，identity-worker 实现后补充签名验证）
// AI-CORRECTION 2026-08-23: 保留原函数签名作为现有调用兼容入口，但底层改为真实验签并校验 issuer、audience 与过期时间。
export async function verifyToken(token: string, secret: string): Promise<JwtPayload | null> {
  const result = await verifyJwt(token, secret);
  return result.ok ? result.payload : null;
}
