import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { adjustedGrade } from '@lms/grades';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { UsersService } from '../users/users.service';
import { renderVneduWorkbook, type VneduExportItem, type VneduExportModel } from './domain/vnedu-export';
import type { ExportGradesVneduDto } from './dto/grades.dto';
import { GradesRepository, type GradeRow, type ItemRow } from './grades.repository';

export const COMPLETION_PASS = 2;
export const COMPLETION_FAIL = 3;
export const COMPLETION_DONE = 1;

/** Trạng thái công bố của một item (PH-0, issue #116): policy neo trên item; published = điểm đang hiện phía học sinh. */
export interface GradePublicationState {
  policy: 'auto' | 'manual';
  published: boolean;
}

/** Một dòng điểm theo bài trong lưới xem: item (bài) + điểm của user (null khi chưa có hoặc đang bị cổng công bố che) + trạng thái công bố. */
export interface ActivityGradeView {
  item: ItemRow;
  grade: GradeRow | null;
  publication: GradePublicationState;
}

/**
 * GradesModule facade — ĐIỂM THEO TỪNG BÀI (quyết định Lão gia 23:49
 * ngày 25/10/2026, issue #224). Nguồn sự thật duy nhất của điểm là điểm
 * của từng hoạt động: quiz attempt ghi qua recordActivityGrade, bài tập
 * chấm theo bài, GV nhập/sửa điểm của một bài qua setGrade/updateGrade.
 * Mọi phép tính số học nằm ở engine thuần @lms/grades (adjustedGrade).
 *
 * ĐÃ GỠ HẲN ở #224: gradebook tổng hợp theo khoá (categories/letters/
 * scales/outcomes, điểm tổng khoá, regrade, export/import CSV) và Sổ
 * điểm VN (vn-books TT 22/27). Không còn khái niệm điểm của khoá học.
 *
 * Wiring (registry/facade only, no cross-module repositories):
 *  - registers a grade-percentage provider into CoursesService so the
 *    Availability 'grade' leaf evaluates against REAL per-activity grades;
 *  - registers grade evaluators into CompletionService so
 *    completionUseGrade evaluates against the activity's own grade;
 *  - after a grade change it refreshes completion for the user.
 */
@Injectable()
export class GradesService implements OnModuleInit {
  constructor(
    private readonly repo: GradesRepository,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
    private readonly evaluator: PermissionEvaluator,
    private readonly completion: CompletionService,
    private readonly outbox: OutboxService,
    private readonly users: UsersService,
  ) {}

  /**
   * Khởi tạo: đăng ký grade provider cho availability/completion.
   */
  onModuleInit(): void {
    this.courses.registerGradeProvider(async (userId, courseId) => this.gradePercentagesForUser(userId, courseId));
    this.completion.registerGradeEvaluator(async (cmId, userId) => this.evaluateCmGrade(cmId, userId));
    this.completion.registerCourseGradeChecker(async (courseId, userId) => this.courseGradePassed(courseId, userId));
    this.enrol.registerRelatedDataProbe(async (courseId, userId) => {
      const grades = await this.repo.listGradesForCourse(courseId, userId);
      return grades.length > 0;
    });
  }

  private async requireCap(actorId: string, capability: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, capability, await this.courses.courseContextId(courseId));
  }

  // --- items ---------------------------------------------------------------

  /**
   * Tạo grade item: 'manual' (điểm nhập tay của một bài/đợt riêng) hoặc
   * 'mod' (gắn một course module — đường quiz/assignment tự gọi khi tạo
   * hoạt động). Mỗi cm chỉ có tối đa một item 'mod'.
   */
  async createItem(actorId: string, courseId: string, input: {
    itemName: string; itemType?: string; cmId?: string;
    gradeMax?: number; gradeMin?: number; gradePass?: number; hidden?: boolean;
    multiplicator?: number; plusFactor?: number;
  }): Promise<ItemRow> {
    await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:manage', courseId);
    const itemType = input.itemType ?? 'manual';
    if (!['manual', 'mod'].includes(itemType)) {
      throw new BadRequestException({ message: `grade item type ${itemType} is created by the system`, code: 'grades.bad_itemtype' });
    }
    if (itemType === 'mod' && !input.cmId) {
      throw new BadRequestException({ message: 'A mod item requires cmId', code: 'grades.cm_required' });
    }
    let itemModule: string | null = null;
    if (itemType === 'mod') {
      const cm = await this.courses.getCm(input.cmId!);
      if (cm.course !== courseId) throw new BadRequestException({ message: 'cm belongs to another course', code: 'grades.cm_course_mismatch' });
      itemModule = cm.component;
      const existing = await this.repo.findItemForCm(courseId, input.cmId!);
      if (existing) throw new BadRequestException({ message: 'This activity already has a grade item', code: 'grades.item_exists_for_cm' });
    }
    const gradeMin = input.gradeMin ?? 0;
    const gradeMax = input.gradeMax ?? 100;
    if (gradeMax <= gradeMin) throw new BadRequestException({ message: 'gradeMax must be greater than gradeMin', code: 'grades.bad_range' });
    const item = await this.repo.insertItem({
      courseId: courseId, itemName: input.itemName, itemType,
      itemModule, itemInstance: itemType === 'mod' ? input.cmId! : null,
      gradeMax, gradeMin, gradePass: input.gradePass ?? 0,
      multiplicator: input.multiplicator ?? 1, plusFactor: input.plusFactor ?? 0,
      hidden: input.hidden ?? false,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_item_created', payload: { courseId, itemId: item.id } });
    return item;
  }

  /**
   * Lấy item; ném grades.item_not_found khi vắng.
   */
  async getItem(id: string): Promise<ItemRow> {
    const row = await this.repo.getItem(id);
    if (!row) throw new NotFoundException({ message: `Grade item ${id} not found`, code: 'grades.item_not_found' });
    return row;
  }
  /**
   * Item của khoá học.
   */
  async listItems(actorId: string, courseId: string): Promise<ItemRow[]> {
    await this.courses.assertCourseAccess(actorId, courseId);
    return this.repo.listItems(courseId);
  }

  /**
   * Cập nhật item (tên/thang điểm/ngưỡng đạt/ẩn/khoá) — đường
   * quiz/assignment gọi khi hoạt động đổi tên hoặc thang điểm.
   */
  async updateItem(actorId: string, itemId: string, input: {
    itemName?: string; gradeMax?: number; gradeMin?: number; gradePass?: number;
    hidden?: boolean; locked?: boolean; multiplicator?: number; plusFactor?: number;
  }): Promise<ItemRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:manage', item.courseId);
    const patch: Partial<ItemRow> = {};
    if (input.itemName !== undefined) patch.itemName = input.itemName;
    if (input.gradeMax !== undefined) patch.gradeMax = input.gradeMax;
    if (input.gradeMin !== undefined) patch.gradeMin = input.gradeMin;
    if (input.gradePass !== undefined) patch.gradePass = input.gradePass;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (input.locked !== undefined) patch.locked = input.locked;
    if (input.multiplicator !== undefined) patch.multiplicator = input.multiplicator;
    if (input.plusFactor !== undefined) patch.plusFactor = input.plusFactor;
    if (Object.keys(patch).length) await this.repo.updateItem(itemId, patch);
    await this.outbox.enqueueStandalone({ aggregate: 'grades', type: 'grade_item_updated', payload: { courseId: item.courseId, itemId } });
    return this.getItem(itemId);
  }

  /**
   * Xoá item và điểm của nó.
   */
  async deleteItem(actorId: string, itemId: string): Promise<void> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:manage', item.courseId);
    await this.repo.deleteItem(itemId);
  }

  // --- entering grades -------------------------------------------------------

  /** Leaf final grade: raw adjusted by multiplicator/offset; frozen once a non-identity formula produced it. */
  private leafFinal(item: ItemRow, raw: number | null, existing?: GradeRow): { finalGrade: number | null; frozen: boolean } {
    if (raw === null) return { finalGrade: null, frozen: false };
    if (existing?.frozen) return { finalGrade: existing.finalGrade, frozen: true };
    const adjusted = adjustedGrade({
      itemId: item.id, gradeMin: item.gradeMin, gradeMax: item.gradeMax, grade: raw,
      multiplicator: item.multiplicator, offset: item.plusFactor,
    });
    const hasFormula = item.multiplicator !== 1 || item.plusFactor !== 0;
    return { finalGrade: adjusted, frozen: hasFormula };
  }

  /**
   * Đặt điểm cho user tại item: kiểm capability grade:edit, ghi lịch sử.
   * `options` cho luồng nghiệp vụ phía trên ghi đúng nguồn truy vết vào
   * history (`source`) và đặt cờ overridden khi giá trị là quyết định
   * sửa tay của giáo viên; không truyền options thì hành vi mặc định là
   * nhập tay (source 'manual', overridden=false).
   */
  async setGrade(actorId: string, itemId: string, userId: string, input: { rawGrade?: number | null; feedback?: string }, options?: { source?: string; overridden?: boolean }): Promise<GradeRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:edit', item.courseId);
    if (item.locked) throw new ForbiddenException({ message: 'This grade item is locked', code: 'grades.item_locked' });
    const existing = await this.repo.getGrade(itemId, userId);
    if (existing?.locked) throw new ForbiddenException({ message: 'This grade is locked', code: 'grades.grade_locked' });
    if (existing?.overridden && options?.overridden !== true) throw new ForbiddenException({ message: 'This grade is overridden; clear the override before entering a grade', code: 'grades.grade_overridden' });
    const raw = input.rawGrade ?? null;
    const clampedRaw = raw === null ? null : Math.min(item.gradeMax, Math.max(item.gradeMin, raw));
    const { finalGrade, frozen } = this.leafFinal(item, clampedRaw, existing);
    let saved!: GradeRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      saved = await this.repo.upsertGrade({
        itemId: itemId, userId: userId, rawGrade: clampedRaw, rawGradeMin: item.gradeMin, rawGradeMax: item.gradeMax,
        finalGrade, feedback: input.feedback ?? existing?.feedback ?? null,
        hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: options?.overridden ?? false, excluded: existing?.excluded ?? false, frozen,
        aggregationStatus: 'used', aggregationWeight: existing?.aggregationWeight ?? null,
      }, tx as never);
      await this.repo.insertHistory({
        action: existing ? 2 : 1, oldId: existing?.id ?? null, itemId: itemId, userId: userId,
        rawGrade: clampedRaw, finalGrade, overridden: options?.overridden ?? false, excluded: existing?.excluded ?? false,
        frozen, source: options?.source ?? 'manual', loggedUser: actorId,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseId, itemId, userId, rawGrade: clampedRaw, finalGrade, actorId },
      });
    });
    await this.refreshCompletionForUser(item.courseId, userId);
    await this.auditGradeChangeAfterPublish(actorId, item, userId, !!existing);
    void saved;
    return (await this.repo.getGrade(itemId, userId))!;
  }

  /**
   * Grade item của một course module (item_type 'mod'), nếu hoạt động đã có.
   */
  async getItemForCm(courseId: string, cmId: string): Promise<ItemRow | undefined> {
    return this.repo.findItemForCm(courseId, cmId);
  }

  /**
   * Đường ghi điểm CỦA HOẠT ĐỘNG (vd quiz ghi điểm bài sau khi chốt lượt
   * làm): không qua capability của người dùng vì chủ thể ghi là chính
   * hoạt động — lượt làm tự chốt phía server (hết giờ, đủ điểm) kể cả
   * khi không có thao tác của giáo viên. Vẫn tôn trọng các khoá: item bị
   * khoá thì từ chối, grade đã bị giáo viên ghi đè (overridden) hoặc
   * khoá thì GIỮ NGUYÊN (hoạt động không đè quyết định của giáo viên —
   * trả về grade hiện có). Ghi history với source là tên hoạt động.
   */
  async recordActivityGrade(itemId: string, userId: string, rawGrade: number | null, source = 'mod/quiz'): Promise<GradeRow | undefined> {
    const item = await this.getItem(itemId);
    if (item.locked) throw new ForbiddenException({ message: 'This grade item is locked', code: 'grades.item_locked' });
    const existing = await this.repo.getGrade(itemId, userId);
    if (existing?.locked || existing?.overridden) return existing;
    const raw = rawGrade === null ? null : Math.min(item.gradeMax, Math.max(item.gradeMin, rawGrade));
    const { finalGrade, frozen } = this.leafFinal(item, raw, existing);
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.upsertGrade({
        itemId: itemId, userId: userId, rawGrade: raw, rawGradeMin: item.gradeMin, rawGradeMax: item.gradeMax,
        finalGrade, feedback: existing?.feedback ?? null,
        hidden: existing?.hidden ?? false, locked: existing?.locked ?? false,
        overridden: false, excluded: existing?.excluded ?? false, frozen,
        aggregationStatus: 'used', aggregationWeight: existing?.aggregationWeight ?? null,
      }, tx as never);
      await this.repo.insertHistory({
        action: existing ? 2 : 1, oldId: existing?.id ?? null, itemId: itemId, userId: userId,
        rawGrade: raw, finalGrade, overridden: false, excluded: existing?.excluded ?? false,
        frozen, source, loggedUser: null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseId, itemId, userId, rawGrade: raw, finalGrade, source },
      });
    });
    await this.refreshCompletionForUser(item.courseId, userId);
    return this.repo.getGrade(itemId, userId);
  }

  /**
   * Sửa một bản ghi điểm đã có (ghi đè/khoá/loại trừ/ẩn/gỡ đóng băng/kèm lịch sử).
   */
  async updateGrade(actorId: string, gradeId: string, input: {
    overridden?: boolean; finalGrade?: number | null; locked?: boolean; excluded?: boolean;
    hidden?: boolean; frozen?: boolean; feedback?: string;
  }): Promise<GradeRow> {
    const grade = await this.repo.getGradeById(gradeId);
    if (!grade) throw new NotFoundException({ message: `Grade ${gradeId} not found`, code: 'grades.grade_not_found' });
    const item = await this.getItem(grade.itemId);
    await this.requireCap(actorId, 'grade:edit', item.courseId);
    const patch: Partial<GradeRow> = {};
    if (input.overridden !== undefined) patch.overridden = input.overridden;
    if (input.finalGrade !== undefined) patch.finalGrade = input.finalGrade;
    if (input.locked !== undefined) { patch.locked = input.locked; patch.lockTime = input.locked ? new Date() : null; }
    if (input.excluded !== undefined) patch.excluded = input.excluded;
    if (input.hidden !== undefined) patch.hidden = input.hidden;
    if (input.frozen !== undefined) patch.frozen = input.frozen;
    if (input.feedback !== undefined) patch.feedback = input.feedback;
    if (input.overridden === true && input.finalGrade === undefined && grade.finalGrade === null) {
      throw new BadRequestException({ message: 'Overriding requires a finalGrade', code: 'grades.override_needs_grade' });
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateGrade(gradeId, patch, tx as never);
      await this.repo.insertHistory({
        action: 2, oldId: gradeId, itemId: grade.itemId, userId: grade.userId,
        rawGrade: grade.rawGrade, finalGrade: patch.finalGrade ?? grade.finalGrade,
        overridden: patch.overridden ?? grade.overridden, excluded: patch.excluded ?? grade.excluded,
        frozen: patch.frozen ?? grade.frozen, source: 'override', loggedUser: actorId,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'grades', type: 'grade_updated',
        payload: { courseId: item.courseId, itemId: grade.itemId, userId: grade.userId, finalGrade: patch.finalGrade ?? grade.finalGrade, overridden: patch.overridden ?? grade.overridden, actorId },
      });
    });
    await this.refreshCompletionForUser(item.courseId, grade.userId);
    await this.auditGradeChangeAfterPublish(actorId, item, grade.userId, true);
    return (await this.repo.getGradeById(gradeId))!;
  }

  // --- cross-module evaluators ------------------------------------------------

  /** Completion hook: state for a cm with completionUseGrade. Null = no grade yet. */
  /**
   * Điểm phần trăm của user tại cm — đầu vào cho availability/completion theo điểm.
   */
  async evaluateCmGrade(cmId: string, userId: string): Promise<number | null> {
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (!cm) return null;
    const item = await this.repo.findItemForCm(cm.course, cmId);
    if (!item) return null;
    const grade = await this.repo.getGrade(item.id, userId);
    if (!grade || grade.finalGrade === null) return null;
    if (item.gradePass > 0) return grade.finalGrade >= item.gradePass ? COMPLETION_PASS : COMPLETION_FAIL;
    return COMPLETION_DONE;
  }

  /**
   * Course-completion 'grade' criterion: trước đây neo vào ĐIỂM TỔNG
   * KHOÁ. Mô hình điểm theo bài (#224) không còn điểm của khoá học nên
   * tiêu chí này không còn nền để đạt — luôn trả false; hoàn thành theo
   * điểm chỉ còn ở cấp hoạt động qua evaluateCmGrade.
   */
  async courseGradePassed(courseId: string, userId: string): Promise<boolean> {
    void courseId; void userId;
    return false;
  }

  /** Availability 'grade' leaf values: percentages (0-100) keyed by grade-item id AND by cm id. */
  /**
   * Điểm phần trăm theo từng item của user (cho availability).
   */
  async gradePercentagesForUser(userId: string, courseId: string): Promise<Record<string, number>> {
    const items = await this.repo.listItems(courseId);
    const grades = await this.repo.listGradesForCourse(courseId, userId);
    const out: Record<string, number> = {};
    for (const item of items) {
      const g = grades.find((x) => x.itemId === item.id);
      if (!g || g.finalGrade === null || item.gradeMax <= item.gradeMin) continue;
      const pct = ((g.finalGrade - item.gradeMin) / (item.gradeMax - item.gradeMin)) * 100;
      out[String(item.id)] = pct;
      if (item.itemType === 'mod') out[String(item.itemInstance)] = pct;
    }
    return out;
  }

  /** Raw final grade of an item for a user (facade for reports/other modules). */
  /**
   * Điểm cuối cùng của user tại item (sau tính toán).
   */
  async getFinalGrade(itemId: string, userId: string): Promise<number | null> {
    const g = await this.repo.getGrade(itemId, userId);
    return g?.finalGrade ?? null;
  }
  /**
   * Một dòng điểm đầy đủ tại item.
   */
  async getGradeRow(itemId: string, userId: string): Promise<GradeRow | undefined> {
    return this.repo.getGrade(itemId, userId);
  }
  /**
   * Lịch sử thay đổi điểm.
   */
  async listHistory(itemId: string, userId: string) {
    return this.repo.listHistory(itemId, userId);
  }

  private async refreshCompletionForUser(courseId: string, userId: string): Promise<void> {
    const cms = await this.courses.listCms(courseId);
    for (const cm of cms) {
      if (cm.completionUseGrade) await this.completion.refreshGradeCompletion(cm.id, userId);
    }
    await this.completion.reaggregateCourseCompletion(userId, courseId);
  }

  // --- Công bố điểm cấp bài (PH-0, issue #116) --------------------------------

  /**
   * Trạng thái công bố hiệu lực của mọi item trong một khoá: item 'auto' luôn
   * coi là đã công bố (điểm hiện ngay khi chấm); item 'manual' chỉ hiện khi
   * vết mới nhất trong grade_publications (scope item) là 'publish'.
   */
  async publicationStatesForCourse(courseId: string, items?: ItemRow[]): Promise<Map<string, GradePublicationState>> {
    const rows = items ?? await this.repo.listItems(courseId);
    const publications = await this.repo.listPublications(courseId);
    const latestByItem = new Map<string, string>();
    for (const p of publications) {
      if (p.scope === 'item' && p.itemId) latestByItem.set(p.itemId, p.action);
    }
    const states = new Map<string, GradePublicationState>();
    for (const item of rows) {
      const policy = item.postingPolicy === 'manual' ? 'manual' : 'auto';
      states.set(item.id, {
        policy,
        published: policy === 'auto' ? true : latestByItem.get(item.id) === 'publish',
      });
    }
    return states;
  }

  /** Trạng thái công bố hiệu lực của một item. */
  async itemPublicationState(item: ItemRow): Promise<GradePublicationState> {
    const states = await this.publicationStatesForCourse(item.courseId, [item]);
    return states.get(item.id) ?? { policy: 'auto', published: true };
  }

  /** Đặt chính sách công bố cho một item (grade:publish tại context khoá). */
  async setItemPostingPolicy(actorId: string, itemId: string, policy: 'auto' | 'manual'): Promise<ItemRow> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:publish', item.courseId);
    await this.repo.updateItem(itemId, { postingPolicy: policy });
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: 'grade_posting_policy_changed',
      payload: { actorId, courseId: item.courseId, itemId, objectId: itemId, policy },
    });
    return (await this.repo.getItem(itemId))!;
  }

  /** Công bố / rút công bố điểm của một item cho mọi học sinh (grade:publish tại context khoá); ghi vết vào grade_publications + event_log qua outbox. */
  async setItemPublication(actorId: string, itemId: string, action: 'publish' | 'unpublish', note?: string): Promise<GradePublicationState> {
    const item = await this.getItem(itemId);
    await this.requireCap(actorId, 'grade:publish', item.courseId);
    await this.repo.insertPublication({
      courseId: item.courseId, scope: 'item', itemId,
      action, actorId, note: note ?? null,
    });
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: action === 'publish' ? 'grade_item_published' : 'grade_item_unpublished',
      payload: { actorId, courseId: item.courseId, itemId, objectId: itemId, note: note ?? null },
    });
    return this.itemPublicationState(await this.getItem(itemId));
  }

  /**
   * Audit sửa điểm sau công bố (research PH mục 5.2.7): khi giáo viên sửa
   * một điểm ĐÃ TỒN TẠI trên item đang ở trạng thái công bố hiệu lực, phát
   * thêm sự kiện grade_changed_after_publish vào event_log qua outbox —
   * điểm đã tới tay học sinh/phụ huynh mà đổi thì phải có vết riêng.
   */
  private async auditGradeChangeAfterPublish(actorId: string, item: ItemRow, userId: string, hadExistingGrade: boolean): Promise<void> {
    if (!hadExistingGrade) return;
    const state = await this.itemPublicationState(item).catch(() => null);
    if (!state?.published) return;
    await this.outbox.enqueueStandalone({
      aggregate: 'grades', type: 'grade_changed_after_publish',
      payload: { actorId, courseId: item.courseId, itemId: item.id, userId, objectId: item.id },
    }).catch(() => undefined);
  }

  // --- Lưới xem điểm theo bài (CHỈ-ĐỌC, issue #224) ----------------------------

  /**
   * Điểm theo bài của MỘT học sinh trong một khoá — thay cho sổ điểm
   * tổng hợp cũ và cho ĐX-2 (HS xem ĐTB khoá). Viewer xem của người
   * khác cần grade:viewall; học sinh xem chính mình (hoặc phụ huynh qua
   * listPublishedActivityGrades) bị cổng công bố PH-0: item ẩn bị loại,
   * điểm của item manual chưa công bố bị che (grade = null). Lưới này
   * CHỈ ĐỌC: không lưu điểm tổng, không trọng số, không chốt.
   */
  async listUserActivityGrades(viewerId: string, courseId: string, targetUserId: string): Promise<{
    courseId: string; userId: string; activities: ActivityGradeView[];
  }> {
    let seeAll = false;
    if (viewerId !== targetUserId) {
      await this.requireCap(viewerId, 'grade:viewall', courseId);
      seeAll = true;
    } else {
      seeAll = await this.evaluator.hasCapability(viewerId, 'grade:viewall', await this.courses.courseContextId(courseId)).catch(() => false);
      if (!seeAll) await this.courses.assertCourseAccess(viewerId, courseId);
    }
    return {
      courseId, userId: targetUserId,
      activities: await this.buildActivityGradeViews(courseId, targetUserId, { maskUnpublished: !seeAll, hideHidden: !seeAll }),
    };
  }

  /**
   * Điểm theo bài ĐÃ CÔNG BỐ của một học sinh — bề mặt phụ huynh có
   * liên kết giám hộ (GuardiansService kiểm tra liên kết trước khi
   * gọi): ẩn như phía học sinh tự xem (item/điểm ẩn bị loại, điểm của
   * item manual chưa công bố bị che).
   */
  async listPublishedActivityGrades(courseId: string, targetUserId: string): Promise<ActivityGradeView[]> {
    return this.buildActivityGradeViews(courseId, targetUserId, { maskUnpublished: true, hideHidden: true });
  }

  private async buildActivityGradeViews(courseId: string, targetUserId: string, opts: { maskUnpublished: boolean; hideHidden: boolean }): Promise<ActivityGradeView[]> {
    const allItems = await this.repo.listItems(courseId);
    const items = opts.hideHidden ? allItems.filter((i) => !i.hidden) : allItems;
    const grades = await this.repo.listGradesForCourse(courseId, targetUserId);
    const gradeByItem = new Map(grades.map((g) => [g.itemId, g]));
    const publicationByItem = await this.publicationStatesForCourse(courseId, allItems);
    return items.map((item) => {
      const publication = publicationByItem.get(item.id) ?? { policy: 'auto' as const, published: true };
      const g = gradeByItem.get(item.id);
      const visible = g && !(opts.hideHidden && g.hidden) && !(opts.maskUnpublished && !publication.published) ? g : null;
      return { item, grade: visible, publication };
    });
  }

  /**
   * Lưới học sinh × các bài của khoá cho giáo viên (grade:viewall):
   * một hàng mỗi học sinh đã ghi danh, mỗi ô là finalGrade của đúng bài
   * đó (null = chưa có điểm). CHỈ ĐỌC — không điểm tổng, không trọng
   * số, không chốt kỳ.
   */
  async getCourseActivityGrid(viewerId: string, courseId: string): Promise<{
    courseId: string;
    items: ItemRow[];
    publications: Record<string, GradePublicationState>;
    rows: { userId: string; displayName: string; grades: Record<string, number | null> }[];
  }> {
    await this.requireCap(viewerId, 'grade:viewall', courseId);
    const items = await this.repo.listItems(courseId);
    const publicationByItem = await this.publicationStatesForCourse(courseId, items);
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userId))];
    const grades = await this.repo.listGradesForCourse(courseId);
    const gradeByUserItem = new Map(grades.map((g) => [`${g.userId}:${g.itemId}`, g.finalGrade ?? null]));
    const nameById = new Map<string, string>();
    if (userIds.length) {
      for (const u of await this.users.getUsersByIds(userIds)) {
        const full = `${u.firstName} ${u.lastName}`.trim();
        nameById.set(u.id, full || u.username);
      }
    }
    const rows = userIds.map((userId) => {
      const cells: Record<string, number | null> = {};
      for (const item of items) cells[item.id] = gradeByUserItem.get(`${userId}:${item.id}`) ?? null;
      return { userId, displayName: nameById.get(userId) ?? userId, grades: cells };
    });
    const publications: Record<string, GradePublicationState> = {};
    for (const [id, state] of publicationByItem) publications[id] = state;
    return { courseId, items, publications, rows };
  }

  // --- Xuất vnEdu (issue #53; nguồn đổi ở #224) --------------------------------

  /** Năm học mặc định cho bảng xuất vnEdu: năm học VN bắt đầu tháng 8 (tháng 8–12 thuộc năm học bắt đầu năm đó, tháng 1–7 thuộc năm học bắt đầu năm trước). */
  private defaultVneduSchoolYear(now = new Date()): string {
    const startYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
    return `${startYear}-${startYear + 1}`;
  }

  /**
   * Xuất điểm ra Excel theo cấu trúc vnEdu (issue #53; khuôn mẫu giữ
   * nguyên): một bảng cho một môn/lớp/học kỳ, cột STT/Mã học sinh (username)/
   * Họ và tên, mỗi mục thường xuyên một cột (hệ số 1), giữa kỳ (hệ số 2),
   * cuối kỳ (hệ số 3) và ĐTBmhk tính trong domain/vnedu-export (bản công
   * thức ĐTB DUY NHẤT còn lại của hệ — phục vụ cột ĐTBmhk của chính mẫu
   * file xuất, không phải sổ điểm). Ánh xạ bài → loại cột do giáo viên
   * xác nhận tường minh trong payload.
   *
   * NGUỒN (đổi theo quyết định 23:49 ngày 25/10/2026, issue #224): chỉ
   * các bài ĐÃ CÔNG BỐ mới được xuất — bài ở chính sách manual mà chưa
   * công bố thì từ chối cả lượt xuất (grades.vnedu_item_not_published),
   * vì điểm chưa công bố chưa phải điểm chính thức để rời hệ thống.
   * Quyền: grade:viewall tại context khoá.
   */
  async exportGradesVnedu(actorId: string, courseId: string, dto: ExportGradesVneduDto): Promise<{ filename: string; buffer: Buffer }> {
    const course = await this.courses.getCourse(courseId);
    await this.requireCap(actorId, 'grade:viewall', courseId);
    const items = await this.repo.listItems(courseId);
    const byId = new Map(items.map((i) => [i.id, i]));
    const mappedIds = [...dto.regularItemIds, dto.midtermItemId, dto.finalItemId];
    if (new Set(mappedIds).size !== mappedIds.length) {
      throw new BadRequestException({ message: 'Each grade item may only be mapped to one vnEdu column type', code: 'grades.vnedu_duplicate_item' });
    }
    const resolveItem = (itemId: string): ItemRow => {
      const item = byId.get(itemId);
      if (!item) {
        throw new BadRequestException({ message: `Grade item ${itemId} does not belong to this course`, code: 'grades.vnedu_item_not_in_course' });
      }
      if (item.itemType !== 'manual' && item.itemType !== 'mod') {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' is not an activity grade`, code: 'grades.vnedu_item_not_exportable' });
      }
      if (item.gradeType !== 'value') {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' is not a numeric (value) grade and cannot be converted to the 10-point scale`, code: 'grades.vnedu_item_not_exportable' });
      }
      if (!(item.gradeMax > item.gradeMin)) {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' has an empty grade range`, code: 'grades.vnedu_item_bad_range' });
      }
      return item;
    };
    const regular = dto.regularItemIds.map((id) => resolveItem(id));
    const midterm = resolveItem(dto.midtermItemId);
    const finalItem = resolveItem(dto.finalItemId);

    const publicationByItem = await this.publicationStatesForCourse(courseId, items);
    for (const item of [...regular, midterm, finalItem]) {
      const state = publicationByItem.get(item.id);
      if (state && !state.published) {
        throw new BadRequestException({ message: `Grade item '${item.itemName}' is not published yet; only published activity grades can be exported to vnEdu`, code: 'grades.vnedu_item_not_published' });
      }
    }

    const toModelItem = (item: ItemRow): VneduExportItem => ({ id: item.id, name: item.itemName, gradeMin: item.gradeMin, gradeMax: item.gradeMax });
    const regularModel = regular.map(toModelItem);
    const midtermModel = toModelItem(midterm);
    const finalModel = toModelItem(finalItem);

    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userId))];
    const usersById = new Map((await this.users.getUsersByIds(userIds)).map((u) => [u.id, u]));
    const grades = await this.repo.listGradesForCourse(courseId);
    const gradeByUserItem = new Map(grades.map((g) => [`${g.userId}:${g.itemId}`, g.finalGrade ?? null]));
    const mappedItems = [...regularModel, midtermModel, finalModel];
    const givenNameOf = (fullName: string): string => fullName.trim().split(/\s+/).at(-1) ?? '';
    const students = userIds.map((userId) => {
      const user = usersById.get(userId);
      const fullName = user ? `${user.lastName} ${user.firstName}`.replace(/\s+/g, ' ').trim() : '';
      const studentGrades = new Map<string, number | null>();
      for (const item of mappedItems) studentGrades.set(item.id, gradeByUserItem.get(`${userId}:${item.id}`) ?? null);
      return { code: user?.username ?? userId, fullName, grades: studentGrades };
    });
    // Danh sách lớp VN xếp theo TÊN (từ cuối của họ tên), rồi họ tên đầy đủ, rồi mã — như sổ điểm giấy.
    students.sort((a, b) =>
      givenNameOf(a.fullName).localeCompare(givenNameOf(b.fullName), 'vi')
      || a.fullName.localeCompare(b.fullName, 'vi')
      || a.code.localeCompare(b.code));

    const schoolYear = dto.schoolYear ?? this.defaultVneduSchoolYear();
    const model: VneduExportModel = {
      className: dto.className ?? course.shortName,
      subjectName: dto.subjectName ?? course.fullName,
      semester: dto.semester,
      schoolYear,
      regular: regularModel,
      midterm: midtermModel,
      final: finalModel,
      students,
    };
    const buffer = await renderVneduWorkbook(model);
    const safeShortName = course.shortName.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'course';
    return { filename: `vnedu-${safeShortName}-hk${dto.semester}-${schoolYear}.xlsx`, buffer };
  }
}
