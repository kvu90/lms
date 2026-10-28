import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, isNotNull, isNull, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { notificationDispatchLog, notifications } from '@lms/db';
import { TaskLogService } from '../task-log.service';
import { tenantAls } from '../db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

/**
 * Hạn giữ dữ liệu thông báo (mô hình đích D.6 của hồ sơ chuẩn thông báo,
 * chốt ở G9 của hồ sơ rà soát #174): thông báo ĐÃ ĐỌC giữ 90 ngày kể từ
 * lúc đọc, CHƯA ĐỌC giữ 180 ngày kể từ lúc tạo, nhật ký phân phối giữ 90
 * ngày. Là hằng số sản phẩm như các ngưỡng nền khác (cửa sổ cảnh báo hết
 * hạn ghi danh), không phải cấu hình theo tenant.
 */
export const NOTIFICATION_READ_RETENTION_DAYS = 90;
export const NOTIFICATION_UNREAD_RETENTION_DAYS = 180;
export const DISPATCH_LOG_RETENTION_DAYS = 90;

export interface NotificationRetentionResult {
  readDeleted: number;
  unreadDeleted: number;
  dispatchLogDeleted: number;
}

const DAY_MS = 24 * 3600_000;

/**
 * Retention thông báo (NB-6, G9): trước lát này KHÔNG có job nào dọn
 * `notifications`/`notification_dispatch_log` theo tuổi — hai bảng phình
 * vô hạn. Mỗi lượt quét xoá đúng ba nhóm đã quá hạn ở hằng số trên và ghi
 * một dòng `task_log` qua TaskLogService. Thông báo chưa đọc chỉ bị xoá
 * theo tuổi TẠO (180 ngày) — không bao giờ bị xoá theo hạn đã đọc.
 */
@Processor('notification-retention')
/**
 * Xử lý job retention: quét và xoá thông báo/nhật ký phân phối đã quá hạn giữ.
 */
export class NotificationRetentionProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một lượt quét định kỳ; kết quả được ghi vào task_log.
   */
  async process(_job: Job): Promise<NotificationRetentionResult> {
    void _job;
    return this.taskLog.run('notification-retention', () => this.sweep(new Date()),
      (r) => `deleted ${r.readDeleted} read notification(s), ${r.unreadDeleted} unread notification(s), ${r.dispatchLogDeleted} dispatch log row(s)`);
  }

  /**
   * Một lượt quét tại mốc `now` (tham số hoá để spec ghim biên ngày
   * chính xác): "quá hạn" là mốc thời gian NHỎ HƠN điểm cắt — bản ghi ở
   * đúng ngày biên (90/180) vẫn được giữ, sang ngày 91/181 mới bị xoá.
   */
  async sweep(now: Date): Promise<NotificationRetentionResult> {
    // TENANT-1 (#196): retention quét/xoá xuyên tenant — bọc ngữ cảnh
    // platform tường minh như mọi processor nền khác, nếu không RLS
    // fail-closed sẽ làm lượt quét mù dữ liệu tenant (xoá thiếu lặng).
    return tenantAls.run({ platform: true }, () => this.sweepInContext(now));
  }

  private async sweepInContext(now: Date): Promise<NotificationRetentionResult> {
    const readCutoff = new Date(now.getTime() - NOTIFICATION_READ_RETENTION_DAYS * DAY_MS);
    const unreadCutoff = new Date(now.getTime() - NOTIFICATION_UNREAD_RETENTION_DAYS * DAY_MS);
    const dispatchCutoff = new Date(now.getTime() - DISPATCH_LOG_RETENTION_DAYS * DAY_MS);

    const readDeleted = (await this.db.delete(notifications).where(and(
      isNotNull(notifications.timeRead), lt(notifications.timeRead, readCutoff),
    )).returning({ id: notifications.id })).length;
    const unreadDeleted = (await this.db.delete(notifications).where(and(
      isNull(notifications.timeRead), lt(notifications.createdAt, unreadCutoff),
    )).returning({ id: notifications.id })).length;
    const dispatchLogDeleted = (await this.db.delete(notificationDispatchLog).where(
      lt(notificationDispatchLog.createdAt, dispatchCutoff),
    ).returning({ id: notificationDispatchLog.id })).length;

    return { readDeleted, unreadDeleted, dispatchLogDeleted };
  }
}
