import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { ReportsRepository, type ReportRow, type ScheduleRow } from '@lms/db/repositories/reports';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CoursesService } from '../courses/courses.service';
import { MessagingService } from '../messaging/messaging.service';

/** Một dataSource đăng ký: read model theo entity, mỗi dòng kèm courseId để lọc quyền theo context. */
export interface ReportDatasource {
  name: string;
  columns: string[];
  fetchRows(): Promise<Record<string, unknown>[]>;
}
export const REPORT_DATASOURCES = ['enrolments', 'grades', 'completion'] as const;

/**
 * Facade của ReportsModule (Moodle core_reportbuilder, §2#24).
 * Bất biến: quyền xem = audience ∩ quyền trên TỪNG DÒNG theo context của
 * dòng đó. Filter do user cấu hình KHÔNG BAO GIỜ nới quyền — filter chỉ
 * thu hẹp tập dòng đã được phép. Báo cáo theo lịch chạy dưới danh tính
 * người tạo với quyền TẠI THỜI ĐIỂM CHẠY.
 */
@Injectable()
export class ReportsService {
  private readonly datasources = new Map<string, ReportDatasource>();

  constructor(
    private readonly repo: ReportsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
    private readonly messaging: MessagingService,
    private readonly i18n: I18nService,
  ) {
    this.registerBuiltinDatasources();
  }

  /**
   * Cổng metadata báo cáo (H15, rà soát #134 + §7.3): định nghĩa báo cáo,
   * datasource và lịch chạy là thông tin vận hành nội bộ — mọi đường đọc
   * metadata và đường kích hoạt chạy theo lịch đều đòi
   * `reportbuilder:manage` tại system, cùng cổng với createReport/
   * createSchedule. Dữ liệu báo cáo vẫn gác riêng theo audience + từng
   * dòng ở runReport, không đổi.
   */
  private async requireManage(actorId: string): Promise<void> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'reportbuilder:manage', sys.id);
  }

  async listDatasources(actorId: string): Promise<{ name: string; columns: string[] }[]> {
    await this.requireManage(actorId);
    return [...this.datasources.values()].map((d) => ({ name: d.name, columns: d.columns }));
  }

  private registerBuiltinDatasources(): void {
    const db = this.repo.dbHandle;
    this.datasources.set('enrolments', {
      name: 'enrolments', columns: ['userId', 'username', 'courseId', 'status'],
      fetchRows: async () => {
        const instances = await db.selectFrom('enrol').select(['id', 'course_id as courseId']).execute();
        const ues = await db.selectFrom('user_enrolments').select(['user_id as userId', 'enrol_id as enrolId', 'status']).execute();
        const allUsers = await db.selectFrom('users').select(['id', 'username']).execute();
        const byInstance = new Map(instances.map((i) => [i.id, i]));
        const byUser = new Map(allUsers.map((u) => [u.id, u]));
        return ues.map((ue) => ({
          userId: ue.userId, username: byUser.get(ue.userId)?.username ?? '',
          courseId: byInstance.get(ue.enrolId)?.courseId ?? 0, status: ue.status,
        }));
      },
    });
    this.datasources.set('grades', {
      name: 'grades', columns: ['userId', 'username', 'courseId', 'itemId', 'finalGrade'],
      fetchRows: async () => {
        const items = await db.selectFrom('grade_items').select(['id', 'course_id as courseId']).execute();
        const grades = await db.selectFrom('grade_grades').select(['user_id as userId', 'item_id as itemId', 'final_grade as finalGrade']).execute();
        const allUsers = await db.selectFrom('users').select(['id', 'username']).execute();
        const byItem = new Map(items.map((i) => [i.id, i]));
        const byUser = new Map(allUsers.map((u) => [u.id, u]));
        return grades.map((g) => ({
          userId: g.userId, username: byUser.get(g.userId)?.username ?? '',
          courseId: byItem.get(g.itemId)?.courseId ?? 0, itemId: g.itemId, finalGrade: g.finalGrade,
        }));
      },
    });
    this.datasources.set('completion', {
      name: 'completion', columns: ['userId', 'username', 'courseId', 'status', 'cmId', 'completionState'],
      fetchRows: async () => {
        const allUsers = await db.selectFrom('users').select(['id', 'username']).execute();
        const byUser = new Map(allUsers.map((u) => [u.id, u]));
        const courseRows = await db.selectFrom('course_completions').select(['user_id as userId', 'course', 'status']).execute();
        const cmRows = await db.selectFrom('course_modules_completion').select(['user_id as userId', 'course_module_id as courseModuleId', 'completion_state as completionState']).execute();
        const cms = await db.selectFrom('course_modules').select(['id', 'course']).execute();
        const byCm = new Map(cms.map((c) => [c.id, c]));
        return [
          ...courseRows.map((r) => ({ userId: r.userId, username: byUser.get(r.userId)?.username ?? '', courseId: r.course, status: r.status, cmId: 0, completionState: -1 })),
          ...cmRows.map((r) => ({ userId: r.userId, username: byUser.get(r.userId)?.username ?? '', courseId: byCm.get(r.courseModuleId)?.course ?? 0, status: '', cmId: r.courseModuleId, completionState: r.completionState })),
        ];
      },
    });
  }

  async createReport(actorId: string, input: {
    name: string; dataSource: string; columns?: string[]; filters?: Record<string, unknown>;
    audienceUserIds?: string[]; audienceRoles?: string[];
  }): Promise<ReportRow> {
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'reportbuilder:manage', sys.id);
    const ds = this.datasources.get(input.dataSource);
    if (!ds) throw new BadRequestException({ message: `Unknown dataSource ${input.dataSource}`, code: 'report.unknown_datasource' });
    const columns = input.columns?.length ? input.columns : ds.columns;
    for (const c of columns) if (!ds.columns.includes(c)) throw new BadRequestException({ message: `Unknown column ${c}`, code: 'report.unknown_column' });
    const report = await this.repo.insertReport({
      name: input.name, dataSource: input.dataSource, columns, filters: input.filters ?? {}, createdBy: actorId, contextId: sys.id,
    });
    for (const uid of input.audienceUserIds ?? []) await this.repo.insertAudience({ reportId: report.id, userId: uid });
    for (const role of input.audienceRoles ?? []) await this.repo.insertAudience({ reportId: report.id, role });
    // Người tạo luôn thuộc audience của báo cáo của mình.
    if (!(input.audienceUserIds ?? []).includes(actorId)) await this.repo.insertAudience({ reportId: report.id, userId: actorId });
    return report;
  }

  /** Đọc thô một report theo id — đường nội bộ (runReport/createSchedule/worker), không gác tại đây. */
  private async getReportRow(id: string): Promise<ReportRow> {
    const row = await this.repo.getReport(id);
    if (!row) throw new NotFoundException({ message: `Report ${id} not found`, code: 'report.not_found' });
    return row;
  }
  /** Chi tiết report qua HTTP: qua cổng metadata (H15). */
  async getReport(actorId: string, id: string): Promise<ReportRow> {
    await this.requireManage(actorId);
    return this.getReportRow(id);
  }
  async listReports(actorId: string): Promise<ReportRow[]> {
    await this.requireManage(actorId);
    return this.repo.listReports();
  }

  /** Kiểm tra audience: user có trong audience trực tiếp hoặc qua role shortName tại system context. */
  async isInAudience(userId: string, report: ReportRow): Promise<boolean> {
    if (report.createdBy === userId) return true;
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const audience = await this.repo.listAudience(report.id);
    if (audience.some((a) => a.userId === userId)) return true;
    // Audience theo role: resolve bằng bảng role_assignments (role shortName).
    const roleNames = audience.filter((a) => a.role).map((a) => a.role!);
    if (!roleNames.length) return false;
    // Truy vấn ghép danh sách tên vai trò bằng sql.join nằm ở
    // repository (khuôn T-11 chốt tại issue #648).
    return this.repo.userHasAnyRole(userId, roleNames);
  }

  /**
   * Chạy báo cáo cho một viewer: audience ∩ lọc từng dòng theo quyền.
   * Một dòng course chỉ hiện nếu viewer có course:view ở course
   * context của dòng (hoặc là chính chủ dòng dữ liệu của mình cho grades/
   * enrolments/completion của bản thân — học viên xem được dòng của mình).
   */
  async runReport(viewerId: string, reportId: string): Promise<{ report: ReportRow; rows: Record<string, unknown>[] }> {
    const report = await this.getReportRow(reportId);
    if (!(await this.isInAudience(viewerId, report))) {
      throw new ForbiddenException({ message: 'You are not in the audience of this report', code: 'report.not_in_audience' });
    }
    const ds = this.datasources.get(report.dataSource);
    if (!ds) throw new BadRequestException({ message: 'Datasource no longer registered', code: 'report.datasource_missing' });
    const allRows = await ds.fetchRows();
    const filters = (report.filters ?? {}) as Record<string, unknown>;
    // Filter cấu hình chỉ thu hẹp: áp dụng TRƯỚC lọc quyền cũng không đổi kết quả quyền.
    const filtered = allRows.filter((row) => Object.entries(filters).every(([k, v]) => v === undefined || v === null || row[k] === v));
    const columns = (report.columns as string[]) ?? ds.columns;
    const out: Record<string, unknown>[] = [];
    const ctxCache = new Map<string, string>();
    for (const row of filtered) {
      const courseId = String(row.courseId ?? '');
      let allowed = false;
      if (courseId) {
        if (!ctxCache.has(courseId)) {
          try { ctxCache.set(courseId, await this.courses.courseContextId(courseId)); } catch { ctxCache.set(courseId, ''); }
        }
        const ctxId = ctxCache.get(courseId)!;
        if (ctxId) {
          // Staff có grade:viewall thấy mọi dòng của course; người thường chỉ thấy dòng của chính mình trong course họ được xem.
          allowed = (await this.evaluator.hasCapability(viewerId, 'grade:viewall', ctxId))
            || ((await this.evaluator.hasCapability(viewerId, 'course:view', ctxId)) && String(row.userId) === viewerId);
        }
      } else {
        allowed = String(row.userId) === viewerId;
      }
      if (!allowed) continue;
      const projected: Record<string, unknown> = {};
      for (const c of columns) projected[c] = row[c];
      // Giữ courseId/userId để client và test đối chiếu, kể cả khi không nằm trong columns đã chọn.
      projected.courseId = row.courseId; projected.userId = row.userId;
      out.push(projected);
    }
    return { report, rows: out };
  }

  async createSchedule(actorId: string, reportId: string, cron = 'daily'): Promise<ScheduleRow> {
    const report = await this.getReportRow(reportId);
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'reportbuilder:manage', sys.id);
    return this.repo.insertSchedule({ reportId: report.id, createdBy: actorId, cron, enabled: true });
  }
  async listSchedules(actorId: string): Promise<ScheduleRow[]> {
    await this.requireManage(actorId);
    return this.repo.listSchedules();
  }
  /** Kích hoạt chạy một schedule qua HTTP: qua cổng metadata (H15) rồi chạy bằng engine nội bộ. */
  async triggerSchedule(actorId: string, scheduleId: string): Promise<{ scheduleId: string; rows: number }> {
    await this.requireManage(actorId);
    return this.runSchedule(scheduleId);
  }

  /**
   * Chạy một schedule: chạy báo cáo DƯỚI DANH TÍNH NGƯỜI TẠO với quyền tại
   * thời điểm chạy, lưu kết quả vào schedule, và gửi notification qua
   * MessagingModule cho người tạo.
   */
  async runSchedule(scheduleId: string): Promise<{ scheduleId: string; rows: number }> {
    const schedule = await this.repo.getSchedule(scheduleId);
    if (!schedule) throw new NotFoundException({ message: `Schedule ${scheduleId} not found`, code: 'report.schedule_not_found' });
    let rowCount = 0;
    try {
      const { rows } = await this.runReport(schedule.createdBy, schedule.reportId);
      rowCount = rows.length;
      await this.repo.updateSchedule(scheduleId, { lastRun: new Date(), lastResult: { rows: rowCount, ranAs: schedule.createdBy } });
    } catch {
      await this.repo.updateSchedule(scheduleId, { lastRun: new Date(), lastResult: { rows: 0, ranAs: schedule.createdBy, error: 'forbidden_at_run_time' } });
    }
    await this.messaging.notify(schedule.createdBy, 'report_scheduled', {
      subject: this.i18n.t('platform.reportFinishedSubject'), body: this.i18n.t('platform.reportFinishedBody', { args: { reportId: schedule.reportId, rows: rowCount } }), contextUrl: `/reports/${schedule.reportId}`,
    }).catch(() => undefined);
    return { scheduleId, rows: rowCount };
  }
  async runAllSchedules(): Promise<{ ran: number }> {
    const schedules = await this.repo.listSchedules();
    let ran = 0;
    for (const s of schedules) if (s.enabled) { await this.runSchedule(s.id); ran++; }
    return { ran };
  }
}
