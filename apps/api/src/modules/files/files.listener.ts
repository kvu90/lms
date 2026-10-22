import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FilesService } from './files.service';

/**
 * FilesModule's own cleanup handler for `cm_deleted` (report §2#4: deleting
 * a cm must clean up the subsystems that own data under it — here, the file
 * records in the cm's context). Idempotent: a replay finds no records.
 */
@Injectable()
/**
 * Lắng nghe sự kiện vòng đời module để dọn file gắn với course module bị xoá.
 */
export class FilesListener {
  private readonly logger = new Logger(FilesListener.name);
  constructor(private readonly files: FilesService) {}

  @OnEvent('cm_deleted')
  /**
   * Khi một course module bị xoá: xoá các file thuộc context của module đó.
   */
  async onCmDeleted(payload: { cmId: number; contextId?: number | null }): Promise<void> {
    if (!payload.contextId) return;
    const records = await this.files.listByContext(payload.contextId);
    for (const record of records) await this.files.deleteFile(record.id);
    if (records.length) this.logger.log(`cm_deleted: removed ${records.length} file record(s) from context ${payload.contextId}`);
  }
}
