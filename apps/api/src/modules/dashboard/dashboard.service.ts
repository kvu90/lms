import { ForbiddenException, Injectable } from '@nestjs/common';
import type {
  CourseCardPrefView,
  DashboardGradingQueueView,
  DashboardNewResultView,
  DashboardOverviewView,
} from '@lms/contracts';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { GradesService } from '../grades/grades.service';
import { DashboardRepository } from '@lms/db/repositories/dashboard';

/** Giới hạn tổng số việc đến hạn trả về trong khối tổng hợp (chống phình ở khoá cũ nhiều hoạt động quá hạn). */
const DUE_ITEMS_LIMIT = 100;

/**
 * Dashboard việc cần làm (DASH1, issue #121): tổng hợp MỘT lần cho cả khối
 * đầu dashboard. Ba nguyên tắc cứng:
 * - Chỉ tính khoá người dùng thuộc về: ghi danh hiệu lực (học sinh) và khoá
 *   có `grade:viewall` tại context khoá (đội giảng dạy — cùng định nghĩa
 *   `teaching` mà web dùng ở MyAccessView).
 * - Điểm/phản hồi mới CHỈ từ dữ liệu đã công bố: trạng thái công bố lấy từ
 *   GradesService.publicationStatesForCourse (PH-0) — item manual chưa
 *   công bố bị loại khỏi payload hoàn toàn, không để lại dấu hiệu tồn tại.
 * - Mốc xem trước lưu phía server (user_dashboard_state), không suy từ
 *   trạng thái đã đọc của thông báo.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly repo: DashboardRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly grades: GradesService,
  ) {}

  /** Khoá user thuộc đội giảng dạy: ứng viên = ghi danh ∪ gán vai tại context khoá, lọc bằng grade:viewall thật. */
  private async teachingCourseIds(userId: string, enrolled: string[], assigned: string[]): Promise<string[]> {
    const candidates = [...new Set([...enrolled, ...assigned])];
    const teaching: string[] = [];
    for (const courseId of candidates) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, courseId);
      if (!ctx) continue;
      if (await this.evaluator.hasCapability(userId, 'grade:viewall', ctx.id)) teaching.push(courseId);
    }
    return teaching;
  }

  /**
   * Khoá một người dùng đang ghi danh hiệu lực kèm tên hiển thị — điểm vào
   * dùng chung cho dashboard của chính chủ và bề mặt phụ huynh (PH-1 đọc
   * dữ liệu của CON qua đúng tập khoá ghi danh này).
   */
  async enrolledCoursesFor(userId: string): Promise<{ courseIds: string[]; names: Map<string, string> }> {
    const courseIds = await this.repo.enrolledCourseIds(userId, new Date());
    const names = await this.repo.courseNames(courseIds);
    return { courseIds, names };
  }

  /**
   * Kết quả ĐÃ CÔNG BỐ mới của một học sinh kể từ mốc `since` — cùng cổng
   * công bố PH-0 và cùng quy tắc thời điểm hiệu lực (max của lần sửa điểm
   * và lần công bố) như khối "mới" của dashboard học sinh. Bề mặt phụ
   * huynh (PH-1) dùng lại nguyên hàm này với mốc xem của phụ huynh để hai
   * bề mặt không bao giờ lệch nhau về điều kiện hiển thị.
   */
  async publishedNewResultsFor(userId: string, since: Date): Promise<DashboardNewResultView[]> {
    const { courseIds, names } = await this.enrolledCoursesFor(userId);
    return this.buildNewResults(userId, courseIds, names, since);
  }

  /** Toàn bộ khối đầu dashboard cho người gọi. */
  async getOverview(userId: string, days: number): Promise<DashboardOverviewView> {
    const now = new Date();
    const state = await this.repo.getState(userId);
    const previousSeenAt = state?.lastSeenAt ?? null;
    // Lần đầu chưa có mốc: không có gì tính là "mới" (since = now), tránh
    // dội toàn bộ điểm cũ thành điểm mới ở lần mở dashboard đầu tiên.
    const since = previousSeenAt ?? now;

    const enrolled = await this.repo.enrolledCourseIds(userId, now);
    const assigned = await this.repo.roleAssignedCourseIds(userId);
    const teaching = await this.teachingCourseIds(userId, enrolled, assigned);
    const names = await this.repo.courseNames([...new Set([...enrolled, ...teaching])]);

    const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const dueItems = await this.buildDueItems(userId, enrolled, names, until, now);
    const newResults = previousSeenAt
      ? await this.buildNewResults(userId, enrolled, names, since)
      : [];
    const gradingQueue = await this.buildGradingQueue(teaching, names);

    // Mốc chỉ cập nhật SAU khi đã tính xong danh sách mới của lần xem này.
    await this.repo.touchState(userId, now);

    return {
      generatedAt: now.toISOString(),
      previousSeenAt: previousSeenAt?.toISOString() ?? null,
      dueItems,
      newResults,
      gradingQueue,
    };
  }

  /** Việc sắp đến hạn (quiz + bài nộp C2) của học sinh: đã nộp thì biến mất, quá hạn tách lên đầu. */
  private async buildDueItems(
    userId: string,
    enrolled: string[],
    names: Map<string, string>,
    until: Date,
    now: Date,
  ): Promise<DashboardOverviewView['dueItems']> {
    const items: DashboardOverviewView['dueItems'] = [];

    const quizRows = await this.repo.quizDueRows(enrolled, userId, until);
    const quizByCm = new Map<string, { courseId: string; activityId: string; name: string; dueAt: Date; states: (string | null)[] }>();
    for (const row of quizRows) {
      const entry = quizByCm.get(row.cmId) ?? { courseId: row.courseId, activityId: row.activityId!, name: row.name, dueAt: row.dueAt!, states: [] };
      entry.states.push(row.attemptState);
      quizByCm.set(row.cmId, entry);
    }
    for (const [cmId, entry] of quizByCm) {
      // Đã nộp xong (finished) hoặc đã nộp chờ chấm tay (needsgrading) = đã nộp → biến mất.
      if (entry.states.some((s) => s === 'finished' || s === 'needsgrading')) continue;
      const inProgress = entry.states.some((s) => s === 'inprogress');
      items.push({
        courseId: entry.courseId,
        courseName: names.get(entry.courseId) ?? '',
        cmId,
        activityId: entry.activityId,
        kind: 'quiz',
        name: entry.name,
        dueAt: entry.dueAt.toISOString(),
        status: entry.dueAt < now ? 'overdue' : inProgress ? 'in_progress' : 'not_started',
      });
    }

    const assignRows = await this.repo.assignmentDueRows(enrolled, userId, until);
    for (const row of assignRows) {
      if (row.submissionStatus === 'submitted') continue; // đã nộp → biến mất
      items.push({
        courseId: row.courseId,
        courseName: names.get(row.courseId) ?? '',
        cmId: row.cmId,
        activityId: row.activityId!,
        kind: 'assignment',
        name: row.name,
        dueAt: row.dueAt!.toISOString(),
        status: row.dueAt! < now ? 'overdue' : row.submissionStatus === 'draft' ? 'in_progress' : 'not_started',
      });
    }

    // Quá hạn lên trước (quá hạn lâu nhất đầu tiên), sau đó hạn gần nhất trước.
    items.sort((a, b) => {
      const groupA = a.status === 'overdue' ? 0 : 1;
      const groupB = b.status === 'overdue' ? 0 : 1;
      if (groupA !== groupB) return groupA - groupB;
      return a.dueAt.localeCompare(b.dueAt);
    });
    return items.slice(0, DUE_ITEMS_LIMIT);
  }

  /** Điểm/phản hồi mới + kết quả VN mới — chỉ dữ liệu ĐÃ CÔNG BỐ. */
  private async buildNewResults(
    userId: string,
    enrolled: string[],
    names: Map<string, string>,
    since: Date,
  ): Promise<DashboardNewResultView[]> {
    const results: DashboardNewResultView[] = [];

    // Vết công bố theo item: vết mới nhất quyết định hiệu lực hiện tại và,
    // với item manual, thời điểm điểm TRỞ NÊN hiển thị.
    const itemPubs = await this.repo.itemPublications(enrolled);
    const latestPubByItem = new Map<string, (typeof itemPubs)[number]>();
    for (const p of itemPubs) {
      if (p.itemId) latestPubByItem.set(p.itemId, p); // rows tăng dần theo createdAt → cuối là mới nhất
    }
    // Ứng viên từ công bố: item có vết publish hiệu lực nằm sau mốc.
    const publishedAfterSince = new Set<string>();
    for (const [itemId, p] of latestPubByItem) {
      if (p.action === 'publish' && p.createdAt > since) publishedAfterSince.add(itemId);
    }

    type GradeRow = Awaited<ReturnType<DashboardRepository['gradeRowsSince']>>[number];
    const candidateByGradeId = new Map<string, GradeRow>();
    for (const row of await this.repo.gradeRowsSince(enrolled, userId, since)) {
      candidateByGradeId.set(row.gradeId, row);
    }
    for (const row of await this.repo.gradeRowsForItems([...publishedAfterSince], userId)) {
      candidateByGradeId.set(row.gradeId, row);
    }

    const rowsByCourse = new Map<string, GradeRow[]>();
    for (const row of candidateByGradeId.values()) {
      if (row.itemType !== 'mod' && row.itemType !== 'manual') continue; // chỉ item lá, bỏ total/category
      const list = rowsByCourse.get(row.courseId) ?? [];
      list.push(row);
      rowsByCourse.set(row.courseId, list);
    }
    for (const [courseId, rows] of rowsByCourse) {
      const states = await this.grades.publicationStatesForCourse(courseId);
      for (const row of rows) {
        // Cổng công bố PH-0: chưa công bố thì loại hoàn toàn khỏi payload.
        if (!(states.get(row.itemId)?.published ?? true)) continue;
        // Thời điểm hiệu lực: item manual lấy mốc công bố nếu công bố
        // muộn hơn lần sửa điểm (điểm chấm trước, công bố sau vẫn là mới
        // tại thời điểm công bố).
        const pub = latestPubByItem.get(row.itemId);
        const effectiveAt = pub && pub.action === 'publish' && pub.createdAt > row.updatedAt
          ? pub.createdAt
          : row.updatedAt;
        if (effectiveAt <= since) continue;
        results.push({
          courseId,
          courseName: names.get(courseId) ?? '',
          kind: 'grade_item',
          itemId: row.itemId,
          itemName: row.itemName,
          finalGrade: row.finalGrade,
          gradeMax: row.gradeMax,
          feedback: row.feedback,
          changedAt: effectiveAt.toISOString(),
        });
      }
    }

    results.sort((a, b) => a.changedAt.localeCompare(b.changedAt));
    return results;
  }

  /**
   * Hàng đợi chấm gộp theo khoá cho giáo viên: bài C2 chưa trả bài cho
   * attempt hiện tại + lượt quiz chờ chấm tay + phiếu giấy CAM-0 chờ xử
   * lý (needs_review/needs_identity, issue #187). Ba loại đếm TÁCH BẠCH
   * ở ba trường *Pending; pendingCount là tổng cả ba.
   */
  private async buildGradingQueue(
    teaching: string[],
    names: Map<string, string>,
  ): Promise<DashboardGradingQueueView[]> {
    if (!teaching.length) return [];
    const byCourse = new Map<string, DashboardGradingQueueView & { oldest: Date | null; paperOldest: Date | null }>();
    const entryFor = (courseId: string) => {
      const entry = byCourse.get(courseId) ?? {
        courseId,
        courseName: names.get(courseId) ?? '',
        pendingCount: 0,
        assignmentPending: 0,
        quizPending: 0,
        paperPending: 0,
        paperPinId: null,
        oldestPendingAt: null,
        oldest: null,
        paperOldest: null,
      };
      byCourse.set(courseId, entry);
      return entry;
    };

    for (const row of await this.repo.assignmentPendingRows(teaching)) {
      // Đã có gói chấm RELEASED cho đúng attempt hiện tại thì không còn chờ.
      if (row.gradeStatus === 'released') continue;
      const entry = entryFor(row.courseId);
      entry.assignmentPending += 1;
      entry.pendingCount += 1;
      if (row.submittedAt && (!entry.oldest || row.submittedAt < entry.oldest)) entry.oldest = row.submittedAt;
    }
    for (const row of await this.repo.quizPendingRows(teaching)) {
      const entry = entryFor(row.courseId);
      entry.quizPending += 1;
      entry.pendingCount += 1;
      const at = row.timeFinish ?? row.timeStart;
      if (!entry.oldest || at < entry.oldest) entry.oldest = at;
    }
    for (const row of await this.repo.paperPendingRows(teaching)) {
      const entry = entryFor(row.courseId);
      entry.paperPending += 1;
      entry.pendingCount += 1;
      if (!entry.oldest || row.createdAt < entry.oldest) entry.oldest = row.createdAt;
      // Đích deep-link = quiz có phiếu chờ lâu nhất của khoá.
      if (!entry.paperOldest || row.createdAt < entry.paperOldest) {
        entry.paperOldest = row.createdAt;
        entry.paperPinId = row.pinId;
      }
    }

    return [...byCourse.values()]
      .filter((e) => e.pendingCount > 0)
      .map((e) => ({
        courseId: e.courseId,
        courseName: e.courseName,
        pendingCount: e.pendingCount,
        assignmentPending: e.assignmentPending,
        quizPending: e.quizPending,
        paperPending: e.paperPending,
        paperPinId: e.paperPinId,
        oldestPendingAt: e.oldest?.toISOString() ?? null,
      }))
      .sort((a, b) => (a.oldestPendingAt ?? '').localeCompare(b.oldestPendingAt ?? ''));
  }

  /** Pref thẻ khoá của chính người dùng. */
  async listCourseCards(userId: string): Promise<CourseCardPrefView[]> {
    const rows = await this.repo.listPrefs(userId);
    return rows.map((r) => ({
      courseId: r.courseId,
      color: (r.color as CourseCardPrefView['color']) ?? null,
      nickname: r.nickname,
    }));
  }

  /** Đặt/xoá màu + biệt danh thẻ khoá của chính người dùng cho một khoá họ thuộc về. */
  async upsertCourseCard(
    userId: string,
    courseId: string,
    input: { color?: string | null; nickname?: string | null },
  ): Promise<CourseCardPrefView> {
    await this.assertBelongsToCourse(userId, courseId);
    const color = input.color ?? null;
    const nickname = input.nickname?.trim() ? input.nickname.trim() : null;
    if (color === null && nickname === null) {
      await this.repo.deletePref(userId, courseId);
      return { courseId, color: null, nickname: null };
    }
    const row = await this.repo.upsertPref(userId, courseId, color, nickname);
    return {
      courseId: row.courseId,
      color: (row.color as CourseCardPrefView['color']) ?? null,
      nickname: row.nickname,
    };
  }

  /** Người dùng chỉ đặt được pref cho khoá mình thuộc về (ghi danh hoặc đội giảng dạy). */
  private async assertBelongsToCourse(userId: string, courseId: string): Promise<void> {
    const now = new Date();
    const enrolled = await this.repo.enrolledCourseIds(userId, now);
    if (enrolled.includes(courseId)) return;
    const assigned = await this.repo.roleAssignedCourseIds(userId);
    if (assigned.includes(courseId)) {
      const ctx = await this.contexts.getByLevelInstance(CONTEXT_LEVELS.COURSE, courseId);
      if (ctx && await this.evaluator.hasCapability(userId, 'grade:viewall', ctx.id)) return;
    }
    throw new ForbiddenException({
      message: 'User does not belong to this course',
      code: 'dashboard.course_not_accessible',
    });
  }
}
