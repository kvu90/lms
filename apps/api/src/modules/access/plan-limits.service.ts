import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { PlanLimitsCore, type EffectivePlanLimit, type EnrolDatabase, type TenantSlotFacts } from '@lms/enrol';
import type { Database, DbTx } from '../../db/database';
import { tenantAls } from '../tenants/tenant-als';
import { delegateToSharedCore } from './translate-shared-error';

export { TEACHING_ROLE_ARCHETYPES } from '@lms/enrol';
export type { EffectivePlanLimit, TenantSlotFacts } from '@lms/enrol';

/**
 * Facade Nest của định nghĩa thực thi GIỚI HẠN SLOT của hai gói.
 *
 * Định nghĩa đếm slot, phân giải hạn mức hiệu lực và các điểm chặn
 * sống ở lõi dùng chung `PlanLimitsCore` của package `@lms/enrol`
 * (tầng dữ liệu, trên schema dùng chung `@lms/db`) để mọi bề mặt
 * vật chất hoá ghi danh — API tại đây, worker khi nó dựng consumer
 * đồng bộ cohort — áp đúng MỘT định nghĩa duy nhất. Service này chỉ
 * còn là lớp bọc của API: dựng lõi bằng tay cầm Drizzle của API và
 * cổng ngữ cảnh platform của API (bản sao `tenantAls` của tiến
 * trình này), rồi dịch lỗi của lõi (mang mã kỹ thuật) về exception
 * HTTP mang cùng mã và thông điệp như trước khi trích xuất.
 *
 * Nghiệp vụ mà lõi thực thi (đặc tả slot đã duyệt, viết trọn vẹn):
 * gói trung tâm bán theo số TÀI KHOẢN GIẢNG DẠY của trung tâm, gói
 * giáo viên bán theo số KHOÁ HỌC giáo viên làm chủ. Cả hai hạn mức
 * đều là CẤU HÌNH HỆ THỐNG (component `payments`) — lõi chỉ thực
 * thi: đếm số đang dùng theo định nghĩa đã duyệt, phân giải hạn mức
 * hiệu lực (gói đang hoạt động → hạn mức gói; hết hạn chưa quá số
 * ngày ân hạn → vẫn hạn mức gói; còn lại → mức nền) và CHẶN hành
 * động làm tăng slot khi đã chạm hạn mức. Hành động bị chặn không
 * thay đổi bất kỳ thực thể đang có nào. Vị trí đặt service: module
 * access là tầng chung thấp nhất mà cả bốn bề mặt điểm chặn (gán
 * vai trò ở access, membership ở tenants, tài khoản ở users, tạo
 * khoá ở courses) đều phụ thuộc vào.
 */
@Injectable()
export class PlanLimitsService {
  private readonly core: PlanLimitsCore;

  constructor(@InjectDrizzle() db: Database) {
    this.core = new PlanLimitsCore(db, (fn) => tenantAls.run({ platform: true }, fn));
  }

  /**
   * Suy tenant sở hữu một context: context tenant là tổ tiên có
   * `context_level = 20` trong `path` vật chất hoá của context (hoặc
   * chính context đó). Trả null khi context không thuộc tenant nào.
   */
  async tenantIdForContext(contextId: string, tx?: DbTx): Promise<string | null> {
    // Handle transaction của API và handle của package dùng chung cùng
    // là handle Drizzle trên Postgres — ép kiểu tại biên uỷ quyền này.
    return delegateToSharedCore(() => this.core.tenantIdForContext(contextId, tx as unknown as EnrolDatabase | undefined));
  }

  /** Hạn mức slot gói trung tâm hiệu lực của một tenant. */
  async effectiveTenantLimit(tenantId: string): Promise<EffectivePlanLimit> {
    return delegateToSharedCore(() => this.core.effectiveTenantLimit(tenantId));
  }

  /** Hạn mức slot gói giáo viên hiệu lực của một giáo viên. */
  async effectiveTeacherLimit(userId: string): Promise<EffectivePlanLimit> {
    return delegateToSharedCore(() => this.core.effectiveTeacherLimit(userId));
  }

  /**
   * Dữ kiện đếm slot của một người dùng trong một tenant: membership
   * đang `active` hay không, tài khoản có đang hoạt động hay không,
   * và có giữ vai trò giảng dạy ở bất kỳ context nào trong cây của
   * tenant hay không. `counted` là hợp của cả ba điều kiện.
   */
  async describeUserInTenant(tenantId: string, userId: string): Promise<TenantSlotFacts> {
    return delegateToSharedCore(() => this.core.describeUserInTenant(tenantId, userId));
  }

  /**
   * Người dùng có đang giữ ít nhất một dòng gán vai trò giảng dạy
   * trong cây context của tenant hay không.
   */
  async userHoldsTeachingRoleInTenant(tenantId: string, userId: string): Promise<boolean> {
    return delegateToSharedCore(() => this.core.userHoldsTeachingRoleInTenant(tenantId, userId));
  }

  /**
   * Số slot gói trung tâm đang dùng của một tenant: số người dùng
   * phân biệt đồng thời có membership `active`, tài khoản đang hoạt
   * động và giữ vai trò giảng dạy trong cây context của tenant.
   */
  async countTenantTeachingSlots(tenantId: string): Promise<number> {
    return delegateToSharedCore(() => this.core.countTenantTeachingSlots(tenantId));
  }

  /**
   * Điểm chặn gói trung tâm: chặn khi hành động đang thực hiện SẼ
   * làm `userId` trở thành một slot mới của tenant mà số slot đang
   * dùng đã bằng hạn mức hiệu lực. Lỗi chặn 400 mã
   * `plan.tenant_slot_limit_reached`; hành động bị chặn không đổi
   * dữ kiện nào đang có.
   */
  async assertTenantSlotForNewTeacher(tenantId: string, userId: string): Promise<void> {
    return delegateToSharedCore(() => this.core.assertTenantSlotForNewTeacher(tenantId, userId));
  }

  /**
   * Bỏ đình chỉ tài khoản (điểm chặn ở tầng người dùng): sau khi bỏ
   * đình chỉ, tài khoản được đếm trở lại ở MỌI tenant khách hàng mà
   * người dùng là thành viên `active` có vai trò giảng dạy — tenant
   * nào trong số đó đã chạm hạn mức thì toàn bộ hành động bị chặn
   * tại tenant đó.
   */
  async assertUserReactivationWithinSlotLimits(userId: string): Promise<void> {
    return delegateToSharedCore(() => this.core.assertUserReactivationWithinSlotLimits(userId));
  }

  /**
   * Người dùng có phải quản trị platform hay không: giữ một vai trò
   * archetype `manager` tại context hệ thống.
   */
  async isSiteAdmin(userId: string): Promise<boolean> {
    return delegateToSharedCore(() => this.core.isSiteAdmin(userId));
  }

  /**
   * Số khoá học một giáo viên đang LÀM CHỦ tại tenant platform (slot
   * của gói giáo viên): khoá không phải khoá mẫu, thuộc tenant
   * platform, và giáo viên hoặc là chủ của lớp chứa khoá, hoặc giữ
   * dòng gán vai trò giảng dạy trực tiếp tại context của khoá với
   * nguồn không phải ghi danh.
   */
  async countTeacherOwnedCourses(userId: string): Promise<number> {
    return delegateToSharedCore(() => this.core.countTeacherOwnedCourses(userId));
  }

  /**
   * Điểm chặn gói giáo viên tại thời điểm TẠO KHOÁ: chỉ áp dụng khi
   * khoá thuộc tenant platform và chủ khoá tương lai là chủ của lớp
   * chứa khoá. Đã chạm hạn mức hiệu lực thì chặn bằng lỗi 400 mã
   * `plan.teacher_course_limit_reached`.
   */
  async assertTeacherCourseSlotForNewCourse(tenantId: string, classId: string): Promise<void> {
    return delegateToSharedCore(() => this.core.assertTeacherCourseSlotForNewCourse(tenantId, classId));
  }
}
