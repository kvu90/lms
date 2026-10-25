import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import { FileCleanupProcessor } from '../src/processors/file-cleanup.processor';
import { files } from '@lms/db-schema';
import { WorkerModule } from '../src/worker.module';

const STORAGE = '/tmp/lms-worker-test-files';

/**
 * Orphan cleanup flow (report §3.11 golden file case, worker half).
 * Oracle: file_storage_test.php::test_cron — physical files are removed only
 * when nothing references their contentHash.
 */
describe('Worker: file-cleanup processor removes only unreferenced physical files', () => {
  let context: INestApplicationContext;
  let db: {
    insert: (table: typeof files) => { values: (v: typeof files.$inferInsert) => Promise<unknown> };
    delete: (table: typeof files) => { where: (cond: unknown) => Promise<unknown> };
  };
  const content = Buffer.from(`orphan-content-${Date.now()}`);
  const hash = createHash('sha256').update(content).digest('hex');
  const physical = join(STORAGE, hash.slice(0, 2), hash.slice(2, 4), hash);

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    await mkdir(join(physical, '..'), { recursive: true });
    await writeFile(physical, content);
    await db.insert(files).values({
      contentHash: hash, contextId: '01900000-0000-7000-8000-0000000000aa', component: 'core_user', fileArea: 'profile',
      itemId: null, filePath: '/', fileName: 'orphan.txt', fileSize: content.length,
    });
  });
  afterAll(async () => { await context.close(); });

  it('keeps the physical file while a record still references the hash', async () => {
    const processor = context.get(FileCleanupProcessor);
    const result = await processor.process({ data: { contentHash: hash } } as never);
    expect(result.removed).toBe(false);
    expect(result.refcount).toBe(1);
    expect(existsSync(physical)).toBe(true);
  });

  it('removes the physical file once the last record is gone', async () => {
    await db.delete(files).where(eq(files.contentHash, hash));
    const processor = context.get(FileCleanupProcessor);
    const result = await processor.process({ data: { contentHash: hash } } as never);
    expect(result.removed).toBe(true);
    expect(existsSync(physical)).toBe(false);
  });
});
