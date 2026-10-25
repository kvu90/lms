import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { contentKey, type ObjectStorage, type PresignedDownloadStorage } from './storage';

/**
 * S3-compatible physical adapter for the ObjectStorage port: same
 * content-addressed key layout as the local adapter
 * (`<2 chars>/<next 2 chars>/<sha256>`), so buckets can be inspected and
 * reconciled with exactly the same shape as the local filedir. Works
 * against AWS S3 and S3-compatible endpoints (Cloudflare R2, Backblaze
 * B2, MinIO) via FILE_STORAGE_S3_ENDPOINT. All configuration comes from
 * env only; the constructor fails fast (naming the missing variables,
 * never their values) when driver-required settings are absent.
 */
@Injectable()
/**
 * Kho lưu trữ nội dung file trên S3 / endpoint tương thích S3, khoá theo contentHash —
 * cùng bố cục key với adapter local để hai kho đối chiếu được với nhau.
 * Cấu hình (bucket/endpoint/khoá) chỉ đọc từ env; thiếu biến bắt buộc thì fail-fast khi khởi tạo.
 */
export class S3ObjectStorage implements ObjectStorage, PresignedDownloadStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService, client?: S3Client) {
    const bucket = config.get<string>('FILE_STORAGE_S3_BUCKET');
    const accessKeyId = config.get<string>('FILE_STORAGE_S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('FILE_STORAGE_S3_SECRET_ACCESS_KEY');
    const missing = [
      ['FILE_STORAGE_S3_BUCKET', bucket],
      ['FILE_STORAGE_S3_ACCESS_KEY_ID', accessKeyId],
      ['FILE_STORAGE_S3_SECRET_ACCESS_KEY', secretAccessKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`FILE_STORAGE_DRIVER=s3 requires env: ${missing.join(', ')}`);
    }
    this.bucket = bucket as string;
    if (client) {
      this.client = client;
    } else {
      const endpoint = config.get<string>('FILE_STORAGE_S3_ENDPOINT');
      const forcePathStyleRaw = config.get<string | boolean>('FILE_STORAGE_S3_FORCE_PATH_STYLE');
      this.client = new S3Client({
        region: config.get<string>('FILE_STORAGE_S3_REGION') ?? 'us-east-1',
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: forcePathStyleRaw === true || forcePathStyleRaw === 'true',
        credentials: { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string },
      });
    }
  }

  /**
   * Suy key S3 từ contentHash — cùng bố cục với adapter local.
   */
  keyFor(contentHash: string): string { return contentKey(contentHash); }

  /**
   * Kiểm key đã có nội dung chưa (HeadObject; 404 → false, lỗi khác ném ra).
   */
  async exists(contentHash: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.keyFor(contentHash) }));
      return true;
    } catch (err) {
      if (isS3NotFound(err)) return false;
      throw err;
    }
  }

  /**
   * Ghi nội dung theo key; bỏ qua khi key đã tồn tại (dedup theo content hash —
   * cùng hash là cùng nội dung, không bao giờ ghi đè).
   */
  async put(contentHash: string, data: Buffer): Promise<void> {
    if (await this.exists(contentHash)) return; // dedup: same content already stored physically once
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.keyFor(contentHash), Body: data }));
  }

  /**
   * Đọc nội dung theo key; key vắng thì lỗi của S3 (NoSuchKey/404) truyền thẳng ra như ENOENT ở local.
   */
  async get(contentHash: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.keyFor(contentHash) }));
    if (!res.Body) throw new Error(`S3 object body missing for key ${this.keyFor(contentHash)}`);
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /**
   * Xoá nội dung theo key (DeleteObject vốn idempotent ở S3).
   */
  async delete(contentHash: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.keyFor(contentHash) }));
  }

  /**
   * Phát URL tải presigned trỏ thẳng tới S3, kèm tên file/loại nội dung khi tải về
   * để hành vi tải xuống ngang với đường local (attachment + đúng mime).
   */
  async presignGetUrl(contentHash: string, expiresInSeconds: number, opts?: { fileName?: string; mimeType?: string }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: this.keyFor(contentHash),
      ...(opts?.fileName ? { ResponseContentDisposition: `attachment; filename="${opts.fileName.replace(/"/g, '')}"` } : {}),
      ...(opts?.mimeType ? { ResponseContentType: opts.mimeType } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}

/**
 * Lỗi "không có object" của S3 (HeadObject trả 404 tên NotFound; GetObject trả NoSuchKey).
 */
function isS3NotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey';
}
