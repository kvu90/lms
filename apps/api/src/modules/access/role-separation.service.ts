import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { RoleSeparationCore, type RoleConflictAuditReport } from '@lms/enrol';
import type { Database } from '../../db/database';
import { tenantAls } from '../tenants/tenant-als';
import { delegateToSharedCore } from './translate-shared-error';

export { isRoleContextConflictError, ROLE_CONTEXT_CONFLICT_CODE } from '@lms/enrol';
export type { RoleConflictAuditEntry, RoleConflictAuditReport } from '@lms/enrol';

/**
 * Facade Nest của định nghĩa kiểm tra TÁCH VAI GIÁO VIÊN/HỌC VIÊN.
 *
 * Định nghĩa và toàn bộ truy vấn của kiểm tách vai sống ở lõi dùng
 * chung `RoleSeparationCore` của package `@lms/enrol` (tầng dữ liệu,
 * trên schema dùng chung `@lms/db`) để mọi bề mặt vật chất hoá ghi
 * danh — API tại đây, worker khi nó dựng consumer đồng bộ cohort —
 * gọi về đúng MỘT định nghĩa duy nhất. Service này chỉ còn là lớp
 * bọc của API: dựng lõi bằng tay cầm Drizzle của API và cổng ngữ
 * cảnh platform của API (bản sao `tenantAls` của tiến trình này),
 * rồi dịch lỗi của lõi (mang mã kỹ thuật) về exception HTTP mang
 * cùng mã và thông điệp như trước khi trích xuất.
 *
 * Nguyên tắc nghiệp vụ mà lõi thực thi (quyết định đã chốt, viết
 * trọn vẹn): vai trò phải rõ ràng theo ngữ cảnh — trong khoá một
 * tài khoản ghi danh học thì tài khoản đó thuần là học viên của
 * khoá đó; trong khoá mình dạy thì thuần giáo viên. Một tài khoản
 * ĐƯỢC phép vừa dạy ở khoá này vừa học ở khoá khác (hai tập khoá
 * không giao nhau). Điều bị cấm tuyệt đối là LẪN VAI CÙNG MỘT
 * KHOÁ/LỚP: tài khoản đồng thời có cấp quyền giảng dạy bao phủ một
 * khoá VÀ ghi danh học viên đang hoạt động trong chính khoá đó
 * (hoặc trong lớp chứa khoá đó). Hai kiểm nền của lõi: (a) cấp
 * quyền giảng dạy bao phủ khoá — gán vai archetype
 * `editingteacher`/`teacher` không do ghi danh cấp tại một context
 * bao phủ khoá theo cây context, loại trừ cấp ở context hệ thống;
 * (b) ghi danh học viên đang hoạt động trong khoá — bản ghi
 * `user_enrolments` đang hoạt động qua instance cấp vai không thuộc
 * archetype giảng dạy (hoặc không cấp vai nào).
 */
@Injectable()
export class RoleSeparationService {
  private readonly core: RoleSeparationCore;

  constructor(@InjectDrizzle() db: Database) {
    this.core = new RoleSeparationCore(db, (fn) => tenantAls.run({ platform: true }, fn));
  }

  /**
   * Kiểm (a): người dùng có cấp quyền giảng dạy bao phủ một khoá
   * không (định nghĩa đầy đủ ở lõi dùng chung).
   *
   * @param userId - người dùng cần kiểm.
   * @param courseId - khoá đích.
   */
  async hasTeachingCoverageForCourse(userId: string, courseId: string): Promise<boolean> {
    return delegateToSharedCore(() => this.core.hasTeachingCoverageForCourse(userId, courseId));
  }

  /**
   * Kiểm (b): người dùng có ghi danh học viên ĐANG HOẠT ĐỘNG trong
   * một khoá không (định nghĩa đầy đủ ở lõi dùng chung).
   *
   * @param userId - người dùng cần kiểm.
   * @param courseId - khoá đích.
   */
  async hasActiveLearnerEnrolment(userId: string, courseId: string): Promise<boolean> {
    return delegateToSharedCore(() => this.core.hasActiveLearnerEnrolment(userId, courseId));
  }

  /**
   * Vai mà một enrol instance cấp kèm có phải vai HỌC VIÊN hay
   * không (archetype không thuộc nhóm giảng dạy, hoặc instance
   * không cấp vai nào).
   *
   * @param roleId - vai cấp kèm của instance (có thể null).
   */
  async isLearnerGrantRole(roleId: string | null): Promise<boolean> {
    return delegateToSharedCore(() => this.core.isLearnerGrantRole(roleId));
  }

  /**
   * Khẳng định một ghi danh học viên vào một khoá là hợp lệ theo
   * nguyên tắc tách vai: ném lỗi 400 mã `access.role_context_conflict`
   * khi kiểm (a) dương tính cho đúng khoá đích.
   *
   * @param userId - người dùng sắp được ghi danh làm học viên.
   * @param courseId - khoá đích của ghi danh.
   */
  async assertLearnerEnrolmentAllowed(userId: string, courseId: string): Promise<void> {
    return delegateToSharedCore(() => this.core.assertLearnerEnrolmentAllowed(userId, courseId));
  }

  /**
   * Các khoá mà một cohort cấp học viên vào: mọi khoá có enrol
   * instance cohort trỏ vào cohort này, cộng mọi khoá thuộc các lớp
   * mà cohort này là cohort nền.
   *
   * @param cohortId - cohort đích.
   */
  async coursesFedByCohort(cohortId: string): Promise<string[]> {
    return delegateToSharedCore(() => this.core.coursesFedByCohort(cohortId));
  }

  /**
   * Khẳng định việc thêm một người dùng vào một cohort là hợp lệ:
   * áp kiểm (a) cho MỌI khoá mà cohort cấp học viên vào; ném lỗi
   * 400 mã `access.role_context_conflict` khi vi phạm.
   *
   * @param userId - người dùng sắp vào cohort.
   * @param cohortId - cohort đích.
   */
  async assertCohortMembershipAllowed(userId: string, cohortId: string): Promise<void> {
    return delegateToSharedCore(() => this.core.assertCohortMembershipAllowed(userId, cohortId));
  }

  /**
   * Các khoá bị bao phủ bởi một context gán vai, dùng cho chốt
   * chiều ngược: context khoá bao phủ đúng khoá của nó; context lớp
   * bao phủ mọi khoá thuộc lớp; các cấp khác không thuộc phạm vi
   * chốt chiều ngược.
   *
   * @param contextId - context sắp nhận gán vai.
   */
  async coveredCoursesForContext(contextId: string): Promise<string[]> {
    return delegateToSharedCore(() => this.core.coveredCoursesForContext(contextId));
  }

  /**
   * Khẳng định việc gán một vai GIẢNG DẠY (không do ghi danh cấp)
   * tại một context khoá/lớp cho một người dùng là hợp lệ: ném lỗi
   * 400 mã `access.role_context_conflict` khi người dùng đang có
   * ghi danh học viên đang hoạt động trong khoá bị context đó bao
   * phủ (kiểm (b)).
   *
   * @param userId - người dùng sắp nhận gán vai giảng dạy.
   * @param contextId - context đích của gán vai.
   */
  async assertTeachingAssignmentAllowed(userId: string, contextId: string): Promise<void> {
    return delegateToSharedCore(() => this.core.assertTeachingAssignmentAllowed(userId, contextId));
  }

  /**
   * Kiểm toán CHỈ ĐỌC dữ kiện đã tồn tại theo hai định nghĩa (a)/(b):
   * liệt kê các tài khoản vừa dạy vừa học, tách nhóm cùng khoá
   * (vi phạm) và nhóm khác khoá (hợp lệ). Hàm này không ghi dữ
   * kiện; xem lõi dùng chung để biết flow đầy đủ.
   */
  async auditRoleConflicts(): Promise<RoleConflictAuditReport> {
    return delegateToSharedCore(() => this.core.auditRoleConflicts());
  }
}
