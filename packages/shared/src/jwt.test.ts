import { describe, it, expect } from "vitest";
import { SignJWT } from "jose";
import {
  SESSION_JWT_AUDIENCE,
  SESSION_JWT_ISSUER,
  extractBearerToken,
  signJwt,
  verifyJwt,
  verifyRequestJwt,
  verifyToken,
} from "./jwt";

const SECRET = "shared-jwt-test-secret-with-at-least-32-bytes";
const OTHER_SECRET = "shared-jwt-other-secret-with-at-least-32-bytes";

describe("jwt", () => {
  it("extractBearerToken 从 Authorization header 提取 token", () => {
    const req = new Request("https://example.com", {
      headers: { authorization: "Bearer my-token-123" },
    });
    expect(extractBearerToken(req)).toBe("my-token-123");
  });

  it("extractBearerToken 缺少 header 返回 null", () => {
    const req = new Request("https://example.com");
    expect(extractBearerToken(req)).toBeNull();
  });

  // AI-CORRECTION 2026-08-23: 原骨架测试改为验证兼容入口会执行真实签名校验。
  it("verifyToken 骨架解码 JWT payload", async () => {
    // base64url("{\"sub\":\"user1\",\"exp\":9999999999,\"iat\":1}") => eyJzdWIiOiJ1c2VyMSIsImV4cCI6OTk5OTk5OTk5OSwiaWF0IjoxfQ
    // AI-CORRECTION 2026-08-23: 不再构造 alg=none 假 token，改为使用正式 signJwt 生成会话。
    const token = await signJwt({ sub: "user1", iat: 1, exp: 9999999999 }, SECRET);
    const result = await verifyToken(token, SECRET);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("user1");
  });

  it("signJwt 与 verifyJwt 完成 HS256 往返", async () => {
    const token = await signJwt({ sub: "account-1", iat: 1_000, exp: 2_000 }, SECRET);
    await expect(verifyJwt(token, SECRET, 1_500)).resolves.toEqual({
      ok: true,
      payload: { sub: "account-1", iat: 1_000, exp: 2_000 },
    });
  });

  it("拒绝篡改签名和错误 secret", async () => {
    const token = await signJwt({ sub: "account-1", iat: 1_000, exp: 2_000 }, SECRET);
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -1)}x`;
    await expect(verifyJwt(tampered, SECRET, 1_500)).resolves.toEqual({
      ok: false,
      code: "token_invalid",
    });
    await expect(verifyJwt(token, OTHER_SECRET, 1_500)).resolves.toEqual({
      ok: false,
      code: "token_invalid",
    });
  });

  it("区分过期 token", async () => {
    const token = await signJwt({ sub: "account-1", iat: 1_000, exp: 2_000 }, SECRET);
    await expect(verifyJwt(token, SECRET, 2_000)).resolves.toEqual({
      ok: false,
      code: "token_expired",
    });
  });

  it("拒绝错误 issuer、缺字段和未来 iat", async () => {
    const key = new TextEncoder().encode(SECRET);
    const wrongIssuer = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("other-issuer")
      .setAudience(SESSION_JWT_AUDIENCE)
      .setSubject("account-1")
      .setIssuedAt(1_000)
      .setExpirationTime(2_000)
      .sign(key);
    const missingSubject = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(SESSION_JWT_AUDIENCE)
      .setIssuedAt(1_000)
      .setExpirationTime(2_000)
      .sign(key);
    const futureIssuedAt = await signJwt(
      { sub: "account-1", iat: 1_600, exp: 2_000 },
      SECRET,
    );

    await expect(verifyJwt(wrongIssuer, SECRET, 1_500)).resolves.toEqual({ ok: false, code: "token_invalid" });
    await expect(verifyJwt(missingSubject, SECRET, 1_500)).resolves.toEqual({ ok: false, code: "token_invalid" });
    await expect(verifyJwt(futureIssuedAt, SECRET, 1_500)).resolves.toEqual({ ok: false, code: "token_invalid" });
  });

  it("拒绝短 secret 和无效 payload", async () => {
    await expect(signJwt({ sub: "account-1", iat: 1, exp: 2 }, "short")).rejects.toThrow(
      "JWT secret 至少需要 32 字节",
    );
    await expect(signJwt({ sub: "", iat: 1, exp: 2 }, SECRET)).rejects.toThrow("JWT payload 无效");
  });

  it("区分请求未携带、格式错误与合法 Bearer 会话", async () => {
    const token = await signJwt({ sub: "account-1", iat: 1, exp: 9_999_999_999 }, SECRET);
    await expect(verifyRequestJwt(new Request("https://example.com"), SECRET)).resolves.toEqual({
      ok: false,
      code: "token_missing",
    });
    await expect(verifyRequestJwt(new Request("https://example.com", {
      headers: { authorization: "Basic bad" },
    }), SECRET)).resolves.toEqual({ ok: false, code: "token_invalid" });
    await expect(verifyRequestJwt(new Request("https://example.com", {
      headers: { authorization: `Bearer ${token}` },
    }), SECRET)).resolves.toEqual({ ok: true, accountId: "account-1" });
  });
});
