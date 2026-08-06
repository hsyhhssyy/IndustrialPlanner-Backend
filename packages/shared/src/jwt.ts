// JWT 签发与验证
// 
// 当前阶段只提供接口骨架，实际签名/验证逻辑在 identity-worker 实现阶段完成。
// Gateway 目前只透传 Authorization header，不解析 JWT 内容。

export interface JwtPayload {
  sub: string;       // user_id
  exp: number;       // 过期时间 (unix timestamp)
  iat: number;       // 签发时间
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

// JWT 验证（当前为骨架，identity-worker 实现后补充签名验证）
export async function verifyToken(token: string, _secret: string): Promise<JwtPayload | null> {
  // 骨架实现：尝试解码 base64url 的 JWT payload（不验证签名）
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (decoded.sub && decoded.exp && decoded.iat) {
      return decoded as JwtPayload;
    }
    return null;
  } catch {
    return null;
  }
}
