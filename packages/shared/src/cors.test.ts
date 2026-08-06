import { describe, it, expect } from "vitest";
import { handleCorsPreflight, withCors } from "./cors";

describe("cors", () => {
  it("handleCorsPreflight 返回 204 和 CORS 头", () => {
    const res = handleCorsPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("withCors 为 Response 添加 CORS 头", () => {
    const original = new Response("ok", { status: 200 });
    const res = withCors(original);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
