import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { GradesService } from '../grades/grades.service';
import { VnGradebooksService } from '../grades/vn-gradebooks.service';
import { UsersService } from '../users/users.service';
import { GuardiansRepository, type GuardianLinkRow } from './guardians.repository';

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
    private readonly vn: VnGradebooksService,
    private readonly outbox: OutboxService,
  ) {}

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
    const existing = await this.repo.findActiveLink(input.guardianUserId, input.studentUserId);
    if (existing) {
      throw new ConflictException({ message: 'An active guardian link already exists for this pair', code: 'guardian.link_already_active' });
    }
    const link = await this.repo.insertLink({
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
    });
    return link;
  }

  /** Liệt kê liên kết theo bộ lọc — bề mặt quản lý (guardian:manage) hoặc chính chủ xem phần liên quan tới mình. */
  async listLinks(actorId: string, filters: { guardianUserId?: string; studentUserId?: string; status?: string }): Promise<GuardianLinkRow[]> {
    const involvesSelf = filters.guardianUserId === actorId || filters.studentUserId === actorId;
    if (!involvesSelf) await this.assertCanManageLinks(actorId);
    return this.repo.listLinks(filters);
  }

  /** Thu hồi một liên kết (không xoá cứng — giữ vết cho audit); liên kết đã thu hồi thì 404 nhất quán. */
  async revokeLink(actorId: string, linkId: string): Promise<GuardianLinkRow> {
    await this.assertCanManageLinks(actorId);
    const link = await this.repo.getLink(linkId);
    if (!link || link.status !== 'active') {
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

  /** Audit một lần phụ huynh xem dữ liệu của con (event_log qua outbox). */
  private async auditView(guardianId: string, studentId: string, courseId: string, surface: string): Promise<void> {
    await this.outbox.enqueueStandalone({
      aggregate: 'guardian', type: 'guardian_student_results_viewed',
      payload: { actorId: guardianId, userId: studentId, courseId, objectId: studentId, surface },
    }).catch(() => undefined);
  }

  /** Sổ điểm (đã qua cổng công bố) của con trong một khoá — cho phụ huynh có liên kết active. */
  async studentGradebook(guardianId: string, studentId: string, courseId: string) {
    await this.assertActiveLink(guardianId, studentId);
    const view = await this.grades.getGradebookForGuardian(courseId, studentId);
    await this.auditView(guardianId, studentId, courseId, 'gradebook');
    return view;
  }

  /** Kết quả học kì VN (đã công bố) của con trong một sổ — cho phụ huynh có liên kết active. */
  async studentVnTermResult(guardianId: string, studentId: string, courseId: string, bookId: string) {
    await this.assertActiveLink(guardianId, studentId);
    const book = await this.vn.getBook(bookId);
    if (book.courseId !== courseId) {
      throw new BadRequestException({ message: 'VN gradebook belongs to another course', code: 'grades.vn_book_course_mismatch' });
    }
    const computation = await this.vn.computeTermResultForGuardian(bookId, studentId);
    await this.auditView(guardianId, studentId, book.courseId, 'vn_term_result');
    return computation;
  }
}
