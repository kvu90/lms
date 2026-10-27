import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FilesService } from './files.service';

/**
 * Handler dọn dẹp riêng của FilesModule cho `cm_deleted` (report §2#4: xoá
 * một cm phải dọn dẹp các hệ thống con sở hữu dữ liệu dưới nó — ở đây là các bản ghi
 * file trong context của cm). Có tính idempotent: phát lại sẽ không thấy bản ghi nào.
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
  async onCmDeleted(payload: { cmId: string; contextId?: string | null }): Promise<void> {
    if (!payload.contextId) return;
    const records = await this.files.listByContext(payload.contextId);
    for (const record of records) await this.files.deleteFile(record.id);
    if (records.length) this.logger.log(`cm_deleted: removed ${records.length} file record(s) from context ${payload.contextId}`);
  }
}
