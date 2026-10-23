import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { sql } from 'drizzle-orm';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CoursesService } from '../courses/courses.service';
import { MessagingService } from '../messaging/messaging.service';
import { ReportsRepository, type ReportRow, type ScheduleRow } from './reports.repository';
import {
  courseCompletions, courseModulesCompletion, courseModules, enrol, gradeGrades, gradeItems, userEnrolments, users,
} from '../../db/schema';

/** Một dataSource đăng ký: read model theo entity, mỗi dòng kèm courseId để lọc quyền theo context. */
export interface ReportDatasource {
  name: string;
  columns: string[];
  fetchRows(): Promise<Record<string, unknown>[]>;
}
export const REPORT_DATASOURCES = ['enrolments', 'grades', 'completion'] as const;

/**
 * ReportsModule facade (Moodle core_reportbuilder, §2#24).
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

  listDatasources(): { name: string; columns: string[] }[] {
    return [...this.datasources.values()].map((d) => ({ name: d.name, columns: d.columns }));
  }

  private registerBuiltinDatasources(): void {
    const db = this.repo.dbHandle;
    this.datasources.set('enrolments', {
      name: 'enrolments', columns: ['userId', 'username', 'courseId', 'status'],
      fetchRows: async () => {
        const instances = await db.select().from(enrol);
        const ues = await db.select().from(userEnrolments);
        const allUsers = await db.select().from(users);
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
        const items = await db.select().from(gradeItems);
        const grades = await db.select().from(gradeGrades);
        const allUsers = await db.select().from(users);
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
        const allUsers = await db.select().from(users);
        const byUser = new Map(allUsers.map((u) => [u.id, u]));
        const courseRows = await db.select().from(courseCompletions);
        const cmRows = await db.select().from(courseModulesCompletion);
        const cms = await db.select().from(courseModules);
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
    await this.evaluator.requireCapability(actorId, 'lms/reportbuilder:manage', sys.id);
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

  async getReport(id: string): Promise<ReportRow> {
    const row = await this.repo.getReport(id);
    if (!row) throw new NotFoundException({ message: `Report ${id} not found`, code: 'report.not_found' });
    return row;
  }
  async listReports(): Promise<ReportRow[]> { return this.repo.listReports(); }

  /** Kiểm tra audience: user có trong audience trực tiếp hoặc qua role shortName tại system context. */
  async isInAudience(userId: string, report: ReportRow): Promise<boolean> {
    if (report.createdBy === userId) return true;
    if (await this.evaluator.isSiteAdmin(userId)) return true;
    const audience = await this.repo.listAudience(report.id);
    if (audience.some((a) => a.userId === userId)) return true;
    // Audience theo role: resolve bằng bảng role_assignments (role shortName).
    const roleNames = audience.filter((a) => a.role).map((a) => a.role!);
    if (!roleNames.length) return false;
    const db = this.repo.dbHandle;
    const res = (await db.execute(sql`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${userId} and r.short_name in (${sql.join(roleNames.map((n) => sql`${n}`), sql`, `)}) limit 1`)) as unknown as { rows: unknown[] };
    return res.rows.length > 0;
  }

  /**
   * Chạy báo cáo cho một viewer: audience ∩ lọc từng dòng theo quyền.
   * Một dòng course chỉ hiện nếu viewer có moodle/course:view ở course
   * context của dòng (hoặc là chính chủ dòng dữ liệu của mình cho grades/
   * enrolments/completion của bản thân — học viên xem được dòng của mình).
   */
  async runReport(viewerId: string, reportId: string): Promise<{ report: ReportRow; rows: Record<string, unknown>[] }> {
    const report = await this.getReport(reportId);
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
          allowed = (await this.evaluator.hasCapability(viewerId, 'moodle/grade:viewall', ctxId))
            || ((await this.evaluator.hasCapability(viewerId, 'moodle/course:view', ctxId)) && String(row.userId) === viewerId);
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
    const report = await this.getReport(reportId);
    const sys = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(actorId, 'lms/reportbuilder:manage', sys.id);
    return this.repo.insertSchedule({ reportId: report.id, createdBy: actorId, cron, enabled: true });
  }
  async listSchedules(): Promise<ScheduleRow[]> { return this.repo.listSchedules(); }

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
