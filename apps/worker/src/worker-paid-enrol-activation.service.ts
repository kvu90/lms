import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { enrol, userEnrolments } from '@lms/db';
import {
  CohortMaterializationSurface,
  ENROL_ACTIVE,
  SharedDomainError,
} from '@lms/enrol';
import type { PaidEnrolActivationPort } from '@lms/payments';
import { tenantAls } from './db/tenant-als';
import type { relations } from './db/relations';
import { WorkerEnrolOutboxService } from './worker-enrol-outbox.service';
import { WorkerPaymentSpaceScopeService } from './worker-payment-space-scope.service';

type Database = NodePgDatabase<typeof relations>;

/**
 * Cài đặt phía worker cho cổng kích hoạt ghi danh có phí
 * (`PAID_ENROL_ACTIVATION_PORT` — issue con #539 của #522).
 *
 * Flow: payment `enrol_fee` khớp đủ điều kiện ở nhịp matching →
 * cổng này kích hoạt ghi danh của người mua vào instance đích.
 *
 * 1. Chạy trong ngữ cảnh platform tường minh: funnel đọc chính
 *    sách xuyên tenant (tách vai, slot gói, membership) nên ngoài
 *    ngữ cảnh platform, RLS fail-closed sẽ che dữ kiện và cho kết
 *    quả "không thấy" giả (lớp lỗi #292).
 * 1b. Phạm vi kho theo payment (tiền điều kiện Phần B của #587):
 *    trước khi đọc gì, service phân giải không gian của payment qua
 *    `WorkerPaymentSpaceScopeService` (từ `tenantId` của payment →
 *    slug → chế độ kho trong sổ đăng ký control plane). Trung tâm
 *    ở kho riêng thì TOÀN BỘ thân dưới đây — đọc instance, ghi
 *    ghi danh, bề mặt vật chất hoá — chạy trong phiên theo trung
 *    tâm đó (handle định tuyến đã inject tự dẫn vào kho riêng);
 *    trung tâm ở kho chung thì hành vi giữ nguyên như trước.
 *    Cổng `runInPlatformScope` của bề mặt giữ nguyên `spaceSlug`
 *    của ngữ cảnh đang chạy theo khuôn cohort-sync, để các lượt
 *    đọc platform bên trong bề mặt không đánh rơi kho đích.
 * 2. Đọc instance đích: không tồn tại → lỗi `enrol.instance_not_found`
 *    (cùng mã với `EnrolService.getInstance` phía API); không phải
 *    instance thu phí → lỗi `enrol.not_fee`.
 * 3. Đã có ghi danh ĐANG HOẠT ĐỘNG qua instance này → trả ngay
 *    không chạm gì thêm (giữ nguyên cửa sổ thời gian cũ — khác
 *    đường funnel chung vốn tính lại cửa sổ khi gặp dòng đã có).
 * 4. Còn lại → uỷ thác cho phễu ghi danh dùng chung
 *    `CohortMaterializationSurface.enrolUserInternal` (chốt tách vai,
 *    transaction chèn ghi danh + `user_enrolled`, membership tenant,
 *    cấp vai của instance, xếp nhóm đích). Adapter này KHÔNG giữ
 *    thêm luật nào: hai chốt ở bước 2–3 là đúng hai chốt của
 *    `EnrolService.activatePaidEnrol` phía API, chỉ đọc dữ liệu
 *    qua `@lms/db` để tới được phễu chung.
 *
 * Không gửi tin nhắn chào mừng: chào mừng là hiệu ứng phụ của tiến
 * trình API (xem `EnrolService.enrolUserInternal`) — bề mặt chung
 * trả cờ `isNewEnrolment` cho host nào cần, còn worker vật chất
 * hoá cùng funnel này thì không gửi tin nhắn theo đúng luật đã
 * chốt ở #527.
 *
 * Idempotent: ghi danh đã ACTIVE thì dừng ở bước 3; funnel chung
 * tự nối đường cập nhật khi đua ghi đồng thời (unique violation
 * trên `(enrol_id, user_id)`); nhịp matching chạy lại sau chết
 * giữa chừng gặp đúng các chốt này nên không ghi danh trùng.
 *
 * @throws SharedDomainError mã `enrol.instance_not_found`,
 * `enrol.not_fee`, `tenant.missing`/`tenant.not_found` (không phân
 * giải được không gian của payment), hoặc lỗi của các điểm chặn
 * dùng chung (tách vai, slot, gán vai) — nhịp matching bắt từng sự
 * kiện và ghi cảnh báo nên lỗi ở đây không làm hỏng cả lô quét.
 * Kho đích chuẩn bị lỗi thì `SpaceRoutingError` của khung định
 * tuyến lan ra nguyên dạng, payment ở lại `pending` để nhịp sau
 * thử lại — tuyệt đối không ghi vào kho chung.
 */
@Injectable()
export class WorkerPaidEnrolActivationService implements PaidEnrolActivationPort {
  private readonly materialization: CohortMaterializationSurface;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    enrolOutbox: WorkerEnrolOutboxService,
    private readonly spaceScope: WorkerPaymentSpaceScopeService,
  ) {
    this.materialization = new CohortMaterializationSurface({
      db: this.db,
      outbox: enrolOutbox,
      // Giữ nguyên `spaceSlug` của ngữ cảnh đang chạy theo khuôn
      // cohort-sync: phạm vi này chỉ đổi tầm nhìn RLS sang đường
      // platform, không đổi kho đích; một kích hoạt của trung tâm
      // ở kho riêng chạy trong phiên theo trung tâm mà phạm vi
      // platform dựng store mới không mang slug thì handle định
      // tuyến rơi về kho chung, ghi sai kho.
      runInPlatformScope: (fn) =>
        tenantAls.run({ platform: true, spaceSlug: tenantAls.getStore()?.spaceSlug }, fn),
    });
  }

  /**
   * Kích hoạt ghi danh có phí cho một payment đã khớp.
   *
   * @param itemId - Id của instance ghi danh đích (trường `itemId` của payment).
   * @param userId - Id của người dùng được ghi danh (trường `userId` của payment).
   * @param tenantId - Id tenant của payment: bắt buộc để phân giải
   * không gian — vắng thì lỗi ngay thay vì đoán kho chung (fail-closed).
   */
  async activatePaidEnrol(itemId: string, userId: string, tenantId?: string): Promise<void> {
    await this.spaceScope.runForPaymentTenant(tenantId, async () => {
      const [instance] = await this.db.select().from(enrol).where(eq(enrol.id, itemId));
      if (!instance) {
        throw new SharedDomainError('enrol.instance_not_found', `Enrol instance ${itemId} not found`);
      }
      if (instance.enrol !== 'fee') {
        throw new SharedDomainError('enrol.not_fee', 'Instance is not a fee enrol instance');
      }
      const [existing] = await this.db.select().from(userEnrolments)
        .where(and(eq(userEnrolments.enrolId, itemId), eq(userEnrolments.userId, userId)));
      if (existing && existing.status === ENROL_ACTIVE) return;
      // modifierId = chính người mua, đúng vết của đường API.
      await this.materialization.enrolUserInternal(instance, userId, userId);
    });
  }
}
