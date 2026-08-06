import type { ApiError } from "./types";

// 统一错误响应构造
export function errorResponse(
  status: number,
  error: string,
  message: string,
  details?: unknown,
): Response {
  const body: ApiError = { error, message };
  if (details !== undefined) {
    body.details = details;
  }
  return Response.json(body, { status });
}

// 统一成功响应构造
export function successResponse<T>(data: T, status = 200): Response {
  return Response.json({ data }, { status });
}

// 常用错误快捷方式
export const Errors = {
  badRequest: (message: string, details?: unknown) =>
    errorResponse(400, "bad_request", message, details),

  unauthorized: (message = "Unauthorized") =>
    errorResponse(401, "unauthorized", message),

  forbidden: (message = "Forbidden") =>
    errorResponse(403, "forbidden", message),

  notFound: (message = "Not found") =>
    errorResponse(404, "not_found", message),

  conflict: (message: string) =>
    errorResponse(409, "conflict", message),

  tooManyRequests: (message = "Too many requests") =>
    errorResponse(429, "too_many_requests", message),

  internal: (message = "Internal server error") =>
    errorResponse(500, "internal_error", message),
};
