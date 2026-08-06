import { describe, it, expect } from "vitest";
import { extractBearerToken, verifyToken } from "./jwt";

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

  it("verifyToken 骨架解码 JWT payload", async () => {
    // base64url("{\"sub\":\"user1\",\"exp\":9999999999,\"iat\":1}") => eyJzdWIiOiJ1c2VyMSIsImV4cCI6OTk5OTk5OTk5OSwiaWF0IjoxfQ
    const header = btoa(JSON.stringify({ alg: "none" })).replace(/=/g, "");
    const payload = btoa(JSON.stringify({ sub: "user1", exp: 9999999999, iat: 1 })).replace(/=/g, "");
    const token = `${header}.${payload}.fake-sig`;
    const result = await verifyToken(token, "secret");
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("user1");
  });
});
