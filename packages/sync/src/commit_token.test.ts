// commit_token.ts — HMAC-SHA256 自包含 token 签发/验证 — 单元测试

import { describe, it, expect } from "vitest";
import {
  signCommitToken,
  verifyCommitToken,
  type CommitTokenPayload,
} from "./commit_token";

const SECRET = "test-secret-key-32-bytes-long!!"; // 至少 32 字节

describe("commit_token — 签发与验证", () => {
  const payload: CommitTokenPayload = {
    spaceId: "test-space",
    epoch: "epoch-1",
    clientBatchId: "batch-001",
    observedHead: 0,
    mutations: [
      {
        clientMutationId: "cm-1",
        assetType: "blueprint",
        assetId: "bp-001",
        baseRevision: null,
      },
      {
        clientMutationId: "cm-2",
        assetType: "config",
        assetId: "cfg-001",
        baseRevision: 3,
      },
    ],
    expiresAt: Date.now() + 300_000, // 5 分钟
  };

  describe("签发", () => {
    it("签发返回格式为 base64payload.base64signature", async () => {
      const token = await signCommitToken(payload, SECRET);
      expect(token).toContain(".");
      const parts = token.split(".");
      expect(parts).toHaveLength(2);
      // base64url 验证：只有 A-Za-z0-9-_ 字符
      expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("同一 payload 同 secret 产出相同 token（确定性）", async () => {
      const t1 = await signCommitToken(payload, SECRET);
      const t2 = await signCommitToken(payload, SECRET);
      expect(t1).toBe(t2);
    });

    it("不同 secret 产出不同 token", async () => {
      const t1 = await signCommitToken(payload, SECRET);
      const t2 = await signCommitToken(
        payload,
        "different-secret-key-here-1234!!",
      );
      expect(t1).not.toBe(t2);
    });
  });

  describe("验证 — 成功路径", () => {
    it("有效 token 验证通过，返回原 payload", async () => {
      const token = await signCommitToken(payload, SECRET);
      const result = await verifyCommitToken(token, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.spaceId).toBe("test-space");
        expect(result.payload.epoch).toBe("epoch-1");
        expect(result.payload.clientBatchId).toBe("batch-001");
        expect(result.payload.observedHead).toBe(0);
        expect(result.payload.mutations).toHaveLength(2);
        expect(result.payload.mutations[0]?.clientMutationId).toBe("cm-1");
      }
    });
  });

  describe("验证 — 失败路径", () => {
    it("token 格式错误（无分隔符）返回 token_invalid", async () => {
      const result = await verifyCommitToken("not-a-valid-token", SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("token_invalid");
      }
    });

    it("签名被篡改返回 token_invalid", async () => {
      const token = await signCommitToken(payload, SECRET);
      const parts = token.split(".");
      // 修改 payload 部分的最后一个字符
      const tamperedPayload =
        parts[0]!.slice(0, -1) + (parts[0]!.endsWith("A") ? "B" : "A");
      const tamperedToken = tamperedPayload + "." + parts[1]!;
      const result = await verifyCommitToken(tamperedToken, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("token_invalid");
      }
    });

    it("过期 token 返回 token_expired", async () => {
      const expiredPayload: CommitTokenPayload = {
        ...payload,
        expiresAt: Date.now() - 1000,
        mutations: [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
          },
        ],
      };
      const token = await signCommitToken(expiredPayload, SECRET);
      const result = await verifyCommitToken(token, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("token_expired");
      }
    });

    it("payload 非法 base64 返回 token_invalid", async () => {
      const result = await verifyCommitToken("!!!not-base64.!!!not-base64", SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("token_invalid");
      }
    });

    it("空 token 返回 token_invalid", async () => {
      const result = await verifyCommitToken("", SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("token_invalid");
      }
    });
  });

  describe("边界", () => {
    it("空 mutations 数组可正常签发和验证", async () => {
      const p: CommitTokenPayload = {
        ...payload,
        mutations: [],
      };
      const token = await signCommitToken(p, SECRET);
      const result = await verifyCommitToken(token, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.mutations).toHaveLength(0);
      }
    });

    it("observedHead 可以是 0", async () => {
      const p: CommitTokenPayload = {
        ...payload,
        observedHead: 0,
        mutations: [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
          },
        ],
      };
      const token = await signCommitToken(p, SECRET);
      const result = await verifyCommitToken(token, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.observedHead).toBe(0);
      }
    });

    it("baseRevision 可以是 null（新建资产）", async () => {
      const p: CommitTokenPayload = {
        ...payload,
        mutations: [
          {
            clientMutationId: "cm-1",
            assetType: "blueprint",
            assetId: "bp-001",
            baseRevision: null,
          },
        ],
      };
      const token = await signCommitToken(p, SECRET);
      const result = await verifyCommitToken(token, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.mutations[0]?.baseRevision).toBeNull();
      }
    });
  });
});
