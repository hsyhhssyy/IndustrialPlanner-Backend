// presigned_url.ts — R2 预签名 URL 生成 — 单元测试

import { describe, it, expect, vi } from "vitest";

// Mock @aws-sdk/s3-request-presigner
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

// Mock @aws-sdk/client-s3
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(),
  PutObjectCommand: vi.fn(),
}));

import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { generatePresignedUploadUrl, type PresignedUrlConfig } from "./presigned_url";

const mockConfig: PresignedUrlConfig = {
  accountId: "test-account-id",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret",
  bucketName: "industrial-sync-blobs",
};

describe("presigned_url — generatePresignedUploadUrl", () => {
  it("返回 URL 字符串", async () => {
    vi.mocked(getSignedUrl).mockResolvedValueOnce("https://r2.example.com/fake-url");

    const url = await generatePresignedUploadUrl(
      mockConfig,
      "test-space",
      "epoch-1",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", // 64 字符 blobHash
      100,
    );

    expect(typeof url).toBe("string");
    expect(url).toBe("https://r2.example.com/fake-url");
  });

  it("构造正确的 R2 object key 格式", async () => {
    let capturedKey: string | undefined;
    vi.mocked(PutObjectCommand).mockImplementation((input) => {
      capturedKey = (input as { Key?: string }).Key;
      return {} as unknown as PutObjectCommand;
    });
    vi.mocked(getSignedUrl).mockResolvedValueOnce("https://r2.example.com/ok");

    const blobHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    await generatePresignedUploadUrl(
      mockConfig,
      "test-space",
      "epoch-1",
      blobHash,
      100,
    );

    // Key 格式: sync/v1/{spaceId}/{epoch}/blobs/sha256/{hash[0..1]}/{blobHash}
    expect(capturedKey).toBe(
      `sync/v1/test-space/epoch-1/blobs/sha256/a1/${blobHash}`,
    );
  });

  it("PUT 时设置 ContentType 为 application/octet-stream", async () => {
    let capturedInput: unknown;
    vi.mocked(PutObjectCommand).mockImplementation((input) => {
      capturedInput = input;
      return {} as unknown as PutObjectCommand;
    });
    vi.mocked(getSignedUrl).mockResolvedValueOnce("https://r2.example.com/ok");

    await generatePresignedUploadUrl(
      mockConfig,
      "test-space",
      "epoch-1",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      100,
    );

    expect((capturedInput as Record<string, unknown>)?.ContentType).toBe("application/octet-stream");
  });

  it("PUT 时设置 ChecksumSHA256", async () => {
    let capturedInput: unknown;
    vi.mocked(PutObjectCommand).mockImplementation((input) => {
      capturedInput = input;
      return {} as unknown as PutObjectCommand;
    });
    vi.mocked(getSignedUrl).mockResolvedValueOnce("https://r2.example.com/ok");

    const blobHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    await generatePresignedUploadUrl(
      mockConfig,
      "test-space",
      "epoch-1",
      blobHash,
      100,
    );

    expect((capturedInput as Record<string, unknown>)?.ChecksumSHA256).toBeDefined();
  });

  it("预签名 URL 过期时间为 300 秒", async () => {
    let capturedExpiresIn: number | undefined;
    vi.mocked(getSignedUrl).mockImplementation(
      async (_client: unknown, _cmd: unknown, options: unknown) => {
        capturedExpiresIn = (options as { expiresIn?: number }).expiresIn;
        return "https://r2.example.com/ok";
      },
    );

    await generatePresignedUploadUrl(
      mockConfig,
      "test-space",
      "epoch-1",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      100,
    );

    expect(capturedExpiresIn).toBe(300);
  });

  it("S3Client 使用正确的 endpoint", async () => {
    let capturedEndpoint: string | undefined;
    vi.mocked(S3Client).mockImplementation((config?) => {
      capturedEndpoint = (config as { endpoint?: string }).endpoint;
      return {} as unknown as S3Client;
    });
    vi.mocked(getSignedUrl).mockResolvedValueOnce("https://r2.example.com/ok");

    await generatePresignedUploadUrl(
      mockConfig,
      "test-space",
      "epoch-1",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      100,
    );

    expect(capturedEndpoint).toBe(
      "https://test-account-id.r2.cloudflarestorage.com",
    );
  });
});
