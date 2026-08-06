// KV 固定窗口限流

// KV 限流绑定类型
export interface RateLimitKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: KvPutOptions): Promise<void>;
}

interface KvPutOptions {
  expirationTtl?: number;
}

// 默认限流：每个 IP 每分钟最多 10 次
const DEFAULT_MAX_REQUESTS = 10;
const DEFAULT_WINDOW_SECONDS = 60;

// 检查是否被限流，未限流则递增计数
export async function checkRateLimit(
  kv: RateLimitKv,
  key: string,
  maxRequests = DEFAULT_MAX_REQUESTS,
  windowSeconds = DEFAULT_WINDOW_SECONDS,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSeconds;
  const kvKey = `rl:${key}:${Math.floor(now / windowSeconds)}`;

  try {
    const current = await kv.get(kvKey);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= maxRequests) {
      return { allowed: false, retryAfter: windowSeconds - (now % windowSeconds) };
    }

    await kv.put(kvKey, String(count + 1), {
      expirationTtl: windowSeconds + 1,
    });

    return { allowed: true };
  } catch {
    // KV 不可用时降级：允许通过，不阻塞业务
    return { allowed: true };
  }
}
