// CORS 配置与中间件辅助

export const DEFAULT_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

// 允许 credentials: omit 的 CORS 头（遥测等匿名端点使用）
export const ANONYMOUS_CORS_HEADERS: Record<string, string> = {
  ...DEFAULT_CORS_HEADERS,
};

// 添加 CORS 头到已有 Response
export function withCors(response: Response, headers = DEFAULT_CORS_HEADERS): Response {
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const [key, value] of Object.entries(headers)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

// 处理 OPTIONS 预检请求
export function handleCorsPreflight(headers = DEFAULT_CORS_HEADERS): Response {
  return new Response(null, {
    status: 204,
    headers,
  });
}
