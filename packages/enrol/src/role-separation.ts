import { and, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import { classes, context, course, enrol, role, roleAssignments, userEnrolments, users } from '@lms/db';
import { CONTEXT_LEVELS } from './contexts';
import { RoleContextConflictError } from './errors';
import { TEACHING_ROLE_ARCHETYPES } from './plan-limits';
import type { EnrolDatabase, PlatformScopeRunner } from './types';

/**
 * Nguồn gán vai do ghi danh cấp (cột `component` của
 * `role_assignments` — xem `ENROL_ASSIGNMENT_COMPONENT` trong
 * `role-assignment.ts`): các dòng gán mang nguồn này bị loại khỏi
 * kiểm (a) theo định nghĩa đã chốt. Hằng số được lặp lại tại đây
 * thay vì import để tránh vòng phụ thuộc module với lõi gán vai
 * (lõi gán vai tiêm lõi này).
 */
const ENROL_ASSIGNMENT_COMPONENT_VALUE = 'enrol';

/** Trạng thái ghi danh đang hoạt động (0 = ACTIVE trong bảng `user_enrolments`). */
const ENROL_ACTIVE_STATUS = 0;

/** Một tài khoản trong báo cáo kiểm toán tách vai (chỉ đọc). */
export interface RoleConflictAuditEntry {
  userId: string;
  username: string;
  email: string;
  /** Các khoá tài khoản vừa có cấp quyền giảng dạy bao phủ vừa có ghi danh học viên đang hoạt động — chỉ nhóm cùng khoá mới có trường này khác rỗng. */
  conflictingCourseIds: string[];
  /** Số khoá tài khoản có cấp quyền giảng dạy bao phủ mà KHÔNG ghi danh học tại đó. */
  teachingOnlyCourseCount: number;
  /** Số khoá tài khoản ghi danh học mà KHÔNG dạy tại đó. */
  learnerOnlyCourseCount: number;
}

/** Báo cáo kiểm toán tách vai: hai nhóm tài khoản tách bạch theo quyết định. */
export interface RoleConflictAuditReport {
  /** NHÓM CÙNG KHOÁ/LỚP: vừa dạy vừa học trong cùng một khoá — VI PHẠM quyết định tách vai. */
  sameCourse: RoleConflictAuditEntry[];
  /** NHÓM KHÁC KHOÁ: dạy ở (các) khoá này, học ở (các) khoá khác, hai tập không giao nhau — HỢP LỆ. */
  crossCourse: RoleConflictAuditEntry[];
}

/**
 * Định nghĩa kiểm tra TÁCH VAI GIÁO VIÊN/HỌC VIÊN dùng chung duy
 * nhất của toàn hệ thống (trích từ tầng Access của API thành lõi
 * tầng dữ liệu để mọi bề mặt vật chất hoá ghi danh — API hôm nay,
 * worker khi nó dựng consumer đồng bộ cohort — gọi về đúng một định
 * nghĩa này).
 *
 * Nguyên tắc nghiệp vụ (quyết định đã chốt, viết trọn vẹn): vai trò
 * phải rõ ràng theo ngữ cảnh — trong khoá một tài khoản ghi danh học
 * thì tài khoản đó thuần là học viên của khoá đó; trong khoá mình dạy
 * thì thuần giáo viên. Một tài khoản ĐƯỢC phép vừa dạy ở khoá này vừa
 * học ở khoá khác (hai tập khoá không giao nhau). Điều bị cấm tuyệt
 * đối là LẪN VAI CÙNG MỘT KHOÁ/LỚP: tài khoản đồng thời có cấp quyền
 * giảng dạy bao phủ một khoá VÀ ghi danh học viên đang hoạt động
 * trong chính khoá đó (hoặc trong lớp chứa khoá đó).
 *
 * Hai kiểm nền (định nghĩa duy nhất — mọi chốt chặn trong hệ thống
 * phải gọi về đây, không định nghĩa lại tại module nghiệp vụ):
 *
 * - Kiểm (a) — cấp quyền giảng dạy bao phủ một khoá: tồn tại một gán
 *   vai archetype `editingteacher`/`teacher` KHÔNG do ghi danh cấp
 *   (loại trừ dòng gán có nguồn ghi danh, `component = 'enrol'`) tại
 *   một context bao phủ khoá theo cây context: context của chính
 *   khoá, context của lớp chứa khoá, context của danh mục chứa khoá
 *   và các context tổ tiên của chúng trên đường (path) của context
 *   khoá. Cấp quyền ở mức HỆ THỐNG (context hệ thống, quản trị toàn
 *   site) KHÔNG tính vào kiểm (a): quản trị toàn site vốn bao phủ
 *   mọi khoá theo thiết kế, nên nếu tính thì quản trị viên sẽ không
 *   bao giờ ghi danh học ở bất kỳ khoá nào — sai với nguyên tắc vai
 *   theo ngữ cảnh.
 * - Kiểm (b) — ghi danh học viên đang hoạt động trong một khoá: tồn
 *   tại một bản ghi `user_enrolments` có trạng thái đang hoạt động
 *   (status = 0) qua một enrol instance của khoá mà vai cấp kèm của
 *   instance (nếu có) không thuộc archetype giảng dạy. Instance được
 *   quản trị cấu hình để cấp vai giảng dạy là đường cấp vai quản trị,
 *   nằm ngoài quyết định này; vì vậy cả hai kiểm đều neo vào
 *   archetype của vai mà instance cấp, mặc định là học viên.
 *
 * Các điểm chốt gọi về lõi này: funnel ghi danh lõi (bề mặt vật
 * chất hoá cohort của package này), hai điểm vào thêm thành viên
 * cohort ở tầng nghiệp vụ của host, contributor `enrol` khi khôi
 * phục backup (bỏ qua từng ghi danh vi phạm thay vì ném lỗi), và
 * chốt chiều ngược tại đường gán vai (`RoleAssignmentCore`).
 *
 * Mọi truy vấn đọc của lõi chạy trong ngữ cảnh platform tường minh
 * do host cấp (cổng {@link PlatformScopeRunner}, cùng khuôn với các
 * phép đọc đếm slot): các bảng nền của kiểm tra (context,
 * role_assignments, enrol, user_enrolments) có thể bị RLS che khi
 * khoá đích thuộc tenant khác với tenant hiệu lực của người gọi, và
 * một kết quả "không thấy" do bị che sẽ làm chốt chặn lọt đúng ca
 * cần chặn. Đọc xuyên tenant tại đây là an toàn vì lõi chỉ trả lời
 * có/không cho đúng cặp (người dùng, khoá) mà caller đã được gác
 * quyền ở tầng trên.
 */
export class RoleSeparationCore {
  /**
   * @param db - tay cầm Drizzle của host.
   * @param runInPlatformScope - cổng chạy trong ngữ cảnh platform của host.
   */
  constructor(
    private readonly db: EnrolDatabase,
    private readonly runInPlatformScope: PlatformScopeRunner,
  ) {}

  /**
   * Chạy một lượt đọc trong ngữ cảnh platform tường minh (xem lời
   * dẫn của class về lý do đọc xuyên tenant).
   *
   * @param fn - lượt đọc cần thực hiện.
   * @returns kết quả của `fn`.
   */
  private async withPlatformRead<T>(fn: () => Promise<T>): Promise<T> {
    return this.runInPlatformScope(fn);
  }

  /**
   * Kiểm (a): người dùng có cấp quyền giảng dạy bao phủ một khoá
   * không (định nghĩa đầy đủ ở lời dẫn của class).
   *
   * Flow:
   * 1. Lấy context của khoá (cấp 50) và tách đường tổ tiên của nó.
   * 2. Loại context hệ thống khỏi tập context bao phủ.
   * 3. Đếm các gán vai của người dùng tại các context còn lại, với
   *    archetype giảng dạy và nguồn KHÔNG phải ghi danh.
   *
   * @param userId - người dùng cần kiểm.
   * @param courseId - khoá đích.
   * @returns true khi tồn tại ít nhất một gán vai giảng dạy bao phủ khoá.
   */
  async hasTeachingCoverageForCourse(userId: string, courseId: string): Promise<boolean> {
    return this.withPlatformRead(async () => {
      const [courseCtx] = await this.db
        .select({ path: context.path })
        .from(context)
        .where(and(eq(context.contextLevel, CONTEXT_LEVELS.COURSE), eq(context.instanceId, courseId)));
      if (!courseCtx) return false;
      const ancestorIds = courseCtx.path.split('/').filter(Boolean);
      if (!ancestorIds.length) return false;
      const ancestorRows = await this.db
        .select({ id: context.id, contextLevel: context.contextLevel })
        .from(context)
        .where(inArray(context.id, ancestorIds));
      const coveringIds = ancestorRows.filter((r) => r.contextLevel !== CONTEXT_LEVELS.SYSTEM).map((r) => r.id);
      if (!coveringIds.length) return false;
      const rows = await this.db
        .select({ id: roleAssignments.id })
        .from(roleAssignments)
        .innerJoin(role, eq(role.id, roleAssignments.roleId))
        .where(and(
          eq(roleAssignments.userId, userId),
          inArray(roleAssignments.contextId, coveringIds),
          inArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES]),
          ne(roleAssignments.component, ENROL_ASSIGNMENT_COMPONENT_VALUE),
        ));
      return rows.length > 0;
    });
  }

  /**
   * Kiểm (b): người dùng có ghi danh học viên ĐANG HOẠT ĐỘNG trong
   * một khoá không (định nghĩa đầy đủ ở lời dẫn của class).
   *
   * @param userId - người dùng cần kiểm.
   * @param courseId - khoá đích.
   * @returns true khi tồn tại ghi danh đang hoạt động qua một instance
   * cấp vai không thuộc archetype giảng dạy (hoặc không cấp vai nào).
   */
  async hasActiveLearnerEnrolment(userId: string, courseId: string): Promise<boolean> {
    return this.withPlatformRead(async () => {
      const rows = await this.db
        .select({ id: userEnrolments.id })
        .from(userEnrolments)
        .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
        .leftJoin(role, eq(role.id, enrol.roleId))
        .where(and(
          eq(userEnrolments.userId, userId),
          eq(enrol.courseId, courseId),
          eq(userEnrolments.status, ENROL_ACTIVE_STATUS),
          or(isNull(role.archetype), notInArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES])),
        ));
      return rows.length > 0;
    });
  }

  /**
   * Vai mà một enrol instance cấp kèm có phải vai HỌC VIÊN hay không
   * (theo định nghĩa 5 của quyết định: chốt chặn neo vào archetype
   * của vai instance cấp; instance không cấp vai nào vẫn tính là ghi
   * danh học viên).
   *
   * @param roleId - vai cấp kèm của instance (có thể null).
   * @returns true khi vai vắng mặt hoặc archetype không thuộc nhóm giảng dạy.
   */
  async isLearnerGrantRole(roleId: string | null): Promise<boolean> {
    if (!roleId) return true;
    return this.withPlatformRead(async () => {
      const [row] = await this.db.select({ archetype: role.archetype }).from(role).where(eq(role.id, roleId));
      return !(TEACHING_ROLE_ARCHETYPES as readonly string[]).includes(row?.archetype ?? '');
    });
  }

  /**
   * Khẳng định một ghi danh học viên vào một khoá là hợp lệ theo
   * nguyên tắc tách vai: ném lỗi khi kiểm (a) dương tính cho đúng
   * khoá đích.
   *
   * @param userId - người dùng sắp được ghi danh làm học viên.
   * @param courseId - khoá đích của ghi danh.
   * @throws RoleContextConflictError mã `access.role_context_conflict` khi
   * người dùng đã có cấp quyền giảng dạy bao phủ chính khoá này.
   */
  async assertLearnerEnrolmentAllowed(userId: string, courseId: string): Promise<void> {
    if (await this.hasTeachingCoverageForCourse(userId, courseId)) {
      throw new RoleContextConflictError(
        'User already holds a teaching role covering this course and cannot be enrolled in it as a learner',
      );
    }
  }

  /**
   * Các khoá mà một cohort cấp học viên vào: mọi khoá có enrol
   * instance cohort trỏ vào cohort này, cộng mọi khoá thuộc các lớp
   * mà cohort này là cohort nền (backing cohort). Hai nguồn được hợp
   * nhất vì một lớp luôn có instance cohort ở từng khoá, nhưng khoá
   * vừa tạo trong lớp (instance chưa kịp dựng) vẫn phải được chốt
   * chặn qua đường lớp.
   *
   * @param cohortId - cohort đích.
   * @returns danh sách id khoá (không trùng).
   */
  async coursesFedByCohort(cohortId: string): Promise<string[]> {
    return this.withPlatformRead(async () => {
      const viaInstances = await this.db
        .select({ courseId: enrol.courseId })
        .from(enrol)
        .where(and(eq(enrol.enrol, 'cohort'), eq(enrol.customInt1, cohortId)));
      const viaClasses = await this.db
        .select({ id: course.id })
        .from(course)
        .innerJoin(classes, eq(classes.id, course.classId))
        .where(eq(classes.cohortId, cohortId));
      return [...new Set([...viaInstances.map((r) => r.courseId), ...viaClasses.map((r) => r.id)])];
    });
  }

  /**
   * Khẳng định việc thêm một người dùng vào một cohort là hợp lệ:
   * áp kiểm (a) cho MỌI khoá mà cohort cấp học viên vào. Đây là chốt
   * của funnel 2 — mọi đường vào roster của lớp (theo userId, khớp
   * email/số điện thoại, nhập Excel, tham gia bằng mã, mua gói lớp)
   * đều hội tụ về hai điểm vào thêm thành viên cohort, nên chốt tại
   * đây phủ toàn bộ các đường đó.
   *
   * @param userId - người dùng sắp vào cohort.
   * @param cohortId - cohort đích.
   * @throws RoleContextConflictError mã `access.role_context_conflict` khi
   * người dùng đang dạy bất kỳ khoá nào thuộc lớp/cohort đích.
   */
  async assertCohortMembershipAllowed(userId: string, cohortId: string): Promise<void> {
    const courseIds = await this.coursesFedByCohort(cohortId);
    for (const courseId of courseIds) await this.assertLearnerEnrolmentAllowed(userId, courseId);
  }

  /**
   * Các khoá bị bao phủ bởi một context gán vai, dùng cho chốt chiều
   * ngược: context khoá bao phủ đúng khoá của nó; context lớp bao
   * phủ mọi khoá thuộc lớp; mọi cấp context khác (hệ thống, tenant,
   * danh mục, module…) không thuộc phạm vi chốt chiều ngược theo
   * quyết định — gán vai giảng dạy ở các cấp đó là hành động quản trị
   * có chủ đích và không bị chặn bởi ghi danh học viên.
   *
   * @param contextId - context sắp nhận gán vai.
   * @returns danh sách id khoá bị bao phủ (rỗng khi context không thuộc hai cấp khoá/lớp).
   */
  async coveredCoursesForContext(contextId: string): Promise<string[]> {
    return this.withPlatformRead(async () => {
      const [ctx] = await this.db
        .select({ contextLevel: context.contextLevel, instanceId: context.instanceId })
        .from(context)
        .where(eq(context.id, contextId));
      if (!ctx || !ctx.instanceId) return [];
      if (ctx.contextLevel === CONTEXT_LEVELS.COURSE) return [ctx.instanceId];
      if (ctx.contextLevel === CONTEXT_LEVELS.CLASS) {
        const rows = await this.db.select({ id: course.id }).from(course).where(eq(course.classId, ctx.instanceId));
        return rows.map((r) => r.id);
      }
      return [];
    });
  }

  /**
   * Khẳng định việc gán một vai GIẢNG DẠY (không do ghi danh cấp) tại
   * một context khoá/lớp cho một người dùng là hợp lệ: ném lỗi khi
   * người dùng đang có ghi danh học viên đang hoạt động trong bất kỳ
   * khoá nào bị context đó bao phủ (kiểm (b)). Đây là chốt chiều
   * ngược của cùng một bất biến — chặn đường "đang học rồi được cấp
   * vai dạy ngay trong khoá mình học".
   *
   * @param userId - người dùng sắp nhận gán vai giảng dạy.
   * @param contextId - context đích của gán vai.
   * @throws RoleContextConflictError mã `access.role_context_conflict` khi
   * tồn tại ghi danh học viên đang hoạt động trong khoá bị bao phủ.
   */
  async assertTeachingAssignmentAllowed(userId: string, contextId: string): Promise<void> {
    const courseIds = await this.coveredCoursesForContext(contextId);
    for (const courseId of courseIds) {
      if (await this.hasActiveLearnerEnrolment(userId, courseId)) {
        throw new RoleContextConflictError(
          'User is an active learner in a course covered by this context and cannot be assigned a teaching role there',
        );
      }
    }
  }

  /**
   * Kiểm toán CHỈ ĐỌC dữ kiện đã tồn tại theo đúng hai định nghĩa
   * (a)/(b) của class này: liệt kê mọi tài khoản vừa có cấp quyền
   * giảng dạy bao phủ ít nhất một khoá vừa có ghi danh học viên đang
   * hoạt động ở ít nhất một khoá, tách thành NHÓM CÙNG KHOÁ/LỚP (hai
   * tập khoá giao nhau — vi phạm quyết định) và NHÓM KHÁC KHOÁ (hai
   * tập rời nhau — hợp lệ). Hàm này TUYỆT ĐỐI không ghi dữ kiện: chỉ
   * gồm các truy vấn SELECT và phân loại trong bộ nhớ; việc xử lý
   * nhóm vi phạm (rút ghi danh) là quyết định vận hành riêng, không
   * thuộc lõi này.
   *
   * Flow:
   * 1. Dựng, cho mỗi khoá, tập context tổ tiên bao phủ khoá (loại trừ
   *    context hệ thống) từ cây context.
   * 2. Nạp mọi gán vai giảng dạy không do ghi danh cấp → suy ra tập
   *    khoá được bao phủ của từng người dùng.
   * 3. Nạp mọi ghi danh học viên đang hoạt động → tập khoá đang học
   *    của từng người dùng.
   * 4. Giao nhau khác rỗng → nhóm cùng khoá; có cả hai tập nhưng rời
   *    nhau → nhóm khác khoá.
   *
   * @returns báo cáo hai nhóm kèm định danh hiển thị của từng tài khoản.
   */
  async auditRoleConflicts(): Promise<RoleConflictAuditReport> {
    return this.withPlatformRead(async () => {
      const contextRows = await this.db
        .select({ id: context.id, contextLevel: context.contextLevel, instanceId: context.instanceId, path: context.path })
        .from(context);
      const systemContextId = contextRows.find((r) => r.contextLevel === CONTEXT_LEVELS.SYSTEM)?.id;
      const coveringContextsByCourse = new Map<string, Set<string>>();
      for (const row of contextRows) {
        if (row.contextLevel === CONTEXT_LEVELS.COURSE && row.instanceId) {
          coveringContextsByCourse.set(
            row.instanceId,
            new Set(row.path.split('/').filter(Boolean).filter((id) => id !== systemContextId)),
          );
        }
      }
      const teachingAssignments = await this.db
        .select({ userId: roleAssignments.userId, contextId: roleAssignments.contextId })
        .from(roleAssignments)
        .innerJoin(role, eq(role.id, roleAssignments.roleId))
        .where(and(
          inArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES]),
          ne(roleAssignments.component, ENROL_ASSIGNMENT_COMPONENT_VALUE),
        ));
      const teachingContextsByUser = new Map<string, Set<string>>();
      for (const row of teachingAssignments) {
        const set = teachingContextsByUser.get(row.userId) ?? new Set<string>();
        set.add(row.contextId);
        teachingContextsByUser.set(row.userId, set);
      }
      const coveredCoursesByUser = new Map<string, Set<string>>();
      for (const [userId, contextIds] of teachingContextsByUser) {
        const covered = new Set<string>();
        for (const [courseId, covering] of coveringContextsByCourse) {
          for (const ctxId of contextIds) {
            if (covering.has(ctxId)) { covered.add(courseId); break; }
          }
        }
        if (covered.size) coveredCoursesByUser.set(userId, covered);
      }
      const learnerRows = await this.db
        .select({ userId: userEnrolments.userId, courseId: enrol.courseId })
        .from(userEnrolments)
        .innerJoin(enrol, eq(enrol.id, userEnrolments.enrolId))
        .leftJoin(role, eq(role.id, enrol.roleId))
        .where(and(
          eq(userEnrolments.status, ENROL_ACTIVE_STATUS),
          or(isNull(role.archetype), notInArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES])),
        ));
      const learnerCoursesByUser = new Map<string, Set<string>>();
      for (const row of learnerRows) {
        const set = learnerCoursesByUser.get(row.userId) ?? new Set<string>();
        set.add(row.courseId);
        learnerCoursesByUser.set(row.userId, set);
      }
      const candidateIds = [...coveredCoursesByUser.keys()].filter((userId) => learnerCoursesByUser.has(userId));
      if (!candidateIds.length) return { sameCourse: [], crossCourse: [] };
      const userRows = await this.db
        .select({ id: users.id, username: users.username, email: users.email })
        .from(users)
        .where(inArray(users.id, candidateIds));
      const displayById = new Map(userRows.map((u) => [u.id, u]));
      const sameCourse: RoleConflictAuditEntry[] = [];
      const crossCourse: RoleConflictAuditEntry[] = [];
      for (const userId of candidateIds) {
        const covered = coveredCoursesByUser.get(userId)!;
        const learning = learnerCoursesByUser.get(userId)!;
        const conflicting = [...covered].filter((courseId) => learning.has(courseId)).sort();
        const display = displayById.get(userId);
        const entry: RoleConflictAuditEntry = {
          userId,
          username: display?.username ?? '',
          email: display?.email ?? '',
          conflictingCourseIds: conflicting,
          teachingOnlyCourseCount: [...covered].filter((courseId) => !learning.has(courseId)).length,
          learnerOnlyCourseCount: [...learning].filter((courseId) => !covered.has(courseId)).length,
        };
        if (conflicting.length) sameCourse.push(entry);
        else crossCourse.push(entry);
      }
      const byUsername = (a: RoleConflictAuditEntry, b: RoleConflictAuditEntry): number => a.username.localeCompare(b.username);
      return { sameCourse: sameCourse.sort(byUsername), crossCourse: crossCourse.sort(byUsername) };
    });
  }
}
