import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import {
  classes, context, course, planEntitlements, pluginConfig, role, roleAssignments,
  tenantMemberships, tenants, users,
} from '../../db/schema';
import { tenantAls } from '../tenants/tenant-als';
import { CONTEXT_LEVELS } from './domain/capabilities';

/**
 * Giá trị KHỞI TẠO của các khoá cấu hình hạn mức slot (component
 * `payments` trong registry của site-config). Đây là bản dự phòng khi
 * kho cấu hình chưa có ghi đè nào: phải khớp `defaultValue` đã đăng
 * ký trong settings registry — quản trị đổi giá trị trong Cài đặt hệ
 * thống thì giá trị lưu trong cơ sở dữ liệu thắng, code không ghim
 * con số hiệu lực nào khác.
 */
const SLOT_CONFIG_DEFAULTS = {
  tenantplanslots: 30,
  teacherplancourseslots: 10,
  tenantplanfreeslots: 3,
  teacherplanfreecourseslots: 1,
  plangracedays: 7,
} as const;
type SlotConfigName = keyof typeof SLOT_CONFIG_DEFAULTS;

/**
 * Archetype của vai trò GIẢNG DẠY theo đặc tả slot đã duyệt: vai trò
 * có quyền soạn khoá/giao đề cho học viên. `manager` (quản lý trung
 * tâm), `coursecreator`, `student`, `guest`, `user` không phải vai
 * trò giảng dạy và không bao giờ tính slot.
 */
export const TEACHING_ROLE_ARCHETYPES = ['editingteacher', 'teacher'] as const;

/** Hạn mức hiệu lực đã phân giải cho một bên hưởng gói. */
export interface EffectivePlanLimit {
  /** Số slot tối đa được phép ở thời điểm hiện tại. */
  limit: number;
  /** Đang trong thời gian ân hạn của gói vừa hết hạn (vẫn áp hạn mức gói). */
  inGracePeriod: boolean;
  /** Có gói đang hoạt động trong cửa sổ hiệu lực. */
  hasActivePlan: boolean;
}

/** Dữ kiện đếm slot của một người dùng trong một tenant. */
export interface TenantSlotFacts {
  /** Membership tại tenant đang ở trạng thái `active`. */
  membershipActive: boolean;
  /** Tài khoản không bị đình chỉ và chưa bị xoá. */
  accountActive: boolean;
  /** Đang giữ ít nhất một dòng gán vai trò giảng dạy trong cây context của tenant. */
  holdsTeachingRole: boolean;
  /** Đang được đếm là một slot của tenant (đủ cả ba điều kiện trên). */
  counted: boolean;
}

/**
 * Thực thi GIỚI HẠN SLOT của hai gói (phần còn lại của lát 2, issue
 * #189 — đặc tả slot đã duyệt toàn bộ ngày 27/10/2026 tại comment
 * 6434192125 của issue; ánh xạ vận hành ghi tại comment bổ sung đặc
 * tả đăng cùng đợt thi công).
 *
 * Luồng nghiệp vụ tổng quát: gói trung tâm bán theo số TÀI KHOẢN
 * GIẢNG DẠY của trung tâm, gói giáo viên bán theo số KHOÁ HỌC giáo
 * viên làm chủ. Cả hai hạn mức đều là CẤU HÌNH HỆ THỐNG (component
 * `payments`, xem {@link SLOT_CONFIG_DEFAULTS}) — service này chỉ
 * thực thi: đếm số đang dùng theo định nghĩa đã duyệt, phân giải hạn
 * mức hiệu lực (gói đang hoạt động → hạn mức gói; hết hạn chưa quá
 * số ngày ân hạn `plangracedays` → vẫn hạn mức gói; còn lại → mức
 * nền) và CHẶN hành động làm tăng slot khi đã chạm hạn mức. Hành
 * động bị chặn không thay đổi bất kỳ thực thể đang có nào (không
 * khoá/đình chỉ/xoá giáo viên hay khoá học vượt mức).
 *
 * Vị trí đặt service: module access là tầng chung thấp nhất mà cả
 * bốn bề mặt điểm chặn (gán vai trò ở access, membership ở tenants,
 * tài khoản ở users, tạo khoá ở courses) đều phụ thuộc vào — đặt ở
 * module payments sẽ tạo vòng phụ thuộc vì payments đang phụ thuộc
 * cả access và tenants. Service đọc dữ liệu xuyên bounded context
 * bằng truy vấn Drizzle trực tiếp qua barrel schema (đúng tiền lệ
 * PermissionEvaluator đọc membership và PaymentsRepository đọc bảng
 * course), và bọc các lượt đọc trong ngữ cảnh platform của
 * `tenantAls` vì đếm slot là nghiệp vụ chính sách của platform (như
 * khuôn bọc platform của TenantsService): ở ngữ cảnh của một tenant,
 * RLS sẽ che membership của tenant khác và làm sai số đếm.
 */
@Injectable()
export class PlanLimitsService {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /**
   * Đọc một khoá cấu hình hạn mức: giá trị quản trị đã lưu trong
   * `plugin_config` (scope platform, tenant_id null) thắng; chưa có
   * ghi đè hoặc giá trị lưu không hợp lệ (không phải số nguyên không
   * âm) thì rơi về giá trị khởi tạo đã đăng ký trong registry.
   */
  private async readSlotConfig(name: SlotConfigName): Promise<number> {
    const [row] = await this.db
      .select({ value: pluginConfig.value })
      .from(pluginConfig)
      .where(and(eq(pluginConfig.plugin, 'payments'), eq(pluginConfig.name, name), isNull(pluginConfig.tenantId)));
    if (row?.value != null) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0) return parsed;
      } catch {
        // Giá trị lưu hỏng JSON: coi như chưa cấu hình, dùng khởi tạo.
      }
    }
    return SLOT_CONFIG_DEFAULTS[name];
  }

  /** Tenant platform (tenant-zero) — tenant duy nhất có `kind = 'platform'`. */
  private async platformTenantId(): Promise<string | null> {
    const [row] = await this.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.kind, 'platform'));
    return row?.id ?? null;
  }

  private async tenantKind(tenantId: string): Promise<string | null> {
    const [row] = await this.db.select({ kind: tenants.kind }).from(tenants).where(eq(tenants.id, tenantId));
    return row?.kind ?? null;
  }

  /**
   * Suy tenant sở hữu một context: context tenant là tổ tiên có
   * `context_level = 20` trong `path` vật chất hoá của context (hoặc
   * chính context đó). Trả null khi context không thuộc tenant nào
   * (context hệ thống/người dùng ở tầng platform).
   */
  async tenantIdForContext(contextId: string, tx?: DbTx): Promise<string | null> {
    const db = tx ?? this.db;
    const [row] = await db.select().from(context).where(eq(context.id, contextId));
    if (!row) return null;
    if (row.contextLevel === CONTEXT_LEVELS.TENANT) return row.instanceId;
    const ancestorIds = row.path.split('/').filter((s) => s.length > 0);
    if (ancestorIds.length === 0) return null;
    const ancestors = await db
      .select({ instanceId: context.instanceId })
      .from(context)
      .where(and(inArray(context.id, ancestorIds), eq(context.contextLevel, CONTEXT_LEVELS.TENANT)));
    return ancestors[0]?.instanceId ?? null;
  }

  /** Context của chính tenant (level 20) — gốc cây context của tenant. */
  private async tenantContext(tenantId: string): Promise<{ id: string; path: string } | null> {
    const [row] = await this.db
      .select({ id: context.id, path: context.path })
      .from(context)
      .where(and(eq(context.contextLevel, CONTEXT_LEVELS.TENANT), eq(context.instanceId, tenantId)));
    return row ?? null;
  }

  /**
   * Phân giải hạn mức hiệu lực của một bên hưởng gói tại thời điểm
   * hiện tại, theo đúng luật đã duyệt: quyền lợi `active` còn trong
   * cửa sổ [startsAt, expiresAt) → hạn mức gói; không còn quyền lợi
   * đang hoạt động nhưng quyền lợi đã thật sự hết hạn gần nhất (mốc
   * hết hạn không muộn hơn hiện tại) chưa quá `plangracedays` ngày
   * → vẫn hạn mức gói (ân hạn); ngoài ra → mức nền. Quyền lợi có cửa
   * sổ hoàn toàn trong tương lai chưa bắt đầu nên không phải mốc tính
   * ân hạn. Quyền lợi đã bị đình chỉ (hoàn tiền) không mở ân hạn.
   */
  private async effectiveLimit(
    component: 'tenant_plan' | 'teacher_plan',
    beneficiary: { tenantId: string; userId: string | null },
    planConfig: SlotConfigName,
    freeConfig: SlotConfigName,
  ): Promise<EffectivePlanLimit> {
    const [planLimit, freeLimit, graceDays] = await Promise.all([
      this.readSlotConfig(planConfig),
      this.readSlotConfig(freeConfig),
      this.readSlotConfig('plangracedays'),
    ]);
    const beneficiaryWhere =
      component === 'tenant_plan'
        ? and(eq(planEntitlements.tenantId, beneficiary.tenantId), isNull(planEntitlements.userId))
        : eq(planEntitlements.userId, beneficiary.userId ?? '');
    const rows = await this.db
      .select({ startsAt: planEntitlements.startsAt, expiresAt: planEntitlements.expiresAt })
      .from(planEntitlements)
      .where(and(eq(planEntitlements.component, component), eq(planEntitlements.status, 'active'), beneficiaryWhere));
    const now = Date.now();
    if (rows.some((r) => r.startsAt.getTime() <= now && now < r.expiresAt.getTime())) {
      return { limit: planLimit, inGracePeriod: false, hasActivePlan: true };
    }
    // Ân hạn chỉ neo vào quyền lợi đã thật sự hết hạn. Không lấy mốc
    // hết hạn của quyền lợi có cửa sổ trong tương lai: cửa sổ đó có
    // thể phát sinh từ lần mua nối tiếp cộng dồn thời hạn, nhưng khi
    // chưa bắt đầu thì không thể gia hạn hiệu lực cho hiện tại.
    const lastExpiry = rows
      .map((r) => r.expiresAt.getTime())
      .filter((expiry) => expiry <= now)
      .reduce<number | null>((max, expiry) => (max === null || expiry > max ? expiry : max), null);
    if (lastExpiry !== null && now < lastExpiry + graceDays * 86_400_000) {
      return { limit: planLimit, inGracePeriod: true, hasActivePlan: false };
    }
    return { limit: freeLimit, inGracePeriod: false, hasActivePlan: false };
  }

  /** Hạn mức slot gói trung tâm hiệu lực của một tenant. */
  async effectiveTenantLimit(tenantId: string): Promise<EffectivePlanLimit> {
    return this.effectiveLimit('tenant_plan', { tenantId, userId: null }, 'tenantplanslots', 'tenantplanfreeslots');
  }

  /** Hạn mức slot gói giáo viên hiệu lực của một giáo viên. */
  async effectiveTeacherLimit(userId: string): Promise<EffectivePlanLimit> {
    return this.effectiveLimit('teacher_plan', { tenantId: '', userId }, 'teacherplancourseslots', 'teacherplanfreecourseslots');
  }

  /**
   * Dữ kiện đếm slot của một người dùng trong một tenant: membership
   * đang `active` hay không, tài khoản có đang hoạt động hay không,
   * và có giữ vai trò giảng dạy ở bất kỳ context nào trong cây của
   * tenant hay không (context của tenant hoặc mọi context con — danh
   * mục, lớp, khoá học). `counted` là hợp của cả ba điều kiện, đúng
   * định nghĩa 1 slot của gói trung tâm đã duyệt.
   */
  async describeUserInTenant(tenantId: string, userId: string): Promise<TenantSlotFacts> {
    return tenantAls.run({ platform: true }, async () => {
      const [membership] = await this.db
        .select({ status: tenantMemberships.status })
        .from(tenantMemberships)
        .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)));
      const [account] = await this.db
        .select({ suspended: users.suspended, deleted: users.deleted })
        .from(users)
        .where(eq(users.id, userId));
      const membershipActive = membership?.status === 'active';
      const accountActive = !!account && !account.suspended && !account.deleted;
      const holdsTeachingRole = await this.userHoldsTeachingRoleInTenant(tenantId, userId);
      return {
        membershipActive,
        accountActive,
        holdsTeachingRole,
        counted: membershipActive && accountActive && holdsTeachingRole,
      };
    });
  }

  /**
   * Người dùng có đang giữ ít nhất một dòng gán vai trò giảng dạy
   * trong cây context của tenant hay không (không xét membership và
   * trạng thái tài khoản — dùng cho các điểm chặn mà hành động đang
   * thực hiện chính là khâu kích hoạt membership/tài khoản).
   */
  async userHoldsTeachingRoleInTenant(tenantId: string, userId: string): Promise<boolean> {
    const tctx = await this.tenantContext(tenantId);
    if (!tctx) return false;
    const [row] = await this.db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .innerJoin(context, eq(context.id, roleAssignments.contextId))
      .where(
        and(
          eq(roleAssignments.userId, userId),
          inArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES]),
          or(eq(context.id, tctx.id), like(context.path, `${tctx.path}/%`)),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Số slot gói trung tâm đang dùng của một tenant: số người dùng
   * phân biệt đồng thời có membership `active`, tài khoản đang hoạt
   * động và giữ vai trò giảng dạy trong cây context của tenant.
   * Học viên (archetype `student`) không bao giờ được đếm.
   */
  async countTenantTeachingSlots(tenantId: string): Promise<number> {
    return tenantAls.run({ platform: true }, async () => {
      const tctx = await this.tenantContext(tenantId);
      if (!tctx) return 0;
      const rows = await this.db
        .selectDistinct({ userId: roleAssignments.userId })
        .from(roleAssignments)
        .innerJoin(role, eq(role.id, roleAssignments.roleId))
        .innerJoin(context, eq(context.id, roleAssignments.contextId))
        .innerJoin(
          tenantMemberships,
          and(eq(tenantMemberships.userId, roleAssignments.userId), eq(tenantMemberships.tenantId, tenantId)),
        )
        .innerJoin(users, eq(users.id, roleAssignments.userId))
        .where(
          and(
            inArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES]),
            eq(tenantMemberships.status, 'active'),
            eq(users.suspended, false),
            eq(users.deleted, false),
            or(eq(context.id, tctx.id), like(context.path, `${tctx.path}/%`)),
          ),
        );
      return rows.length;
    });
  }

  /**
   * Điểm chặn gói trung tâm: chặn khi hành động đang thực hiện SẼ
   * làm `userId` trở thành một slot mới của tenant (bên gọi bảo đảm
   * điều đó — ví dụ gán vai trò giảng dạy cho thành viên đang hoạt
   * động, kích hoạt membership của người đã có vai trò giảng dạy,
   * hoặc bỏ đình chỉ tài khoản của họ) mà số slot đang dùng đã bằng
   * hạn mức hiệu lực. Tenant platform không phải khách hàng mua gói
   * trung tâm nên luôn được miễn. Người dùng đã được đếm rồi thì mọi
   * hành động lặp lại đều là no-op. Lỗi chặn:
   * `plan.tenant_slot_limit_reached` (HTTP 400), nêu hạn mức và số
   * đang dùng; hành động bị chặn không đổi dữ kiện nào đang có.
   */
  async assertTenantSlotForNewTeacher(tenantId: string, userId: string): Promise<void> {
    const kind = await this.tenantKind(tenantId);
    if (kind === null || kind === 'platform') return;
    const facts = await this.describeUserInTenant(tenantId, userId);
    if (facts.counted) return;
    const [{ limit }, used] = await Promise.all([
      this.effectiveTenantLimit(tenantId),
      this.countTenantTeachingSlots(tenantId),
    ]);
    if (used >= limit) {
      throw new BadRequestException({
        message: `Teaching-account slot limit reached for this centre: ${used}/${limit} slots in use`,
        code: 'plan.tenant_slot_limit_reached',
      });
    }
  }

  /**
   * Bỏ đình chỉ tài khoản (điểm chặn ở tầng người dùng): sau khi bỏ
   * đình chỉ, tài khoản được đếm trở lại ở MỌI tenant khách hàng mà
   * người dùng là thành viên `active` có vai trò giảng dạy — tenant
   * nào trong số đó đã chạm hạn mức thì toàn bộ hành động bị chặn
   * tại tenant đó (đúng hành động "kích hoạt lại tài khoản giáo viên
   * đang đình chỉ" trong đặc tả đã duyệt).
   */
  async assertUserReactivationWithinSlotLimits(userId: string): Promise<void> {
    const memberships = await tenantAls.run({ platform: true }, () =>
      this.db
        .select({ tenantId: tenantMemberships.tenantId })
        .from(tenantMemberships)
        .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active'))),
    );
    for (const m of memberships) {
      if ((await this.tenantKind(m.tenantId)) === 'platform') continue;
      if (await this.userHoldsTeachingRoleInTenant(m.tenantId, userId)) {
        await this.assertTenantSlotForNewTeacher(m.tenantId, userId);
      }
    }
  }

  /**
   * Người dùng có phải quản trị platform hay không: giữ một vai trò
   * archetype `manager` tại context hệ thống. Quản trị platform
   * không phải khách hàng của gói giáo viên nên được miễn giới hạn
   * slot gói giáo viên.
   */
  async isSiteAdmin(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .innerJoin(context, eq(context.id, roleAssignments.contextId))
      .where(
        and(
          eq(roleAssignments.userId, userId),
          eq(role.archetype, 'manager'),
          eq(context.contextLevel, CONTEXT_LEVELS.SYSTEM),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Số khoá học một giáo viên đang LÀM CHỦ tại tenant platform (slot
   * của gói giáo viên): khoá không phải khoá mẫu, thuộc tenant
   * platform, và giáo viên hoặc là chủ của lớp chứa khoá, hoặc giữ
   * dòng gán vai trò giảng dạy TRỰC TIẾP tại context của khoá với
   * nguồn không phải ghi danh (`component` khác `enrol` — vai trò
   * nhận qua ghi danh là dạy chung, không tính slot theo đặc tả).
   */
  async countTeacherOwnedCourses(userId: string): Promise<number> {
    const platformTenantId = await this.platformTenantId();
    if (!platformTenantId) return 0;
    const owned = new Set<string>();
    const byClass = await this.db
      .select({ id: course.id })
      .from(course)
      .innerJoin(classes, eq(classes.id, course.classId))
      .where(
        and(
          eq(classes.ownerId, userId),
          eq(course.tenantId, platformTenantId),
          eq(course.isTemplate, false),
        ),
      );
    for (const r of byClass) owned.add(r.id);
    const byGrant = await this.db
      .select({ courseId: context.instanceId })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .innerJoin(context, eq(context.id, roleAssignments.contextId))
      .innerJoin(course, eq(course.id, context.instanceId))
      .where(
        and(
          eq(roleAssignments.userId, userId),
          inArray(role.archetype, [...TEACHING_ROLE_ARCHETYPES]),
          eq(context.contextLevel, CONTEXT_LEVELS.COURSE),
          sql`${roleAssignments.component} <> 'enrol'`,
          eq(course.tenantId, platformTenantId),
          eq(course.isTemplate, false),
        ),
      );
    for (const r of byGrant) if (r.courseId) owned.add(r.courseId);
    return owned.size;
  }

  /**
   * Điểm chặn gói giáo viên tại thời điểm TẠO KHOÁ: chỉ áp dụng khi
   * khoá thuộc tenant platform (khoá trong tenant khách hàng chịu sự
   * điều tiết của gói trung tâm theo số giáo viên, không theo số
   * khoá) và chủ khoá tương lai là chủ của lớp chứa khoá. Chủ khoá
   * là quản trị platform thì được miễn. Đã chạm hạn mức hiệu lực
   * (gồm mức nền và ân hạn như gói trung tâm) thì chặn bằng lỗi
   * `plan.teacher_course_limit_reached` (HTTP 400); các khoá đang có
   * của giáo viên không bị đụng tới.
   */
  async assertTeacherCourseSlotForNewCourse(tenantId: string, classId: string): Promise<void> {
    if ((await this.tenantKind(tenantId)) !== 'platform') return;
    const [cls] = await this.db.select({ ownerId: classes.ownerId }).from(classes).where(eq(classes.id, classId));
    if (!cls) return;
    if (await this.isSiteAdmin(cls.ownerId)) return;
    const [{ limit }, used] = await Promise.all([
      this.effectiveTeacherLimit(cls.ownerId),
      this.countTeacherOwnedCourses(cls.ownerId),
    ]);
    if (used >= limit) {
      throw new BadRequestException({
        message: `Course slot limit reached for this teacher: ${used}/${limit} owned courses in use`,
        code: 'plan.teacher_course_limit_reached',
      });
    }
  }
}
