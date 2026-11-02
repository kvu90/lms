import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { GradesService } from '../grades/grades.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { TenantsRepository } from '../tenants/tenants.repository';
import { TenantsService } from '../tenants/tenants.service';
import { UsersService } from '../users/users.service';
import { GuardiansRepository, type GuardianLinkRow } from '@lms/db/repositories/guardians';

/** Capability quản lý liên kết giám hộ (PH-0, issue #116). */
export const GUARDIAN_MANAGE_CAPABILITY = 'guardian:manage';

/** Một học sinh trong danh sách con của phụ huynh, kèm thông tin hiển thị tối thiểu. */
export interface GuardianStudentView {
  link: GuardianLinkRow;
  student: { id: string; username: string; firstName: string; lastName: string; email: string };
}

/**
 * Nghiệp vụ giám hộ (PH-0, issue #116): liên kết PH–HS do trường xác lập
 * theo hồ sơ đã xác minh (TT 22 Đ.20.6; NĐ 13/2023 Đ.20 — quan hệ giám hộ
 * phải được xác minh, không tự khai báo) và bề mặt đọc chỉ-xem của phụ
 * huynh. Nguyên tắc cứng của research (mục 5.1): chỉ-xem; chỉ dữ liệu của
 * con mình; chỉ dữ liệu ĐÃ CÔNG BỐ; không xếp hạng/so sánh; không hành
 * động thay con. Mọi lần phụ huynh xem dữ liệu điểm của con đều ghi audit
 * vào event_log qua outbox (aggregate 'guardian').
 */
@Injectable()
export class GuardiansService {
  constructor(
    private readonly repo: GuardiansRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly users: UsersService,
    private readonly grades: GradesService,
    private readonly outbox: OutboxService,
    private readonly tenantContext: TenantContextService,
    private readonly tenantRepo: TenantsRepository,
    private readonly tenants: TenantsService,
  ) {}

  /** Tenant của liên kết mới: tenant hiệu lực của request; ngoài request rơi về tenant-zero. */
  private async linkTenantId(): Promise<string> {
    return this.tenantContext.currentTenantId() ?? (await this.tenants.fallbackTenantId());
  }

  /**
   * Cả hai phía của liên kết phải là thành viên active của đúng tenant
   * cấp liên kết (TENANT-0, #168 — hồ sơ mục 6.2). Tenant-zero là không
   * gian công cộng của Trang chính: có tài khoản là đủ điều kiện như
   * mọi bề mặt platform khác.
   */
  private async assertBothMembers(tenantId: string, guardianUserId: string, studentUserId: string): Promise<void> {
    const tenant = await this.tenantRepo.getTenant(tenantId);
    if (!tenant || tenant.kind === 'platform') return;
    for (const [side, userId] of [['guardian', guardianUserId], ['student', studentUserId]] as const) {
      const membership = await this.tenantRepo.getMembership(tenantId, userId);
      if (!membership || membership.status !== 'active') {
        throw new BadRequestException({
          message: `The ${side} is not an active member of this tenant`,
          code: 'guardian.membership_required',
        });
      }
    }
  }

  /**
   * Cổng quản lý liên kết: actor phải có guardian:manage từ một gán vai
   * THẬT ở bất kỳ context nào (tiền lệ CB-1 — admin hệ thống, hoặc giáo
   * viên có vai tại khoá/lớp của con). Học sinh không có vai giảng dạy
   * thật nên không tự xác lập/sửa liên kết cho chính mình.
   */
  private async assertCanManageLinks(actorId: string): Promise<void> {
    const allowed = await this.evaluator.hasCapabilityFromRealAssignmentAnywhere(actorId, GUARDIAN_MANAGE_CAPABILITY);
    if (!allowed) {
      throw new ForbiddenException({ message: 'Missing capability guardian:manage', code: 'guardian.manage_denied' });
    }
  }

  /** Tạo liên kết giám hộ (chỉ người có guardian:manage); cặp đang có liên kết active thì 409. */
  async createLink(actorId: string, input: { guardianUserId: string; studentUserId: string; relationship: string; note?: string }): Promise<GuardianLinkRow> {
    await this.assertCanManageLinks(actorId);
    if (input.guardianUserId === input.studentUserId) {
      throw new BadRequestException({ message: 'Guardian and student must be different users', code: 'guardian.link_self' });
    }
    await this.users.getUser(input.guardianUserId);
    await this.users.getUser(input.studentUserId);
    const tenantId = await this.linkTenantId();
    await this.assertBothMembers(tenantId, input.guardianUserId, input.studentUserId);
    const existing = await this.repo.findActiveLink(input.guardianUserId, input.studentUserId);
    if (existing) {
      throw new ConflictException({ message: 'An active guardian link already exists for this pair', code: 'guardian.link_already_active' });
    }
    const link = await this.repo.insertLink({
      tenantId,
      guardianUserId: input.guardianUserId,
      studentUserId: input.studentUserId,
      relationship: input.relationship,
      status: 'active',
      createdBy: actorId,
      note: input.note ?? null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'guardian', type: 'guardian_link_created',
      payload: { actorId, userId: input.studentUserId, guardianUserId: input.guardianUserId, linkId: link.id, objectId: link.id, relationship: input.relationship },
      tenantId,
    });
    return link;
  }

  /** Liệt kê liên kết theo bộ lọc — bề mặt quản lý (guardian:manage) hoặc chính chủ xem phần liên quan tới mình. Trong request: chỉ liên kết của tenant hiệu lực. */
  async listLinks(actorId: string, filters: { guardianUserId?: string; studentUserId?: string; status?: string }): Promise<GuardianLinkRow[]> {
    const involvesSelf = filters.guardianUserId === actorId || filters.studentUserId === actorId;
    if (!involvesSelf) await this.assertCanManageLinks(actorId);
    const rows = await this.repo.listLinks(filters);
    const active = this.tenantContext.currentTenantId();
    return active ? rows.filter((l) => l.tenantId === active) : rows;
  }

  /** Thu hồi một liên kết (không xoá cứng — giữ vết cho audit); liên kết đã thu hồi hoặc thuộc tenant khác thì 404 nhất quán. */
  async revokeLink(actorId: string, linkId: string): Promise<GuardianLinkRow> {
    await this.assertCanManageLinks(actorId);
    const link = await this.repo.getLink(linkId);
    const active = this.tenantContext.currentTenantId();
    if (!link || link.status !== 'active' || (active !== undefined && link.tenantId !== active)) {
      throw new NotFoundException({ message: `Active guardian link ${linkId} not found`, code: 'guardian.link_not_found' });
    }
    await this.repo.updateLink(linkId, { status: 'revoked', revokedBy: actorId, revokedAt: new Date() });
    await this.outbox.enqueueStandalone({
      aggregate: 'guardian', type: 'guardian_link_revoked',
      payload: { actorId, userId: link.studentUserId, guardianUserId: link.guardianUserId, linkId: link.id, objectId: link.id },
    });
    return (await this.repo.getLink(linkId))!;
  }

  /** Các con đang liên kết của chính actor (bề mặt phụ huynh tự xem). */
  async myStudents(actorId: string): Promise<GuardianStudentView[]> {
    const links = await this.repo.listLinks({ guardianUserId: actorId, status: 'active' });
    const out: GuardianStudentView[] = [];
    for (const link of links) {
      const student = await this.users.getUser(link.studentUserId);
      out.push({
        link,
        student: { id: student.id, username: student.username, firstName: student.firstName, lastName: student.lastName, email: student.email },
      });
    }
    return out;
  }

  /** Những người giám hộ đang liên kết với chính actor (học sinh tự xem — minh bạch liên kết theo research mục 5.3.4). */
  async myGuardians(actorId: string): Promise<GuardianLinkRow[]> {
    return this.repo.listLinks({ studentUserId: actorId, status: 'active' });
  }

  /** Cổng liên kết cho bề mặt đọc của phụ huynh: không có liên kết active tới đúng học sinh → 403 không lộ dữ liệu. */
  private async assertActiveLink(guardianId: string, studentId: string): Promise<GuardianLinkRow> {
    const link = await this.repo.findActiveLink(guardianId, studentId);
    if (!link) {
      throw new ForbiddenException({ message: 'No active guardian link to this student', code: 'guardian.no_active_link' });
    }
    return link;
  }

  /**
   * Cổng liên kết cho bề mặt PH-1 (issue #130): không có liên kết active
   * tới đúng học sinh → 404 đồng nhất (kể cả khi học sinh không tồn tại),
   * để kẻ đoán ID không phân biệt được "không có liên kết" với "không có
   * học sinh này" — nguyên tắc cứng "chỉ con mình" của research mục 5.1.
   */
  async requireActiveLinkOr404(guardianId: string, studentId: string): Promise<GuardianLinkRow> {
    const link = await this.repo.findActiveLink(guardianId, studentId);
    if (!link) {
      throw new NotFoundException({ message: 'Student not found', code: 'guardian.student_not_found' });
    }
    return link;
  }

  /** Audit một lần phụ huynh xem dữ liệu của con (event_log qua outbox). */
  private async auditView(guardianId: string, studentId: string, courseId: string | null, surface: string): Promise<void> {
    await this.outbox.enqueueStandalone({
      aggregate: 'guardian', type: 'guardian_student_results_viewed',
      payload: { actorId: guardianId, userId: studentId, courseId, objectId: studentId, surface },
    }).catch(() => undefined);
  }

  /** Audit một lần xem trên bề mặt PH-1 (không gắn một khoá cụ thể). */
  async recordView(guardianId: string, studentId: string, surface: string): Promise<void> {
    await this.auditView(guardianId, studentId, null, surface);
  }

  /** Điểm theo từng bài (đã qua cổng công bố) của con trong một khoá — cho phụ huynh có liên kết active. */
  async studentGradebook(guardianId: string, studentId: string, courseId: string) {
    await this.assertActiveLink(guardianId, studentId);
    const activities = await this.grades.listPublishedActivityGrades(courseId, studentId);
    await this.auditView(guardianId, studentId, courseId, 'gradebook');
    return { courseId, userId: studentId, activities };
  }
}
