import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { classes, cohortMembers } from '@lms/db';
import {
  CohortMaterializationSurface,
  ensureActiveTenantMembership,
  SharedDomainError,
} from '@lms/enrol';
import type { PaidClassEnrolActivationPort } from '@lms/payments';
import { tenantAls } from './db/tenant-als';
import type { relations } from './db/relations';
import { WorkerEnrolOutboxService } from './worker-enrol-outbox.service';

type Database = NodePgDatabase<typeof relations>;

/**
 * Cài đặt phía worker cho cổng kích hoạt ghi danh cấp lớp
 * (`PAID_CLASS_ENROL_ACTIVATION_PORT` — issue con #539 của #522).
 *
 * Flow: payment `class_fee` khớp đủ điều kiện ở nhịp matching →
 * cổng này đưa người mua vào lớp đích qua backing cohort của lớp;
 * cohort sync sau đó vật chất hoá ghi danh xuống mọi khoá của lớp.
 *
 * 1. Chạy trong ngữ cảnh platform tường minh: lớp đích có thể thuộc
 *    tenant khác tenant nền và các chốt đọc chính sách xuyên tenant
 *    — cùng khuôn đọc của `ClassesService.activatePaidClassEnrol`
 *    phía API và cùng lý do #292 (RLS fail-closed ngoài ngữ cảnh).
 * 2. Đọc lớp đích: không tồn tại → lỗi `class.not_found`; đã lưu
 *    trữ → lỗi `class.archived` (payment đã thu tiền nhưng roster
 *    đóng băng: vận hành xử lý bằng hoàn tiền, không tự phá luật
 *    đóng băng).
 * 3. Đã thuộc roster → dừng tại đây, không phát lại sự kiện vào
 *    lớp, không ghi danh trùng (webhook replay / matching chạy lại
 *    đều an toàn).
 * 4. Đảm bảo membership tenant của lớp cho người mua (học sinh tự
 *    do ở trang chính mua lớp của trung tâm thì được cấp membership
 *    của trung tâm ở bước này, như đường tự báo danh).
 * 5. Chốt tách vai của đường hệ thống: người xin vào vẫn không được
 *    là giáo viên của chính lớp/khoá đích (cùng kiểm tra như đường
 *    roster thủ công).
 * 6. Thêm vào backing cohort (chèn bỏ qua khi trùng — đua hai nhịp
 *    cùng thêm thì nhịp thua không phát sự kiện hai lần).
 * 7. Phát đúng cặp sự kiện như đường API, theo thứ tự của API:
 *    `cohort_member_added` trước (cohort sync vật chất hoá ghi danh
 *    xuống các khoá), rồi `class_member_joined` (dấu lớp đã nhận
 *    thành viên qua gói lớp).
 *
 * Tính nguyên tử của bước 6–7 (phân xử 6509434733 trên PR #552):
 * chèn thành viên + cả hai dòng outbox nằm trong CÙNG một
 * `db.transaction` (dùng `enrolOutbox.enqueue(tx, …)`), không phải
 * ba transaction riêng biệt như trước. Lỗi ở bất kỳ bước nào cũng
 * rollback toàn bộ: lần chạy lại sau đó thấy chưa thuộc roster và
 * chạy đủ cả ba bước ghi. Ngược lại, nếu chèn đã commit mà ghi
 * outbox lỗi giữa chừng thì nhịp vẫn lật payment thành `succeeded`
 * trong khi `cohort_member_added` không bao giờ tồn tại — người đã
 * trả tiền mà quyền học không kích hoạt, phá đúng bất biến mà
 * docblock của `SepayMatchingService` khẳng định (kích hoạt chạy
 * TRƯỚC nhịp lật trạng thái).
 *
 * Khác đường API ở đúng một điểm, có chủ đích: đường API phát thêm
 * sự kiện TRONG TIẾN TRÌNH `cohort_member_added` cho listener đồng
 * bộ của `EnrolModule` — tiến trình worker không có listener đó
 * nên không phát. Đường đồng bộ bền không phụ thuộc bước phát nhanh
 * này: dòng outbox `cohort_member_added` ghi ở bước 7 là đường mà
 * consumer đồng bộ cohort (phía API hôm nay, phía worker sau #550)
 * quét để áp ghi danh — đúng khuôn mà chính đường settle hoàn tiền
 * của API đã dựa vào cho sự kiện rời cohort.
 *
 * Idempotent: đã thuộc roster thì dừng ở bước 3; chèn trùng được
 * bỏ qua ở bước 6 và không phát sự kiện; cohort sync neo vào trạng
 * thái `cohort_members` hiện tại nên phát lại muộn không ghi danh
 * sai.
 *
 * @throws SharedDomainError mã `class.not_found`, `class.archived`,
 * hoặc lỗi chốt tách vai — nhịp matching bắt từng sự kiện và ghi
 * cảnh báo nên lỗi ở đây không làm hỏng cả lô quét.
 */
@Injectable()
export class WorkerPaidClassEnrolActivationService implements PaidClassEnrolActivationPort {
  private readonly materialization: CohortMaterializationSurface;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly enrolOutbox: WorkerEnrolOutboxService,
  ) {
    this.materialization = new CohortMaterializationSurface({
      db: this.db,
      outbox: enrolOutbox,
      runInPlatformScope: (fn) => tenantAls.run({ platform: true }, fn),
    });
  }

  /**
   * Kích hoạt ghi danh cấp lớp cho một payment đã khớp.
   *
   * @param itemId - Id của lớp đích (trường `itemId` của payment).
   * @param userId - Id của người mua (trường `userId` của payment).
   */
  async activatePaidClassEnrol(itemId: string, userId: string): Promise<void> {
    await tenantAls.run({ platform: true }, async () => {
      const [row] = await this.db.select().from(classes).where(eq(classes.id, itemId));
      if (!row) {
        throw new SharedDomainError('class.not_found', `Class ${itemId} not found`);
      }
      if (row.status === 'archived') {
        throw new SharedDomainError('class.archived', 'Class is archived; roster is frozen');
      }
      // Đã thuộc roster (kích hoạt lặp / webhook replay) → dừng tại đây.
      if (await this.materialization.isCohortMember(row.cohortId, userId)) return;
      await ensureActiveTenantMembership(this.db, row.tenantId, userId);
      await this.materialization.roleSeparationChecks.assertCohortMembershipAllowed(userId, row.cohortId);
      // Chèn thành viên + cả hai dòng outbox trong CÙNG một
      // transaction: lỗi ở bước nào cũng rollback toàn bộ, lần chạy
      // lại thấy chưa thuộc roster và chạy đủ cả ba bước ghi.
      await this.db.transaction(async (tx) => {
        const inserted = await tx.insert(cohortMembers)
          .values({ cohortId: row.cohortId, userId })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return;
        await this.enrolOutbox.enqueue(tx, {
          aggregate: 'cohort', type: 'cohort_member_added',
          payload: { cohortId: row.cohortId, userId },
        });
        await this.enrolOutbox.enqueue(tx, {
          aggregate: 'class', type: 'class_member_joined',
          payload: { classId: row.id, tenantId: row.tenantId, userId, via: 'class_fee' },
          tenantId: row.tenantId,
        });
      });
    });
  }
}
