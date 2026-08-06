import { describe, it, expect } from "vitest";
import { parseJsonBody, getPathname } from "./utils";

describe("utils", () => {
  it("parseJsonBody 解析有效 JSON", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: JSON.stringify({ name: "test" }),
    });
    const result = await parseJsonBody<{ name: string }>(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("test");
    }
  });

  it("parseJsonBody 拒绝非法 JSON", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: "not json",
    });
    const result = await parseJsonBody(req);
    expect(result.ok).toBe(false);
  });

  it("getPathname 提取路径", () => {
    const req = new Request("https://example.com/api/v1/test");
    expect(getPathname(req)).toBe("/api/v1/test");
  });
});
