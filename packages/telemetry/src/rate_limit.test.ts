import { describe, it, expect, vi } from "vitest";
import { checkRateLimit, type RateLimitKv } from "./rate_limit";

function createMockKv(initialValue?: string): RateLimitKv {
  let store = new Map<string, { value: string; ttl?: number }>();
  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      return entry?.value ?? null;
    }),
    put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: options?.expirationTtl });
    }),
  };
}

describe("checkRateLimit", () => {
  it("首次请求允许通过", async () => {
    const kv = createMockKv();
    const result = await checkRateLimit(kv, "1.2.3.4");
    expect(result.allowed).toBe(true);
  });

  it("第 10 次请求允许通过（边界）", async () => {
    const kv = createMockKv();
    // 预设计数为 9
    const now = Math.floor(Date.now() / 1000);
    const kvKey = `rl:1.2.3.4:${Math.floor(now / 60)}`;
    await kv.put(kvKey, "9");

    const result = await checkRateLimit(kv, "1.2.3.4");
    expect(result.allowed).toBe(true);
  });

  it("第 11 次请求被限流", async () => {
    const kv = createMockKv();
    const now = Math.floor(Date.now() / 1000);
    const kvKey = `rl:1.2.3.4:${Math.floor(now / 60)}`;
    await kv.put(kvKey, "10");

    const result = await checkRateLimit(kv, "1.2.3.4");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThan(0);
    }
  });

  it("不同 key 独立计数", async () => {
    const kv = createMockKv();
    const now = Math.floor(Date.now() / 1000);
    await kv.put(`rl:1.2.3.4:${Math.floor(now / 60)}`, "10");
    await kv.put(`rl:5.6.7.8:${Math.floor(now / 60)}`, "1");

    const resultA = await checkRateLimit(kv, "1.2.3.4");
    expect(resultA.allowed).toBe(false);

    const resultB = await checkRateLimit(kv, "5.6.7.8");
    expect(resultB.allowed).toBe(true);
  });
});
