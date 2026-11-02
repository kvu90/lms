import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@lms/db';
import { tenantAls } from '../db/tenant-als';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

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
    private readonly spaceDb: SpaceDatabaseService,
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
    // Đếm giữ đúng khuôn cũ `count(*)::int`: `count(*)` trần của
    // PostgreSQL là int8 và Kysely đọc int8 thành chuỗi, trong khi
    // hợp đồng kết quả của processor là số — ép `::int` ngay trong
    // SQL như đường cũ trước đây để giá trị về thẳng là số.
    const row = await this.spaceDb.routedKysely
      .selectFrom('files')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('content_hash', '=', contentHash)
      .executeTakeFirst();
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
