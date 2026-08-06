import { describe, it, expect } from "vitest";
import { errorResponse, successResponse, Errors } from "./errors";

describe("errors", () => {
  it("errorResponse 返回正确结构", () => {
    const res = errorResponse(400, "bad_request", "invalid field", { field: "email" });
    expect(res.status).toBe(400);
    return res.json().then((body) => {
      expect(body.error).toBe("bad_request");
      expect(body.message).toBe("invalid field");
      expect(body.details).toEqual({ field: "email" });
    });
  });

  it("successResponse 返回正确结构", () => {
    const res = successResponse({ id: "1" }, 201);
    expect(res.status).toBe(201);
    return res.json().then((body) => {
      expect(body.data).toEqual({ id: "1" });
    });
  });

  it("Errors 快捷方式生成正确状态码", () => {
    expect(Errors.badRequest("x").status).toBe(400);
    expect(Errors.unauthorized().status).toBe(401);
    expect(Errors.forbidden().status).toBe(403);
    expect(Errors.notFound().status).toBe(404);
    expect(Errors.conflict("x").status).toBe(409);
    expect(Errors.tooManyRequests().status).toBe(429);
    expect(Errors.internal().status).toBe(500);
  });
});
