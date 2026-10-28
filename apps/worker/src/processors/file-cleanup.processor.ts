import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';

type Database = NodePgDatabase<typeof relations>;
import { files } from '@lms/db';
import { tenantAls } from '../db/tenant-als';

export interface FileCleanupJobData { contentHash: string }
export interface FileCleanupResult { contentHash: string; removed: boolean; refcount: number }

/**
 * Dọn file mồ côi (ngữ nghĩa cron filestorage của Moodle): các byte vật lý của
 * một content hash chỉ bị xoá khi KHÔNG còn bản ghi `files` logic nào tham chiếu
 * tới hash đó nữa — refcount được kiểm tra lại tại thời điểm thực thi, không bao giờ
 * tin vào giá trị tại thời điểm đưa vào queue.
 */
@Processor('file-cleanup')
/**
 * Xử lý job dọn file: xoá nội dung vật lý của các file đã bị xoá mềm khi refcount về 0.
 */
export class FileCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(FileCleanupProcessor.name);
  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<FileCleanupJobData>): Promise<FileCleanupResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<FileCleanupJobData>): Promise<FileCleanupResult> {
    const { contentHash } = job.data;
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(files).where(eq(files.contentHash, contentHash));
    const refcount = row?.n ?? 0;
    if (refcount > 0) {
      this.logger.log(`Hash ${contentHash.slice(0, 8)}… still referenced (${refcount}), keeping physical file`);
      return { contentHash, removed: false, refcount };
    }
    const root = this.config.get<string>('FILE_STORAGE_DIR') ?? './data/files';
    const path = join(root, contentHash.slice(0, 2), contentHash.slice(2, 4), contentHash);
    await rm(path, { force: true });
    this.logger.log(`Removed orphan physical file for hash ${contentHash.slice(0, 8)}…`);
    return { contentHash, removed: true, refcount: 0 };
  }
}
