import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FileSigningService } from './file-signing.service';
import { contentKey, LocalObjectStorage, sha256Hex, type ObjectStorage } from './storage';
import { S3ObjectStorage } from './storage-s3';
import { createObjectStorage } from './storage-factory';

/** Config giả tối thiểu cho các adapter/service — giá trị ở đây là fixture test, không phải khoá thật. */
function fakeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Missing config ${key}`);
      return value;
    },
  } as unknown as ConfigService;
}

function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

/**
 * Double S3 trong bộ nhớ cho tầng test hợp đồng: cài đặt đúng ngữ nghĩa
 * Head/Put/Get/Delete theo key mà adapter dùng, không cần mạng/MinIO.
 */
class FakeS3Client {
  readonly objects = new Map<string, Buffer>();
  readonly sent: string[] = [];
  async send(command: unknown): Promise<unknown> {
    if (command instanceof HeadObjectCommand) {
      this.sent.push('head');
      if (!this.objects.has(command.input.Key as string)) throw s3Error('NotFound', 404);
      return {};
    }
    if (command instanceof PutObjectCommand) {
      this.sent.push('put');
      this.objects.set(command.input.Key as string, Buffer.from(command.input.Body as Buffer));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      this.sent.push('get');
      const data = this.objects.get(command.input.Key as string);
      if (!data) throw s3Error('NoSuchKey', 404);
      return { Body: Readable.from([data]) };
    }
    if (command instanceof DeleteObjectCommand) {
      this.sent.push('delete');
      this.objects.delete(command.input.Key as string);
      return {};
    }
    throw new Error('FakeS3Client: unexpected command');
  }
}

const S3_TEST_CONFIG = {
  FILE_STORAGE_S3_BUCKET: 'bucket-test',
  FILE_STORAGE_S3_ACCESS_KEY_ID: 'fixture-access-key',
  FILE_STORAGE_S3_SECRET_ACCESS_KEY: 'fixture-secret-key',
};

function makeS3Storage(): { storage: S3ObjectStorage; fake: FakeS3Client } {
  const fake = new FakeS3Client();
  const storage = new S3ObjectStorage(fakeConfig(S3_TEST_CONFIG), fake as unknown as S3Client);
  return { storage, fake };
}

/**
 * Bộ test HỢP ĐỒNG của port ObjectStorage — chạy nguyên vẹn cho mọi adapter:
 * vòng put/get/delete/exists, và ngữ nghĩa dedup (put trùng hash
 * KHÔNG ghi đè nội dung đã lưu). Bố cục key nội bộ và số lần gọi adapter
 * là chi tiết triển khai — không khẳng định ở đây (rà soát #219).
 */
function storageContract(name: string, make: () => Promise<{ storage: ObjectStorage; cleanup: () => Promise<void> }>): void {
  describe(`ObjectStorage contract — ${name}`, () => {
    const dataA = Buffer.from('noi-dung-phieu-A');
    const dataB = Buffer.from('noi-dung-khac-B');
    const hash = sha256Hex(dataA);

    it('put → exists=true and get returns the exact bytes', async () => {
      const { storage, cleanup } = await make();
      try {
        expect(await storage.exists(hash)).toBe(false);
        await storage.put(hash, dataA);
        expect(await storage.exists(hash)).toBe(true);
        expect((await storage.get(hash)).equals(dataA)).toBe(true);
      } finally { await cleanup(); }
    });

    it('put with an existing hash is a dedup no-op (never overwrites)', async () => {
      const { storage, cleanup } = await make();
      try {
        await storage.put(hash, dataA);
        await storage.put(hash, dataB);
        expect((await storage.get(hash)).equals(dataA)).toBe(true);
      } finally { await cleanup(); }
    });

    it('delete removes the object; get afterwards throws', async () => {
      const { storage, cleanup } = await make();
      try {
        await storage.put(hash, dataA);
        await storage.delete(hash);
        expect(await storage.exists(hash)).toBe(false);
        await expect(storage.get(hash)).rejects.toThrow();
      } finally { await cleanup(); }
    });

    it('get on a missing hash throws', async () => {
      const { storage, cleanup } = await make();
      try {
        await expect(storage.get(sha256Hex(Buffer.from('khong-ton-tai')))).rejects.toThrow();
      } finally { await cleanup(); }
    });
  });
}

storageContract('LocalObjectStorage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lms-files-contract-'));
  const storage = new LocalObjectStorage(fakeConfig({ FILE_STORAGE_DIR: dir }));
  return { storage, cleanup: () => rm(dir, { recursive: true, force: true }) };
});

storageContract('S3ObjectStorage (in-memory S3 double)', async () => {
  const { storage } = makeS3Storage();
  return { storage, cleanup: async () => undefined };
});

describe('S3ObjectStorage specifics', () => {
  it('presignGetUrl issues a signed URL carrying the content key and the TTL (offline presigning)', async () => {
    const storage = new S3ObjectStorage(fakeConfig({
      ...S3_TEST_CONFIG,
      FILE_STORAGE_S3_ENDPOINT: 'https://s3.example.test',
      FILE_STORAGE_S3_REGION: 'us-east-1',
    }));
    const hash = sha256Hex(Buffer.from('presign-me'));
    const url = await storage.presignGetUrl(hash, 300, { fileName: 'phieu.png', mimeType: 'image/png' });
    expect(url).toContain(contentKey(hash));
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=300');
  });

  it('constructor fails fast naming the missing env vars (names only)', () => {
    expect(() => new S3ObjectStorage(fakeConfig({ FILE_STORAGE_S3_BUCKET: 'bucket-test' })))
      .toThrow(/FILE_STORAGE_S3_ACCESS_KEY_ID/);
    expect(() => new S3ObjectStorage(fakeConfig({}))).toThrow(/FILE_STORAGE_S3_BUCKET/);
  });
});

describe('createObjectStorage (driver selection by env)', () => {
  it('defaults to the local adapter when FILE_STORAGE_DRIVER is unset', () => {
    expect(createObjectStorage(fakeConfig({ FILE_STORAGE_DIR: '/tmp/x' }))).toBeInstanceOf(LocalObjectStorage);
  });

  it('selects the S3 adapter when driver=s3 with full config', () => {
    expect(createObjectStorage(fakeConfig({ FILE_STORAGE_DRIVER: 's3', ...S3_TEST_CONFIG }))).toBeInstanceOf(S3ObjectStorage);
  });

  it('fails fast when driver=s3 but required S3 env is missing', () => {
    expect(() => createObjectStorage(fakeConfig({ FILE_STORAGE_DRIVER: 's3' }))).toThrow(/FILE_STORAGE_S3_BUCKET/);
  });

  it('fails fast on an unknown driver instead of silently falling back', () => {
    expect(() => createObjectStorage(fakeConfig({ FILE_STORAGE_DRIVER: 'gcs' }))).toThrow(/FILE_STORAGE_DRIVER/);
  });
});

describe('FileSigningService download target', () => {
  const signingConfig = fakeConfig({ JWT_SECRET: 'fixture-jwt-secret-for-tests-only', FILE_SIGNED_URL_TTL_SECONDS: 300 });
  const file = { id: '11111111-1111-7111-8111-111111111111', contentHash: sha256Hex(Buffer.from('sign-me')), fileName: 'phieu.png', mimeType: 'image/png' };

  it('local adapter (no presign capability) → HMAC API URL, verifiable with verify()', async () => {
    const signing = new FileSigningService(signingConfig, new LocalObjectStorage(fakeConfig({ FILE_STORAGE_DIR: '/tmp/x' })));
    const target = await signing.createDownloadTarget(file);
    expect(target.url.startsWith(`/api/v1/files/${file.id}/download?sig=`)).toBe(true);
    const token = decodeURIComponent(target.url.split('sig=')[1]);
    expect(() => signing.verify(file.id, token)).not.toThrow();
  });

  it('no storage injected → HMAC API URL (backwards-compatible construction)', async () => {
    const signing = new FileSigningService(signingConfig);
    const target = await signing.createDownloadTarget(file);
    expect(target.url.startsWith(`/api/v1/files/${file.id}/download?sig=`)).toBe(true);
  });

  it('S3 adapter → presigned URL to the store, not the API download path', async () => {
    const s3 = new S3ObjectStorage(fakeConfig({
      ...S3_TEST_CONFIG,
      FILE_STORAGE_S3_ENDPOINT: 'https://s3.example.test',
      FILE_STORAGE_S3_REGION: 'us-east-1',
    }));
    const signing = new FileSigningService(signingConfig, s3);
    const target = await signing.createDownloadTarget(file);
    expect(target.url).toContain('X-Amz-Signature=');
    expect(target.url).toContain(contentKey(file.contentHash));
    expect(target.url).not.toContain('/api/v1/files/');
    expect(target.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});
