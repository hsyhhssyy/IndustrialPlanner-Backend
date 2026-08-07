// R2 预签名 URL 生成
//
// 使用 S3 API 生成预签名 PUT URL，前端直传 R2。
// R2 binding 不支持生成预签名 URL，因此通过 S3 API 实现。

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedUrlConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

// 生成预签名上传 URL
// blobHash 应为 hex 编码的 SHA-256 字符串（64 字符）
export async function generatePresignedUploadUrl(
  config: PresignedUrlConfig,
  spaceId: string,
  epoch: string,
  blobHash: string,
  byteSize: number,
): Promise<string> {
  // 构造 R2 Object Key: sync/v1/{spaceId}/{epoch}/blobs/sha256/{prefix}/{blobHash}
  const prefix = blobHash.substring(0, 2);
  const key = `sync/v1/${spaceId}/${epoch}/blobs/sha256/${prefix}/${blobHash}`;

  // S3Client — 不缓存跨请求（Workers 内存不持久）
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  // blobHash 是 hex SHA-256 → 转为 base64 用于 ChecksumSHA256
  const hashBytes = new Uint8Array(blobHash.length / 2);
  for (let i = 0; i < blobHash.length; i += 2) {
    hashBytes[i / 2] = parseInt(blobHash.substring(i, i + 2), 16);
  }
  const checksumB64 = btoa(String.fromCharCode(...hashBytes));

  const command = new PutObjectCommand({
    Bucket: config.bucketName,
    Key: key,
    ContentType: "application/octet-stream",
    ChecksumSHA256: checksumB64,
    ContentLength: byteSize,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 300 });

  return url;
}

// 生成预签名下载 URL
export async function generatePresignedDownloadUrl(
  config: PresignedUrlConfig,
  spaceId: string,
  epoch: string,
  blobHash: string,
): Promise<string> {
  const prefix = blobHash.substring(0, 2);
  const key = `sync/v1/${spaceId}/${epoch}/blobs/sha256/${prefix}/${blobHash}`;

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const command = new GetObjectCommand({
    Bucket: config.bucketName,
    Key: key,
  });

  const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
  return url;
}
