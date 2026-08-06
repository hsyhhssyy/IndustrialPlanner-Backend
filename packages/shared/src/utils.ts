// 解析请求体为 JSON，失败时返回友好错误
export async function parseJsonBody<T>(request: Request): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await request.json() as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: "无效的 JSON 请求体" };
  }
}

// 从请求 URL 提取路径段（用于路由匹配）
export function getPathname(request: Request): string {
  return new URL(request.url).pathname;
}
