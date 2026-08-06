import { describe, it, expect } from "vitest";
import { validateTelemetryV1 } from "./contract";

describe("validateTelemetryV1", () => {
  const validBody = {
    schemaVersion: 1 as const,
    installIdHash: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    trigger: "app_open",
  };

  it("合法请求通过校验", () => {
    const result = validateTelemetryV1(validBody, "1.2.3.4");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.record.installIdHash).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
      expect(result.record.trigger).toBe("app_open");
      expect(result.record.createdAt).toBeDefined();
    }
  });

  it("installIdHash 转小写", () => {
    const result = validateTelemetryV1(
      { ...validBody, installIdHash: "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6" },
      "1.2.3.4",
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.record.installIdHash).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
    }
  });

  it("未知字段通过校验（向前兼容）", () => {
    const result = validateTelemetryV1(
      { ...validBody, unknownField: "test" },
      "1.2.3.4",
    );
    expect(result.valid).toBe(true);
  });

  it("拒绝非对象请求体", () => {
    const result = validateTelemetryV1("string", "1.2.3.4");
    expect(result.valid).toBe(false);
  });

  it("拒绝错误 schemaVersion", () => {
    const result = validateTelemetryV1({ ...validBody, schemaVersion: 2 }, "1.2.3.4");
    expect(result.valid).toBe(false);
  });

  it("拒绝非法 installIdHash", () => {
    const result = validateTelemetryV1({ ...validBody, installIdHash: "not-hex" }, "1.2.3.4");
    expect(result.valid).toBe(false);
  });

  it("拒绝空 trigger", () => {
    const result = validateTelemetryV1({ ...validBody, trigger: "" }, "1.2.3.4");
    expect(result.valid).toBe(false);
  });

  it("拒绝超长 trigger", () => {
    const result = validateTelemetryV1(
      { ...validBody, trigger: "x".repeat(129) },
      "1.2.3.4",
    );
    expect(result.valid).toBe(false);
  });

  it("payload 被序列化为 JSON 字符串", () => {
    const result = validateTelemetryV1(
      { ...validBody, payload: { cpu: "arm64", cores: 8 } },
      "1.2.3.4",
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.record.payload).toBe('{"cpu":"arm64","cores":8}');
    }
  });
});
