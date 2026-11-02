import { Injectable, Logger } from '@nestjs/common';
import { SpaceDatabaseService } from './db/routing/space-database.service';

/**
 * Ghi `task_log` cho các tác vụ định kỳ của worker (Moodle task log): mỗi
 * lượt chạy khép lại bằng một dòng (tên task, khoảng thời gian, trạng thái
 * success/failed, thông điệp tóm tắt hoặc lỗi). Ghi log không bao giờ được
 * làm hỏng tác vụ — lỗi ghi chỉ cảnh báo.
 *
 * @remarks
 * Dòng được ghi qua handle Kysely định tuyến của khung định tuyến theo
 * trung tâm (`SpaceDatabaseService.routedKysely`): các lượt ghi đều chạy
 * trong ngữ cảnh platform hoặc phiên theo trung tâm mà phía gọi đã mở,
 * nên handle vào đúng kho của ngữ cảnh đó — cùng đích kho với handle
 * bộ máy cũ định tuyến trước đây.
 */
@Injectable()
export class TaskLogService {
  private readonly logger = new Logger(TaskLogService.name);

  constructor(private readonly spaceDb: SpaceDatabaseService) {}

  /** Chạy `fn` như một lượt tác vụ và ghi kết quả vào task_log; lỗi của tác vụ được ném lại nguyên vẹn. */
  async run<T>(taskName: string, fn: () => Promise<T>, summarize?: (result: T) => string): Promise<T> {
    const startedAt = new Date();
    try {
      const result = await fn();
      await this.recordRun(taskName, startedAt, 'success', summarize?.(result));
      return result;
    } catch (err) {
      await this.recordRun(taskName, startedAt, 'failed', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Ghi một lượt chạy đã kết thúc (cho các điểm gọi tự quản thời gian bắt đầu, vd nhịp relay). */
  async recordRun(taskName: string, startedAt: Date, status: 'success' | 'failed', message?: string): Promise<void> {
    try {
      await this.spaceDb.routedKysely
        .insertInto('task_log')
        .values({
          task_name: taskName, status, message: message ?? null, started_at: startedAt, finished_at: new Date(),
        })
        .execute();
    } catch (err) {
      this.logger.warn(`Could not write task_log for ${taskName}: ${String(err)}`);
    }
  }
}
