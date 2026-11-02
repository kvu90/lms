import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { sql, type CentreDB } from '@lms/db';
import { SpaceDatabaseService } from '../db/routing/space-database.service';
import { TaskLogService } from '../task-log.service';
import { tenantAls } from '../db/tenant-als';

export interface EnrolExpiryResult { checkedAt: string; suspendedIds: string[]; warnedIds: string[] }

/**
 * Danh sách cột đọc của một dòng `user_enrolments` mà processor
 * này nạp — dùng chung cho lượt quét quá hạn và lượt quét cảnh
 * báo: bí danh camelCase tường minh theo khuôn danh sách cột của
 * `@lms/db`.
 */
const USER_ENROLMENT_COLUMNS = [
  'id',
  'enrol_id as enrolId',
  'user_id as userId',
  'status',
  'time_start as timeStart',
  'time_end as timeEnd',
  'modifier_id as modifierId',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Cửa sổ cảnh báo sắp hết hạn ghi danh (ngày): ghi danh ACTIVE có
 * timeEnd rơi vào (hiện tại, hiện tại + cửa sổ] được phát MỘT sự kiện
 * outbox `enrol_expiry_warning` duy nhất — phía API (NotificationEvents
 * Consumer, lát N1 issue #49) biến sự kiện thành thông báo
 * `enrol_expiry_warning` cho học sinh. Chống trùng ngay tại phía phát:
 * đã có sự kiện cảnh báo cho đúng enrolment đó thì không phát lại
 * (quét lại mỗi 5 phút không được spam). Moodle cũng cảnh báo TRƯỚC
 * khi hết hạn theo ngưỡng cấu hình; ở đây ngưỡng là hằng số sản phẩm.
 */
export const ENROL_EXPIRY_WARNING_WINDOW_DAYS = 7;

/**
 * Hết hạn ghi danh: các `user_enrolments` ACTIVE mà `timeEnd` của
 * chúng đã qua được chuyển sang SUSPENDED và một sự kiện outbox
 * `user_enrolment_suspended` được ghi trong cùng transaction cho
 * từng dòng. Quyền truy cập CŨNG bị từ chối tại thời điểm đọc bởi
 * kiểm tra cửa sổ thời gian `isEnrolled(onlyActive)` phía API, nên
 * một lượt quét bị trễ không bao giờ mở ra cửa sổ truy cập — lượt
 * quét chỉ chuẩn hoá trạng thái.
 */
@Processor('enrol-expiry')
/**
 * Xử lý job hết hạn ghi danh: quét các ghi danh quá hạn và áp hành động hết hạn của instance.
 */
export class EnrolExpiryProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một job của queue tương ứng. Mỗi lượt quét (tác vụ định kỳ 5 phút)
   * được ghi vào task_log qua TaskLogService.
   */
  async process(_job: Job): Promise<EnrolExpiryResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(_job));
  }

  private async processInContext(_job: Job): Promise<EnrolExpiryResult> {
    void _job;
    return this.taskLog.run('enrol-expiry', () => this.sweep(), (r) => `suspended ${r.suspendedIds.length} enrolment(s), warned ${r.warnedIds.length}`);
  }

  /** Tenant của khoá học (TENANT-1, #196). */
  private async tenantIdOfCourse(courseId: string): Promise<string | null> {
    const row = await this.spaceDb.routedKysely
      .selectFrom('course')
      .select('tenant_id as tenantId')
      .where('id', '=', courseId)
      .executeTakeFirst();
    return row?.tenantId ?? null;
  }

  /** Tenant của khoá chứa một instance ghi danh. */
  private async tenantIdOfEnrol(enrolId: string): Promise<string | null> {
    const instance = await this.spaceDb.routedKysely
      .selectFrom('enrol')
      .select('course_id as courseId')
      .where('id', '=', enrolId)
      .executeTakeFirst();
    if (!instance) return null;
    return this.tenantIdOfCourse(instance.courseId);
  }

  private async sweep(): Promise<EnrolExpiryResult> {
    const now = new Date();
    const expired = await this.spaceDb.routedKysely
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('status', '=', 0)
      .where('time_end', '<', now)
      .execute();
    const suspendedIds: string[] = [];
    for (const ue of expired) {
      // TENANT-1 (#196): sự kiện mang tenant của khoá chứa instance ghi danh.
      const tenantId = await this.tenantIdOfEnrol(ue.enrolId);
      await this.spaceDb.routedKysely.transaction().execute(async (tx) => {
        await tx.updateTable('user_enrolments')
          .set({ status: 1, updated_at: now })
          .where('id', '=', ue.id)
          .execute();
        await tx.insertInto('outbox_events')
          .values({
            aggregate: 'enrol', type: 'user_enrolment_suspended', tenant_id: tenantId,
            // Cột `payload` jsonb đi qua serialize tường minh kèm
            // `::jsonb` theo khuôn ghi jsonb của `@lms/db`.
            payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({
              userId: ue.userId, enrolmentId: ue.id, enrolId: ue.enrolId, reason: 'expired', tenantId,
            })}::jsonb`,
          })
          .execute();
      });
      suspendedIds.push(ue.id);
    }
    const warnedIds = await this.warnExpiring(now);
    return { checkedAt: now.toISOString(), suspendedIds, warnedIds };
  }

  /**
   * Lượt quét cảnh báo: ghi danh ACTIVE sắp hết hạn trong cửa sổ
   * ENROL_EXPIRY_WARNING_WINDOW_DAYS mà chưa từng được cảnh báo thì
   * phát sự kiện `enrol_expiry_warning` (kèm courseId lấy từ instance
   * và mốc timeEnd) để phía API tạo thông báo. Trả về id các ghi danh
   * vừa được cảnh báo trong lượt này.
   */
  private async warnExpiring(now: Date): Promise<string[]> {
    const windowEnd = new Date(now.getTime() + ENROL_EXPIRY_WARNING_WINDOW_DAYS * 24 * 3600_000);
    const expiring = await this.spaceDb.routedKysely
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('status', '=', 0)
      .where('time_end', '>', now)
      .where('time_end', '<=', windowEnd)
      .execute();
    const warnedIds: string[] = [];
    for (const ue of expiring) {
      if (!ue.timeEnd) continue;
      // Toán tử JSON trên cột `payload` giữ nguyên văn biểu thức
      // trong `sql` template của Kysely.
      const already = await this.spaceDb.routedKysely
        .selectFrom('outbox_events')
        .select('id')
        .where('type', '=', 'enrol_expiry_warning')
        .where(sql<boolean>`payload ->> 'enrolmentId' = ${ue.id}`)
        .limit(1)
        .executeTakeFirst();
      if (already) continue;
      const instance = await this.spaceDb.routedKysely
        .selectFrom('enrol')
        .select('course_id as courseId')
        .where('id', '=', ue.enrolId)
        .executeTakeFirst();
      if (!instance) continue;
      const tenantId = await this.tenantIdOfCourse(instance.courseId);
      await this.spaceDb.routedKysely
        .insertInto('outbox_events')
        .values({
          aggregate: 'enrol', type: 'enrol_expiry_warning', tenant_id: tenantId,
          // Cột `payload` jsonb đi qua serialize tường minh kèm
          // `::jsonb` theo khuôn ghi jsonb của `@lms/db`.
          payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({
            userId: ue.userId, enrolmentId: ue.id, enrolId: ue.enrolId, tenantId,
            courseId: instance.courseId, timeEnd: ue.timeEnd.toISOString(),
          })}::jsonb`,
        })
        .execute();
      warnedIds.push(ue.id);
    }
    return warnedIds;
  }
}
