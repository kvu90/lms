import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { CoursesService } from '../courses/courses.service';
import {
  CurriculumRepository, type CurriculumNodeRow, type CurriculumRow, type LearningOutcomeRow, type SubjectRow,
} from './curriculum.repository';

/** Capability đọc cây curriculum tại context của môn học. */
export const CURRICULUM_VIEW = 'curriculum:view';
/** Capability quản trị (tạo/sửa/xoá) cây curriculum tại context của môn học. */
export const CURRICULUM_MANAGE = 'curriculum:manage';
/** Capability sửa khoá — nhánh quyền phụ cho đường đọc cây phục vụ nạp khung vào chính khoá đó. */
const COURSE_UPDATE = 'course:update';

/** Một node của cây nội dung kèm outcomes của chính nó và các node con (đệ quy). */
export interface CurriculumNodeView extends CurriculumNodeRow {
  outcomes: LearningOutcomeRow[];
  children: CurriculumNodeView[];
}

/** Cây nội dung trọn vẹn của một chương trình. */
export interface CurriculumTreeView {
  curriculum: CurriculumRow;
  subject: SubjectRow;
  nodes: CurriculumNodeView[];
}

/** Bóc lỗi vi phạm unique của PostgreSQL (23505) dù Drizzle có bọc qua cause hay không. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e !== null && typeof e === 'object') {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
/**
 * Curriculum — port của giaokhoa (subjects → curricula → cây nodes →
 * learning_outcomes) cho chương trình GDPT 2018.
 * Phân quyền bám mẫu ngân hàng câu hỏi/stimulus: môn học neo vào một
 * context; mọi thao tác đọc cần `curriculum:view`, thao tác ghi cần
 * `curriculum:manage` tại context đó qua PermissionEvaluator — không
 * theo sở hữu cá nhân. Site admin bỏ qua kiểm tra như mọi bounded context.
 * Ngoại lệ duy nhất (K0a, điểm chặn review #66): đường đọc phục vụ CHỌN
 * khung cho một khoá cụ thể (danh sách môn/chương trình/cây kèm tham số
 * `forCourseId`) còn mở theo nhánh `course:update` tại chính khoá đích —
 * giáo viên được gán vai tại context khoá không có vai ở context hệ
 * thống, nhưng chương trình là dữ liệu quốc gia công khai trong trường
 * và việc nạp khung vào khoá đó vốn đã đòi `course:update` tại khoá.
 * Nhánh này không áp cho bề mặt quản trị cây (vẫn `curriculum:manage`).
 */
export class CurriculumService implements OnModuleInit {
  constructor(
    private readonly repo: CurriculumRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
  ) {}

  /**
   * Khởi tạo: đăng ký nguồn đơn vị khung cho cơ chế nạp khung vào khoá
   * của Courses (dependency inversion — Courses không import Curriculum).
   */
  onModuleInit(): void {
    this.courses.registerCurriculumFrameProvider({
      getFrameUnits: (actorId, curriculumId) => this.getFrameUnits(actorId, curriculumId),
    });
  }

  private async contextOrSystem(contextId: string) {
    const ctx = await this.contexts.getContext(contextId).catch(() => undefined);
    return ctx ?? (await this.contexts.ensureSystemContext());
  }

  // --- subjects ---------------------------------------------------------------

  /** Tạo môn học trong một context; slug trùng → 409. */
  async createSubject(actorId: string, input: { contextId: string; name: string; slug: string; position?: number }): Promise<SubjectRow> {
    const ctx = await this.contextOrSystem(input.contextId);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, ctx.id);
    try {
      return await this.repo.insertSubject({
        contextId: ctx.id, name: input.name, slug: input.slug, position: input.position ?? 1,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ message: `Subject slug ${input.slug} is already taken`, code: 'curriculum.subject_slug_taken' });
      }
      throw err;
    }
  }
  /**
   * Liệt kê môn học trong một context (cần quyền xem tại context đó;
   * kèm `forCourseId` thì nhánh `course:update` tại khoá đích cũng đủ —
   * bề mặt chọn khung trong quản trị khoá).
   */
  async listSubjects(actorId: string, contextId: string, forCourseId?: string): Promise<SubjectRow[]> {
    const ctx = await this.contextOrSystem(contextId);
    await this.assertCanRead(actorId, ctx.id, forCourseId);
    return this.repo.listSubjects(ctx.id);
  }
  /** Lấy môn học; ném curriculum.subject_not_found khi vắng. */
  async getSubject(actorId: string, id: string): Promise<SubjectRow> {
    const row = await this.subjectOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, row.contextId);
    return row;
  }
  /** Sửa môn học. */
  async updateSubject(actorId: string, id: string, input: { name?: string; slug?: string; position?: number }): Promise<SubjectRow> {
    const row = await this.subjectOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, row.contextId);
    try {
      await this.repo.updateSubject(id, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ message: `Subject slug ${input.slug} is already taken`, code: 'curriculum.subject_slug_taken' });
      }
      throw err;
    }
    return this.subjectOr404(id);
  }
  /** Xoá môn học (cascade toàn bộ chương trình bên dưới); còn tham chiếu cứng vào cây/YCCĐ của môn → 409 (xem assertNotReferenced). */
  async deleteSubject(actorId: string, id: string): Promise<void> {
    const row = await this.subjectOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, row.contextId);
    const curricula = await this.repo.listCurricula(id);
    const { nodeIds, outcomeIds } = await this.subtreeIds(curricula.map((c) => c.id));
    await this.assertNotReferenced(nodeIds, outcomeIds, `subject ${row.slug}`);
    await this.repo.deleteSubject(id);
  }

  // --- curricula ----------------------------------------------------------------

  /** Tạo chương trình cho một môn ở một khối; trùng cặp môn + khối → 409. */
  async createCurriculum(actorId: string, input: { subjectId: string; grade: number }): Promise<CurriculumRow> {
    const subject = await this.subjectOr404(input.subjectId);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    try {
      return await this.repo.insertCurriculum({ subjectId: subject.id, grade: input.grade });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ message: `Subject already has a curriculum for grade ${input.grade}`, code: 'curriculum.grade_exists' });
      }
      throw err;
    }
  }
  /** Liệt kê chương trình của một môn (nhánh `forCourseId` như listSubjects). */
  async listCurricula(actorId: string, subjectId: string, forCourseId?: string): Promise<CurriculumRow[]> {
    const subject = await this.subjectOr404(subjectId);
    await this.assertCanRead(actorId, subject.contextId, forCourseId);
    return this.repo.listCurricula(subject.id);
  }
  /** Lấy chương trình theo id. */
  async getCurriculum(actorId: string, id: string): Promise<CurriculumRow> {
    const { curriculum, subject } = await this.curriculumChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subject.contextId);
    return curriculum;
  }
  /** Sửa chương trình (khối). */
  async updateCurriculum(actorId: string, id: string, input: { grade?: number }): Promise<CurriculumRow> {
    const { subject } = await this.curriculumChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    try {
      await this.repo.updateCurriculum(id, input);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ message: `Subject already has a curriculum for grade ${input.grade}`, code: 'curriculum.grade_exists' });
      }
      throw err;
    }
    return (await this.curriculumChainOr404(id)).curriculum;
  }
  /** Xoá chương trình (cascade cây node + outcomes); còn tham chiếu cứng vào cây/YCCĐ của chương trình → 409. */
  async deleteCurriculum(actorId: string, id: string): Promise<void> {
    const { subject } = await this.curriculumChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    const { nodeIds, outcomeIds } = await this.subtreeIds([id]);
    await this.assertNotReferenced(nodeIds, outcomeIds, `curriculum ${id}`);
    await this.repo.deleteCurriculum(id);
  }

  // --- nodes ----------------------------------------------------------------------

  /**
   * Tạo node trong cây của một chương trình. Node cha (nếu có) phải thuộc
   * cùng chương trình — tầng service chặn trước với 400 tường minh, khoá
   * ngoại ghép ở DB là tuyến phòng thủ thứ hai.
   */
  async createNode(actorId: string, input: {
    curriculumId: string; parentId?: string | null; title: string; kind?: string; position?: number;
    durationPeriods?: number | null; durationPercent?: number | null;
  }): Promise<CurriculumNodeRow> {
    const { subject } = await this.curriculumChainOr404(input.curriculumId);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    if (input.parentId) await this.assertParentInCurriculum(input.parentId, input.curriculumId);
    return this.repo.insertNode({
      curriculumId: input.curriculumId,
      parentId: input.parentId ?? null,
      title: input.title,
      kind: input.kind ?? 'topic',
      position: input.position ?? 1,
      durationPeriods: input.durationPeriods ?? null,
      durationPercent: input.durationPercent ?? null,
    });
  }
  /** Lấy một node theo id. */
  async getNode(actorId: string, id: string): Promise<CurriculumNodeRow> {
    const { node, subject } = await this.nodeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subject.contextId);
    return node;
  }
  /**
   * Sửa node; đổi cha vẫn phải ở trong cùng chương trình, không tự trỏ
   * vào chính mình, và **không tạo vòng cha–con gián tiếp** (cha mới là
   * hậu duệ của node — sửa ở Chặng 2, mục A.7: trước đây chỉ chặn tự
   * trỏ, vòng gián tiếp làm subtree biến mất khỏi cây đọc).
   */
  async updateNode(actorId: string, id: string, input: {
    parentId?: string | null; title?: string; kind?: string; position?: number;
    durationPeriods?: number | null; durationPercent?: number | null;
  }): Promise<CurriculumNodeRow> {
    const { node, subject } = await this.nodeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    if (input.parentId !== undefined && input.parentId !== null) {
      if (input.parentId === id) {
        throw new BadRequestException({ message: 'A node cannot be its own parent', code: 'curriculum.node_parent_self' });
      }
      await this.assertParentInCurriculum(input.parentId, node.curriculumId);
      await this.assertNoParentCycle(id, input.parentId, node.curriculumId);
    }
    await this.repo.updateNode(id, input);
    return (await this.nodeChainOr404(id)).node;
  }
  /** Xoá node (cascade node con + outcomes); còn tham chiếu cứng vào node/YCCĐ trong subtree → 409. */
  async deleteNode(actorId: string, id: string): Promise<void> {
    const { node, subject } = await this.nodeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    const all = await this.repo.listNodes(node.curriculumId);
    const childrenByParent = new Map<string, string[]>();
    for (const n of all) {
      if (n.parentId) childrenByParent.set(n.parentId, [...(childrenByParent.get(n.parentId) ?? []), n.id]);
    }
    const nodeIds = [id];
    for (let i = 0; i < nodeIds.length; i += 1) nodeIds.push(...(childrenByParent.get(nodeIds[i]!) ?? []));
    const outcomes = await this.repo.listOutcomesForNodes(nodeIds);
    await this.assertNotReferenced(nodeIds, outcomes.map((o) => o.id), `node ${id}`);
    await this.repo.deleteNode(id);
  }

  /**
   * Cổng đọc cây/môn/chương trình: đạt khi có `curriculum:view` tại
   * context của môn, HOẶC — chỉ khi lời gọi phục vụ nạp khung cho một
   * khoá cụ thể (`forCourseId`) — có `course:update` tại context của
   * chính khoá đó. Ngoài hai nhánh này vẫn 403 như cũ: giáo viên của
   * khoá khác và người không liên quan không đọc được cây qua nhánh mới.
   */
  private async assertCanRead(actorId: string, subjectContextId: string, forCourseId?: string): Promise<void> {
    if (await this.evaluator.hasCapability(actorId, CURRICULUM_VIEW, subjectContextId)) return;
    if (forCourseId) {
      const courseCtxId = await this.courses.courseContextId(forCourseId).catch(() => undefined);
      if (courseCtxId && (await this.evaluator.hasCapability(actorId, COURSE_UPDATE, courseCtxId))) return;
    }
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subjectContextId);
  }

  /**
   * Cây nội dung trọn vẹn của một chương trình: node lồng nhau theo
   * parent_id, mỗi node kèm outcomes của chính nó; thứ tự theo position.
   * Kèm `forCourseId` (bề mặt chọn khung) thì nhánh `course:update` tại
   * khoá đích cũng được đọc — xem assertCanRead.
   */
  async getTree(actorId: string, curriculumId: string, forCourseId?: string): Promise<CurriculumTreeView> {
    const { curriculum, subject } = await this.curriculumChainOr404(curriculumId);
    await this.assertCanRead(actorId, subject.contextId, forCourseId);
    return this.buildTree(curriculum, subject);
  }

  /** Dựng cây từ dữ liệu đã phân giải — KHÔNG tự kiểm quyền; mọi caller phải qua cổng trước. */
  private async buildTree(curriculum: CurriculumRow, subject: SubjectRow): Promise<CurriculumTreeView> {
    const curriculumId = curriculum.id;
    const nodes = await this.repo.listNodes(curriculumId);
    const outcomes = await this.repo.listOutcomesForNodes(nodes.map((n) => n.id));
    const byId = new Map<string, CurriculumNodeView>();
    for (const node of nodes) byId.set(node.id, { ...node, outcomes: [], children: [] });
    for (const outcome of outcomes) byId.get(outcome.nodeId)?.outcomes.push(outcome);
    const roots: CurriculumNodeView[] = [];
    for (const node of nodes) {
      const view = byId.get(node.id)!;
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(view); else roots.push(view);
    }
    return { curriculum, subject, nodes: roots };
  }

  /**
   * Các đơn vị khung chọn được để nạp vào khoá (K0a): mọi node không
   * phải `lesson` của cây, kèm toàn bộ YCCĐ trong subtree của nó theo
   * đúng thứ tự cây (node cha trước, node con theo position, YCCĐ theo
   * position). Đây là hình dạng Courses dùng để dựng section bản sao có
   * neo. Hàm này là đường NỘI BỘ của provider khung (không có route HTTP
   * riêng): cổng quyền là `course:update` tại khoá đích do
   * Courses.applyCurriculumFrame kiểm TRƯỚC khi gọi — không đòi thêm
   * `curriculum:view` tại context hệ thống, vì giáo viên thật chỉ được
   * gán vai tại context khoá (điểm chặn review #66 trên head be194dc).
   */
  async getFrameUnits(_actorId: string, curriculumId: string): Promise<{
    nodeId: string; title: string; kind: string;
    outcomes: { outcomeId: string; content: string }[];
  }[]> {
    const { curriculum, subject } = await this.curriculumChainOr404(curriculumId);
    const tree = await this.buildTree(curriculum, subject);
    const units: { nodeId: string; title: string; kind: string; outcomes: { outcomeId: string; content: string }[] }[] = [];
    const collectOutcomes = (node: CurriculumNodeView, acc: { outcomeId: string; content: string }[]): void => {
      for (const o of node.outcomes) acc.push({ outcomeId: o.id, content: o.content });
      for (const child of node.children) collectOutcomes(child, acc);
    };
    const walk = (node: CurriculumNodeView): void => {
      if (node.kind !== 'lesson') {
        const outcomes: { outcomeId: string; content: string }[] = [];
        collectOutcomes(node, outcomes);
        units.push({ nodeId: node.id, title: node.title, kind: node.kind, outcomes });
      }
      for (const child of node.children) walk(child);
    };
    for (const root of tree.nodes) walk(root);
    return units;
  }

  // --- outcomes ---------------------------------------------------------------------

  /** Tạo yêu cầu cần đạt dưới một node, kèm truy vết nguồn (mục A.3). */
  async createOutcome(actorId: string, input: {
    nodeId: string; content: string; position?: number;
    sourceKind?: string; sourceRef?: string | null; derivedFromId?: string | null;
  }): Promise<LearningOutcomeRow> {
    const { subject } = await this.nodeChainOr404(input.nodeId);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    await this.assertOutcomeSource({ sourceKind: input.sourceKind ?? 'program', derivedFromId: input.derivedFromId ?? null });
    return this.repo.insertOutcome({
      nodeId: input.nodeId, content: input.content, position: input.position ?? 1,
      sourceKind: input.sourceKind ?? 'program', sourceRef: input.sourceRef ?? null, derivedFromId: input.derivedFromId ?? null,
    });
  }
  /** Liệt kê yêu cầu cần đạt của một node. */
  async listOutcomes(actorId: string, nodeId: string): Promise<LearningOutcomeRow[]> {
    const { subject } = await this.nodeChainOr404(nodeId);
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subject.contextId);
    return this.repo.listOutcomes(nodeId);
  }
  /** Lấy yêu cầu cần đạt theo id. */
  async getOutcome(actorId: string, id: string): Promise<LearningOutcomeRow> {
    const { outcome, subject } = await this.outcomeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subject.contextId);
    return outcome;
  }
  /** Sửa yêu cầu cần đạt (gồm truy vết nguồn — kiểm chứng trên trạng thái gộp cũ + mới). */
  async updateOutcome(actorId: string, id: string, input: {
    content?: string; position?: number;
    sourceKind?: string; sourceRef?: string | null; derivedFromId?: string | null;
  }): Promise<LearningOutcomeRow> {
    const { outcome, subject } = await this.outcomeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    await this.assertOutcomeSource({
      sourceKind: input.sourceKind ?? outcome.sourceKind,
      derivedFromId: input.derivedFromId !== undefined ? input.derivedFromId : outcome.derivedFromId,
    }, id);
    await this.repo.updateOutcome(id, input);
    return (await this.outcomeChainOr404(id)).outcome;
  }
  /**
   * Số câu hỏi sẵn sàng (ready) đã gắn vào một YCCĐ, theo (mức × dạng) —
   * API khả dụng tối thiểu của Chặng 2 (mục A.6) để Quiz Chặng 3 đếm
   * ứng viên cho ô ma trận mà không tự truy vấn chéo module.
   */
  async getOutcomeQuestionCounts(actorId: string, id: string): Promise<{ outcomeId: string; counts: { cognitiveLevel: string; qtype: string; count: number }[] }> {
    const { subject } = await this.outcomeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_VIEW, subject.contextId);
    return { outcomeId: id, counts: await this.repo.countReadyQuestionsForOutcome(id) };
  }
  /** Xoá yêu cầu cần đạt; còn tham chiếu cứng vào chính YCCĐ này → 409. */
  async deleteOutcome(actorId: string, id: string): Promise<void> {
    const { subject } = await this.outcomeChainOr404(id);
    await this.evaluator.requireCapability(actorId, CURRICULUM_MANAGE, subject.contextId);
    await this.assertNotReferenced([], [id], `learning outcome ${id}`);
    await this.repo.deleteOutcome(id);
  }

  /** Node + YCCĐ của một tập chương trình (đầu vào cho cổng chặn xoá theo tham chiếu). */
  private async subtreeIds(curriculumIds: string[]): Promise<{ nodeIds: string[]; outcomeIds: string[] }> {
    const nodeIds: string[] = [];
    for (const curriculumId of curriculumIds) {
      const nodes = await this.repo.listNodes(curriculumId);
      nodeIds.push(...nodes.map((n) => n.id));
    }
    const outcomes = await this.repo.listOutcomesForNodes(nodeIds);
    return { nodeIds, outcomeIds: outcomes.map((o) => o.id) };
  }

  /**
   * Cổng chặn xoá theo tham chiếu (GDPT-SEED): các FK từ ánh xạ sách,
   * ô ma trận đề và liên kết câu hỏi–YCCĐ vào cây chương trình là
   * RESTRICT (không còn cascade) — xoá mà còn tham chiếu thì Postgres
   * ném lỗi FK thô. Chặn trước ở tầng nghiệp vụ: 409 kèm số lượng
   * từng loại tham chiếu để quản trị gỡ tham chiếu rồi mới xoá.
   */
  private async assertNotReferenced(nodeIds: string[], outcomeIds: string[], what: string): Promise<void> {
    const refs = await this.repo.countGuardedReferences(nodeIds, outcomeIds);
    const parts: string[] = [];
    if (refs.bookMappings > 0) parts.push(`${refs.bookMappings} book mapping(s)`);
    if (refs.examMatrixCells > 0) parts.push(`${refs.examMatrixCells} exam matrix cell(s)`);
    if (refs.questionOutcomes > 0) parts.push(`${refs.questionOutcomes} question–outcome link(s)`);
    if (parts.length === 0) return;
    throw new ConflictException({
      message: `Cannot delete ${what}: still referenced by ${parts.join(', ')}. Remove those references first.`,
      code: 'curriculum.delete_referenced',
    });
  }

  // --- chains -----------------------------------------------------------------------

  private async subjectOr404(id: string): Promise<SubjectRow> {
    const row = await this.repo.getSubject(id);
    if (!row) throw new NotFoundException({ message: `Subject ${id} not found`, code: 'curriculum.subject_not_found' });
    return row;
  }
  private async curriculumChainOr404(id: string): Promise<{ curriculum: CurriculumRow; subject: SubjectRow }> {
    const curriculum = await this.repo.getCurriculum(id);
    if (!curriculum) throw new NotFoundException({ message: `Curriculum ${id} not found`, code: 'curriculum.curriculum_not_found' });
    const subject = await this.subjectOr404(curriculum.subjectId);
    return { curriculum, subject };
  }
  private async nodeChainOr404(id: string): Promise<{ node: CurriculumNodeRow; curriculum: CurriculumRow; subject: SubjectRow }> {
    const node = await this.repo.getNode(id);
    if (!node) throw new NotFoundException({ message: `Curriculum node ${id} not found`, code: 'curriculum.node_not_found' });
    const { curriculum, subject } = await this.curriculumChainOr404(node.curriculumId);
    return { node, curriculum, subject };
  }
  private async outcomeChainOr404(id: string): Promise<{ outcome: LearningOutcomeRow; node: CurriculumNodeRow; subject: SubjectRow }> {
    const outcome = await this.repo.getOutcome(id);
    if (!outcome) throw new NotFoundException({ message: `Learning outcome ${id} not found`, code: 'curriculum.outcome_not_found' });
    const { node, subject } = await this.nodeChainOr404(outcome.nodeId);
    return { outcome, node, subject };
  }
  private async assertParentInCurriculum(parentId: string, curriculumId: string): Promise<void> {
    const parent = await this.repo.getNode(parentId);
    if (!parent) throw new NotFoundException({ message: `Curriculum node ${parentId} not found`, code: 'curriculum.node_not_found' });
    if (parent.curriculumId !== curriculumId) {
      throw new BadRequestException({ message: 'Parent node belongs to a different curriculum', code: 'curriculum.node_parent_mismatch' });
    }
  }

  /**
   * Chặn vòng cha–con gián tiếp (mục A.7): duyệt tổ tiên của cha mới
   * trong cùng chương trình (tải danh sách node một lần, duyệt trong bộ
   * nhớ như getTree); gặp chính node đang sửa trên đường đi lên → 400.
   * Tập visited cũng là phanh an toàn nếu dữ liệu cũ đã có vòng.
   */
  private async assertNoParentCycle(nodeId: string, newParentId: string, curriculumId: string): Promise<void> {
    const nodes = await this.repo.listNodes(curriculumId);
    const parentById = new Map(nodes.map((n) => [n.id, n.parentId]));
    const visited = new Set<string>();
    let cursor: string | null = newParentId;
    while (cursor !== null) {
      if (cursor === nodeId) {
        throw new BadRequestException({
          message: 'The new parent is a descendant of this node; the change would create a cycle in the curriculum tree',
          code: 'curriculum.node_parent_cycle',
        });
      }
      if (visited.has(cursor)) break;
      visited.add(cursor);
      cursor = parentById.get(cursor) ?? null;
    }
  }

  /**
   * Kiểm chứng truy vết nguồn của YCCĐ (mục A.3): `source_kind =
   * 'derived'` bắt buộc có `derived_from_id` (F2); `derived_from_id`
   * chỉ dùng khi source_kind = 'derived', phải trỏ tới một YCCĐ có
   * thật và không tự trỏ vào chính nó. Kiểm chứng trên trạng thái gộp
   * (bản ghi hiện tại + thay đổi) nên áp cho cả tạo mới lẫn PATCH.
   */
  private async assertOutcomeSource(state: { sourceKind: string; derivedFromId: string | null }, selfId?: string): Promise<void> {
    if (state.sourceKind === 'derived' && state.derivedFromId === null) {
      throw new BadRequestException({
        message: 'derivedFromId is required when sourceKind is derived',
        code: 'curriculum.outcome_derived_from_required',
      });
    }
    if (state.derivedFromId === null) return;
    if (selfId !== undefined && state.derivedFromId === selfId) {
      throw new BadRequestException({ message: 'A learning outcome cannot be derived from itself', code: 'curriculum.outcome_derived_from_self' });
    }
    if (state.sourceKind !== 'derived') {
      throw new BadRequestException({
        message: 'derivedFromId is only used when sourceKind is derived',
        code: 'curriculum.outcome_derived_from_mismatch',
      });
    }
    const origin = await this.repo.getOutcome(state.derivedFromId);
    if (!origin) throw new NotFoundException({ message: `Learning outcome ${state.derivedFromId} not found`, code: 'curriculum.outcome_not_found' });
  }
}
