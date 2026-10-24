import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ContextsService } from '../access/contexts.service';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CoursesService } from '../courses/courses.service';
import { FilesService } from '../files/files.service';
import { SearchService } from '../search/search.service';
import { ContentBankRepository, type ContentFilters, type ContentRow } from './content-bank.repository';

/** Các loại nội dung đã đăng ký — loại nội dung là extension point, bản này cài 'file-based' generic. */
export const CONTENT_TYPES = ['file-based'] as const;

/** Loại học liệu của Kho học liệu: đúng 5 nhóm Điều 7 TT 09/2021 (CB1-B2). */
export const RESOURCE_TYPES = ['multimedia_lecture', 'lab_guide', 'simulation', 'question_set', 'reference'] as const;
/** Không gian của Kho học liệu: cá nhân | tổ chuyên môn | toàn trường. */
export const SCOPES = ['personal', 'org', 'school'] as const;
/** Cấp học độc lập với khối (CB1-B2). */
export const LEVELS = ['primary', 'lower_secondary', 'upper_secondary', 'multi'] as const;
/** Nguồn gốc học liệu (CB1-B1). */
export const SOURCE_KINDS = ['self', 'cited', 'derived'] as const;
export const TARGET_AUDIENCES = ['students', 'teachers', 'both'] as const;
/** Vị trí dùng trong bài theo khung CV 5512 (CB1-B3). */
export const LESSON_POSITIONS = ['opening', 'new_knowledge', 'practice', 'application'] as const;

/** Checklist duyệt theo tiêu chí thể lệ bài giảng điện tử của Bộ (CB1-B3). */
export interface ReviewChecklist {
  contentAccurate: boolean;
  sourceClear: boolean;
  pedagogyAesthetics: boolean;
  mobileReady: boolean;
}

export interface LibraryItemInput {
  name: string;
  contextId?: string;
  contentType?: string;
  visibility?: string;
  fileId?: string;
  resourceType?: string;
  scope?: string;
  spaceId?: string;
  subjectId?: string;
  grade?: number;
  level?: string;
  curriculumNodeId?: string;
  outcomeIds?: string[];
  questionCategoryId?: string;
  externalUrl?: string;
  description?: string;
  keywords?: string[];
  targetAudience?: string;
  lessonPosition?: string;
  techFormat?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  language?: string;
  originalAuthor?: string;
  sourceKind?: string;
  sourceCitation?: string;
  license?: string;
  derivedFromId?: string;
}

export interface SpaceView {
  scope: string;
  spaceId: string | null;
  name: string;
  canReview: boolean;
}

/**
 * ContentBankModule facade — Kho học liệu (CB-1, issue #69).
 * Trên khung Content Bank sẵn có (bảng/API/Files): học liệu mang metadata
 * chương trình (môn–khối–node–YCCĐ) + loại học liệu, sống trong một không
 * gian (cá nhân / tổ chuyên môn qua cohort / toàn trường) và học liệu chia
 * sẻ phải qua duyệt của tổ trưởng (`contentbank:reviewcontent` +
 * `cohort:manage` tại context của tổ; cấp trường là reviewcontent tại
 * context hệ thống) mới hiện với đồng nghiệp. Học liệu chưa duyệt KHÔNG hiện ở
 * scope tổ/trường với người ngoài (chỉ tác giả + người duyệt thấy).
 * Ngân hàng câu hỏi là kho TÁCH RIÊNG: loại `question_set` chỉ THAM CHIẾU
 * category của ngân hàng câu hỏi, không chứa bản sao câu hỏi.
 */
@Injectable()
export class ContentBankService {
  constructor(
    private readonly repo: ContentBankRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly files: FilesService,
    private readonly search: SearchService,
    private readonly contexts: ContextsService,
    private readonly courses: CoursesService,
  ) {}

  async get(id: string): Promise<ContentRow> {
    const row = await this.repo.get(id);
    if (!row) throw new NotFoundException({ message: `Content ${id} not found`, code: 'contentbank.not_found' });
    return row;
  }

  // --- không gian & context ---------------------------------------------------

  private async systemContextId(): Promise<string> {
    return (await this.contexts.ensureSystemContext()).id;
  }

  /** Context cá nhân của một user (level USER), tạo lười biếng dưới context hệ thống. */
  private async personalContextId(userId: string): Promise<string> {
    const sys = await this.systemContextId();
    return (await this.contexts.createContext(CONTEXT_LEVELS.USER, userId, sys)).id;
  }

  /**
   * Suy context neo theo scope: personal → context của tác giả; org/school →
   * context hệ thống. Với org, kiểm tra cohort tồn tại và (khi `forWrite`)
   * tác giả là thành viên của tổ.
   */
  private async resolveContext(actorId: string, scope: string, spaceId?: string | null): Promise<string> {
    if (scope === 'personal') return this.personalContextId(actorId);
    if (scope === 'org') {
      if (!spaceId) throw new BadRequestException({ message: 'Org scope requires spaceId (cohort id)', code: 'contentbank.space_required' });
      const cohortRow = await this.repo.getCohort(spaceId);
      if (!cohortRow) throw new BadRequestException({ message: `Cohort ${spaceId} not found`, code: 'contentbank.space_not_found' });
      return this.systemContextId();
    }
    return this.systemContextId();
  }

  private async assertOrgMembership(actorId: string, spaceId: string): Promise<void> {
    if (!(await this.repo.isCohortMember(spaceId, actorId))) {
      throw new ForbiddenException({ message: 'You are not a member of this department (cohort)', code: 'contentbank.not_org_member' });
    }
  }

  /**
   * Người duyệt (tổ trưởng):
   * - scope tổ: có `contentbank:reviewcontent` VÀ `cohort:manage` tại
   *   context của chính tổ đó — giáo viên thường (editingteacher) là
   *   thành viên tổ KHÔNG tự thành người duyệt; tổ trưởng là người được
   *   gán vai quản lý tại context của tổ. Site admin qua bypass.
   * - scope trường: có reviewcontent tại context hệ thống.
   */
  async canReview(userId: string, row: ContentRow): Promise<boolean> {
    if (row.scope === 'org' && row.spaceId) {
      const cohortRow = await this.repo.getCohort(row.spaceId);
      if (!cohortRow) return false;
      return (
        (await this.evaluator.hasCapability(userId, 'contentbank:reviewcontent', cohortRow.contextId)) &&
        (await this.evaluator.hasCapability(userId, 'cohort:manage', cohortRow.contextId))
      );
    }
    return this.evaluator.hasCapability(userId, 'contentbank:reviewcontent', await this.systemContextId());
  }

  // --- quyền xem ---------------------------------------------------------------

  /**
   * Ai được xem một học liệu:
   * - tác giả: luôn được;
   * - người có editcontent tại context neo: được (quản trị);
   * - tổ/trường đã duyệt (approved): thành viên tổ (org) / người có
   *   viewcontent tại hệ thống (school);
   * - tổ/trường chưa duyệt: chỉ tác giả + người duyệt — KHÔNG lộ ra ngoài,
   *   kể cả khi visibility bị đặt public thủ công;
   * - cá nhân (gồm các bản ghi kiểu cũ neo ở context khoá): giữ hành vi
   *   nền cũ — public + viewcontent tại context neo thì xem được.
   */
  async canView(userId: string, row: ContentRow): Promise<boolean> {
    if (row.creatorId === userId) return true;
    if (row.scope === 'org' || row.scope === 'school') {
      // Kho chia sẻ KHÔNG dùng lối tắt editcontent tại context neo (neo ở
      // hệ thống nên mọi vai trò cấp hệ thống sẽ lọt): chưa duyệt chỉ tác
      // giả + người duyệt; đã duyệt mới mở cho đúng đối tượng của scope.
      // Site admin vẫn qua được nhờ bypass trong evaluator (canReview).
      if (await this.canReview(userId, row)) return true;
      if (row.reviewStatus !== 'approved') return false;
      if (row.scope === 'org') return row.spaceId ? this.repo.isCohortMember(row.spaceId, userId) : false;
      return this.evaluator.hasCapability(userId, 'contentbank:viewcontent', await this.systemContextId());
    }
    if (await this.evaluator.hasCapability(userId, 'contentbank:editcontent', row.contextId)) return true;
    return row.visibility === 'public' && this.evaluator.hasCapability(userId, 'contentbank:viewcontent', row.contextId);
  }

  async getFor(userId: string, id: string): Promise<ContentRow> {
    const row = await this.get(id);
    if (!(await this.canView(userId, row))) throw new ForbiddenException({ message: 'You cannot view this content bank item', code: 'contentbank.view_denied' });
    return row;
  }

  // --- không gian của người dùng ----------------------------------------------

  /** Các không gian người dùng thấy ở Kho học liệu: của tôi + các tổ là thành viên (+ mọi tổ nếu là người duyệt) + toàn trường. */
  async listSpaces(userId: string): Promise<SpaceView[]> {
    const sys = await this.systemContextId();
    const schoolReviewer = await this.evaluator.hasCapability(userId, 'contentbank:reviewcontent', sys);
    const orgReview = async (contextId: string): Promise<boolean> =>
      (await this.evaluator.hasCapability(userId, 'contentbank:reviewcontent', contextId)) &&
      (await this.evaluator.hasCapability(userId, 'cohort:manage', contextId));
    const byId = new Map<string, SpaceView>();
    for (const c of await this.repo.listCohortsForUser(userId)) {
      byId.set(c.id, { scope: 'org', spaceId: c.id, name: c.name, canReview: await orgReview(c.contextId) });
    }
    // Chỉ người quản trị cohort ở cấp hệ thống mới thấy MỌI tổ; tổ trưởng
    // chỉ thấy tổ của mình (đúng phạm vi duyệt của họ).
    if (await this.evaluator.hasCapability(userId, 'cohort:manage', sys)) {
      for (const c of await this.repo.listAllCohorts()) {
        if (!byId.has(c.id)) byId.set(c.id, { scope: 'org', spaceId: c.id, name: c.name, canReview: await orgReview(c.contextId) });
      }
    }
    return [
      { scope: 'personal', spaceId: null, name: 'Của tôi', canReview: false },
      ...byId.values(),
      { scope: 'school', spaceId: null, name: 'Toàn trường', canReview: schoolReviewer },
    ];
  }

  // --- CRUD ---------------------------------------------------------------------

  /** Ép các enum metadata mới (CB1-B1/B2/B3) — giá trị lạ bị từ chối sớm với mã lỗi riêng. */
  private assertEnumFields(input: Partial<LibraryItemInput>): void {
    const checks: [string | undefined, readonly string[], string][] = [
      [input.level, LEVELS, 'contentbank.bad_level'],
      [input.sourceKind, SOURCE_KINDS, 'contentbank.bad_source_kind'],
      [input.targetAudience, TARGET_AUDIENCES, 'contentbank.bad_target_audience'],
      [input.lessonPosition, LESSON_POSITIONS, 'contentbank.bad_lesson_position'],
    ];
    for (const [value, allowed, code] of checks) {
      if (value !== undefined && !allowed.includes(value)) {
        throw new BadRequestException({ message: `Unknown value ${value}`, code });
      }
    }
  }

  /** Giới hạn độ sâu duyệt chuỗi dẫn xuất khi chống vòng (CB1-B1). */
  private static readonly DERIVED_CHAIN_MAX_DEPTH = 32;

  /**
   * Kiểm tra `derivedFromId` (CB1-B1): đích phải tồn tại, không được là
   * chính bản ghi đang ghi, và chuỗi dẫn xuất của đích không được có vòng
   * (kể cả vòng quay về chính bản ghi). Không có các chặn này, học liệu
   * trường khai sourceKind='derived' có thể trỏ về chính mình để đạt yêu
   * cầu "phải có derivedFromId" khi gửi duyệt — làm rỗng cổng B1.
   */
  private async assertDerivedFromValid(selfId: string | null, derivedFromId: string): Promise<void> {
    if (selfId && derivedFromId === selfId) {
      throw new BadRequestException({ message: 'An item cannot be derived from itself', code: 'contentbank.derived_from_self_reference' });
    }
    let current = await this.repo.get(derivedFromId);
    if (!current) {
      throw new BadRequestException({ message: `Derived-from item ${derivedFromId} not found`, code: 'contentbank.derived_from_not_found' });
    }
    const visited = new Set<string>(selfId ? [selfId, derivedFromId] : [derivedFromId]);
    for (let depth = 0; current.derivedFromId; depth++) {
      const nextId = current.derivedFromId;
      if (visited.has(nextId) || depth >= ContentBankService.DERIVED_CHAIN_MAX_DEPTH) {
        throw new BadRequestException({ message: `Derived-from chain is cyclic or too deep at item ${nextId}`, code: 'contentbank.derived_from_cycle' });
      }
      visited.add(nextId);
      const next = await this.repo.get(nextId);
      if (!next) break; // Đích của một mắt xích đã bị xoá (FK set null chưa kịp áp) — chuỗi đứt là hợp lệ.
      current = next;
    }
  }

  async create(actorId: string, input: LibraryItemInput): Promise<ContentRow> {
    const scope = input.scope ?? 'personal';
    if (!SCOPES.includes(scope as never)) throw new BadRequestException({ message: `Unknown scope ${scope}`, code: 'contentbank.bad_scope' });
    if (input.resourceType && !RESOURCE_TYPES.includes(input.resourceType as never)) {
      throw new BadRequestException({ message: `Unknown resourceType ${input.resourceType}`, code: 'contentbank.bad_resource_type' });
    }
    this.assertEnumFields(input);
    if (input.derivedFromId) await this.assertDerivedFromValid(null, input.derivedFromId);
    if (scope === 'org' && input.spaceId) await this.assertOrgMembership(actorId, input.spaceId);
    const contextId = input.contextId ?? (await this.resolveContext(actorId, scope, input.spaceId));
    await this.evaluator.requireCapability(actorId, 'contentbank:upload', contextId);
    const row = await this.repo.insert({
      name: input.name, contextId, creatorId: actorId,
      contentType: input.contentType ?? 'file-based',
      // Học liệu chia sẻ luôn bắt đầu ở draft (chỉ public sau khi duyệt).
      visibility: scope === 'personal' ? (input.visibility ?? 'draft') : 'draft',
      fileId: input.fileId ?? null,
      resourceType: input.resourceType ?? 'reference', scope, spaceId: scope === 'org' ? (input.spaceId ?? null) : null,
      subjectId: input.subjectId ?? null, grade: input.grade ?? null, level: input.level ?? null,
      curriculumNodeId: input.curriculumNodeId ?? null,
      outcomeIds: input.outcomeIds ?? null, questionCategoryId: input.questionCategoryId ?? null,
      externalUrl: input.externalUrl ?? null,
      description: input.description ?? null, keywords: input.keywords ?? null,
      targetAudience: input.targetAudience ?? null, lessonPosition: input.lessonPosition ?? null,
      techFormat: input.techFormat ?? null, sizeBytes: input.sizeBytes ?? null,
      durationSeconds: input.durationSeconds ?? null, language: input.language ?? 'vi',
      originalAuthor: input.originalAuthor ?? null, sourceKind: input.sourceKind ?? null,
      sourceCitation: input.sourceCitation ?? null, license: input.license ?? null,
      derivedFromId: input.derivedFromId ?? null,
      // Cá nhân không qua duyệt; chia sẻ lên tổ/trường bắt đầu ở draft chờ gửi duyệt.
      reviewStatus: scope === 'personal' ? 'approved' : 'draft',
    });
    if (row.visibility === 'public' && row.reviewStatus === 'approved') await this.search.indexItem('contentbank', row.id);
    return row;
  }

  /** Liệt kê theo bộ lọc Kho học liệu; vẫn hỗ trợ contextId kiểu cũ. Mọi dòng đều qua canView. */
  async listFor(userId: string, filters: ContentFilters & { contextId?: string } = {}): Promise<ContentRow[]> {
    const rows = filters.contextId
      ? await this.repo.listByContext(filters.contextId)
      : await this.repo.listFiltered(filters);
    const out: ContentRow[] = [];
    for (const row of rows) if (await this.canView(userId, row)) out.push(row);
    return out;
  }

  private async assertCanEdit(actorId: string, row: ContentRow): Promise<void> {
    if (row.creatorId === actorId) return;
    await this.evaluator.requireCapability(actorId, 'contentbank:editcontent', row.contextId);
  }

  async update(actorId: string, id: string, input: Partial<LibraryItemInput>): Promise<ContentRow> {
    const row = await this.get(id);
    await this.assertCanEdit(actorId, row);
    const scope = input.scope ?? row.scope;
    if (!SCOPES.includes(scope as never)) throw new BadRequestException({ message: `Unknown scope ${scope}`, code: 'contentbank.bad_scope' });
    const spaceId = scope === 'org' ? (input.spaceId ?? row.spaceId) : null;
    if (scope === 'org' && spaceId && spaceId !== row.spaceId) await this.assertOrgMembership(actorId, spaceId);
    // Đổi scope thì neo lại context (cá nhân neo theo context của CHỦ SỞ HỮU,
    // không theo người đang sửa); giữ nguyên scope thì giữ context cũ.
    const contextId = scope !== row.scope ? await this.resolveContext(row.creatorId, scope, spaceId) : row.contextId;
    this.assertEnumFields(input);
    if (input.resourceType && !RESOURCE_TYPES.includes(input.resourceType as never)) {
      throw new BadRequestException({ message: `Unknown resourceType ${input.resourceType}`, code: 'contentbank.bad_resource_type' });
    }
    // Kiểm kể cả khi derivedFromId không đổi so với bản ghi hiện tại: dữ
    // liệu cũ (trước khi có chặn) có thể đã chứa tự tham chiếu/vòng.
    if (input.derivedFromId) await this.assertDerivedFromValid(id, input.derivedFromId);
    const changes: Partial<typeof row> = {
      name: input.name ?? row.name,
      visibility: input.visibility ?? row.visibility,
      fileId: input.fileId ?? row.fileId,
      resourceType: input.resourceType ?? row.resourceType,
      scope, spaceId, contextId,
      subjectId: input.subjectId ?? row.subjectId,
      grade: input.grade ?? row.grade,
      level: input.level ?? row.level,
      curriculumNodeId: input.curriculumNodeId ?? row.curriculumNodeId,
      outcomeIds: input.outcomeIds ?? row.outcomeIds,
      questionCategoryId: input.questionCategoryId ?? row.questionCategoryId,
      externalUrl: input.externalUrl ?? row.externalUrl,
      description: input.description ?? row.description,
      keywords: input.keywords ?? row.keywords,
      targetAudience: input.targetAudience ?? row.targetAudience,
      lessonPosition: input.lessonPosition ?? row.lessonPosition,
      techFormat: input.techFormat ?? row.techFormat,
      sizeBytes: input.sizeBytes ?? row.sizeBytes,
      durationSeconds: input.durationSeconds ?? row.durationSeconds,
      language: input.language ?? row.language,
      originalAuthor: input.originalAuthor ?? row.originalAuthor,
      sourceKind: input.sourceKind ?? row.sourceKind,
      sourceCitation: input.sourceCitation ?? row.sourceCitation,
      license: input.license ?? row.license,
      derivedFromId: input.derivedFromId ?? row.derivedFromId,
    };
    // Học liệu chia sẻ đã/chờ duyệt mà bị sửa (nội dung, metadata, phạm vi)
    // thì quay về draft để duyệt lại — duyệt là trên đúng bản đang chia sẻ.
    if (scope !== 'personal' && (row.reviewStatus === 'approved' || row.reviewStatus === 'pending')) {
      changes.reviewStatus = 'draft';
      changes.reviewedBy = null;
      changes.reviewedAt = null;
      changes.reviewNote = null;
      changes.reviewChecklist = null;
      if (row.reviewStatus === 'approved') changes.visibility = 'draft';
    }
    if (scope === 'personal') changes.reviewStatus = 'approved';
    // Bất biến của kho chia sẻ: chưa duyệt thì không được public — kể cả
    // khi client gửi visibility public thủ công (tránh lộ qua tìm kiếm).
    if (scope !== 'personal' && changes.reviewStatus !== 'approved') changes.visibility = 'draft';
    await this.repo.update(id, changes);
    const updated = await this.get(id);
    if (updated.visibility === 'public' && updated.reviewStatus === 'approved') await this.search.indexItem('contentbank', updated.id);
    else await this.search.removeDoc('contentbank', updated.id);
    return updated;
  }

  async remove(actorId: string, id: string): Promise<void> {
    const row = await this.get(id);
    await this.assertCanEdit(actorId, row);
    await this.repo.remove(id);
    await this.search.removeDoc('contentbank', id);
  }

  /** Upload file qua FilesModule và gắn vào nội dung. */
  async uploadFile(actorId: string, id: string, input: { fileName: string; contentBase64: string; mimeType?: string }): Promise<ContentRow> {
    const row = await this.get(id);
    await this.assertCanEdit(actorId, row);
    const data = Buffer.from(input.contentBase64, 'base64');
    const file = await this.files.upload({
      contextId: row.contextId, component: 'core_contentbank', fileArea: 'content', itemId: row.id,
      fileName: input.fileName, data, mimeType: input.mimeType, userId: actorId,
    });
    // Metadata kỹ thuật tự sinh từ file thật (CB1-B2): định dạng theo đuôi
    // file + dung lượng đúng số byte đã tải lên.
    const ext = input.fileName.includes('.') ? input.fileName.split('.').pop()!.toLowerCase() : null;
    await this.repo.update(id, { fileId: file.id, sizeBytes: data.length, ...(ext ? { techFormat: ext } : {}) });
    // Thay file của học liệu đã/chờ duyệt → quay về draft chờ duyệt lại.
    if (row.scope !== 'personal' && (row.reviewStatus === 'approved' || row.reviewStatus === 'pending')) {
      await this.repo.update(id, { reviewStatus: 'draft', reviewedBy: null, reviewedAt: null, reviewNote: null, reviewChecklist: null, visibility: row.reviewStatus === 'approved' ? 'draft' : row.visibility });
      await this.search.removeDoc('contentbank', id);
    }
    return this.get(id);
  }

  /** Signed URL của file đính kèm — FilesModule tự re-check quyền file. */
  async signedUrl(actorId: string, id: string): Promise<{ url: string; expiresAt: number }> {
    const row = await this.getFor(actorId, id);
    if (!row.fileId) throw new NotFoundException({ message: 'Content has no file', code: 'contentbank.no_file' });
    return this.files.createSignedUrl(row.fileId, actorId);
  }

  // --- duyệt (tổ trưởng) ---------------------------------------------------------

  /**
   * Metadata bắt buộc khi chia sẻ lên tổ/trường:
   * - chương trình: môn – khối – node chương trình; bộ câu hỏi tham chiếu
   *   phải có category (hoặc file bài tập); loại khác phải có file hoặc
   *   liên kết ngoài;
   * - sư phạm (CB1-B3): mô tả, từ khoá, đối tượng sử dụng, gợi ý vị trí
   *   dùng trong bài (khung CV 5512);
   * - bản quyền (CB1-B1) — CHỈ scope trường: tác giả gốc, nguồn gốc,
   *   giấy phép; nguồn trích dẫn thì phải ghi nguồn cụ thể, học liệu dẫn
   *   xuất thì phải trỏ về học liệu gốc. Thiếu là chưa được mở scope
   *   trường (yêu cầu cứng của TT 09/2021 Điều 4.3, thể lệ QĐ 2915/2021
   *   và QĐ 1965/QĐ-TTg về tôn trọng quyền tác giả).
   */
  private assertMetadataComplete(row: ContentRow): void {
    const missing: string[] = [];
    if (!row.subjectId) missing.push('subjectId');
    if (!row.grade) missing.push('grade');
    if (!row.curriculumNodeId) missing.push('curriculumNodeId');
    if (row.resourceType === 'question_set' && !row.questionCategoryId && !row.fileId) missing.push('questionCategoryId|fileId');
    if (row.resourceType !== 'question_set' && !row.fileId && !row.externalUrl) missing.push('fileId|externalUrl');
    if (!row.description?.trim()) missing.push('description');
    if (!row.keywords || (row.keywords as string[]).length === 0) missing.push('keywords');
    if (!row.targetAudience) missing.push('targetAudience');
    if (!row.lessonPosition) missing.push('lessonPosition');
    if (row.scope === 'school') {
      if (!row.originalAuthor?.trim()) missing.push('originalAuthor');
      if (!row.sourceKind) missing.push('sourceKind');
      if (!row.license?.trim()) missing.push('license');
      if (row.sourceKind === 'cited' && !row.sourceCitation?.trim()) missing.push('sourceCitation');
      if (row.sourceKind === 'derived' && !row.derivedFromId) missing.push('derivedFromId');
    }
    if (missing.length) {
      throw new BadRequestException({ message: `Missing required program metadata: ${missing.join(', ')}`, code: 'contentbank.metadata_incomplete' });
    }
  }

  /** Gửi duyệt: chỉ scope org/school, từ draft/rejected, metadata phải đủ. */
  async submitForReview(actorId: string, id: string): Promise<ContentRow> {
    const row = await this.get(id);
    await this.assertCanEdit(actorId, row);
    if (row.scope === 'personal') throw new BadRequestException({ message: 'Personal items do not need review', code: 'contentbank.submit_not_needed' });
    if (row.reviewStatus !== 'draft' && row.reviewStatus !== 'rejected') {
      throw new BadRequestException({ message: `Cannot submit from status ${row.reviewStatus}`, code: 'contentbank.bad_review_transition' });
    }
    this.assertMetadataComplete(row);
    await this.repo.update(id, { reviewStatus: 'pending', reviewNote: null });
    return this.get(id);
  }

  /**
   * Duyệt/từ chối một học liệu đang chờ (pending). Theo CB1-B3: từ chối
   * BẮT BUỘC có lý do (ghi chú); phê duyệt BẮT BUỘC checklist 4 tiêu chí
   * của thể lệ Bộ đều đạt (nội dung chính xác–khoa học / nguồn gốc rõ
   * ràng / sư phạm–thẩm mỹ / chạy được trên di động) — checklist được
   * lưu cùng quyết định để truy vết.
   */
  async review(actorId: string, id: string, input: { decision: 'approved' | 'rejected'; note?: string; checklist?: ReviewChecklist }): Promise<ContentRow> {
    const row = await this.get(id);
    if (row.scope === 'personal' || row.reviewStatus !== 'pending') {
      throw new BadRequestException({ message: 'Item is not pending review', code: 'contentbank.not_pending' });
    }
    if (!(await this.canReview(actorId, row))) {
      throw new ForbiddenException({ message: 'You cannot review this item', code: 'contentbank.review_denied' });
    }
    if (input.decision === 'rejected' && !input.note?.trim()) {
      throw new BadRequestException({ message: 'Rejection requires a reason (note)', code: 'contentbank.review_note_required' });
    }
    if (input.decision === 'approved') {
      const c = input.checklist;
      if (!c || !c.contentAccurate || !c.sourceClear || !c.pedagogyAesthetics || !c.mobileReady) {
        throw new BadRequestException({ message: 'Approval requires the full review checklist (all criteria met)', code: 'contentbank.review_checklist_incomplete' });
      }
    }
    await this.repo.update(id, {
      reviewStatus: input.decision, reviewedBy: actorId, reviewedAt: new Date(), reviewNote: input.note ?? null,
      reviewChecklist: input.checklist ?? null,
      visibility: input.decision === 'approved' ? 'public' : 'draft',
    });
    const updated = await this.get(id);
    if (input.decision === 'approved') await this.search.indexItem('contentbank', updated.id);
    else await this.search.removeDoc('contentbank', updated.id);
    return updated;
  }

  // --- điểm cắm "Thêm từ kho" ------------------------------------------------------

  /**
   * Cắm học liệu vào một section của khoá: tạo course module `mod_resource`
   * bằng BẢN SAO file (file được sao sang context của module mới — sửa ở
   * kho không đổi bản đã cắm và ngược lại). Quyền: xem được học liệu (và
   * nếu là học liệu chia sẻ của người khác thì phải đã duyệt) + quyền thêm
   * hoạt động vào khoá (do CoursesService.createCm tự gác
   * course:manageactivities).
   */
  async insertIntoCourse(actorId: string, id: string, input: { courseId: string; sectionId: string }): Promise<{ cmId: string; courseId: string; sectionId: string; fileId: string | null; sourceContentId: string }> {
    const row = await this.get(id);
    if (!(await this.canView(actorId, row))) throw new ForbiddenException({ message: 'You cannot view this content bank item', code: 'contentbank.view_denied' });
    if (row.creatorId !== actorId && row.reviewStatus !== 'approved') {
      throw new ForbiddenException({ message: 'Only approved library items can be inserted into a course', code: 'contentbank.not_approved' });
    }
    if (row.resourceType === 'question_set' && !row.fileId) {
      // Bộ câu hỏi THAM CHIẾU (có category, không có file) sống ở Ngân
      // hàng câu hỏi — không cắm thành tài nguyên khoá. Học liệu nhóm câu
      // hỏi/bài tập có file đính kèm (phiếu bài tập) thì cắm như tài
      // nguyên bình thường.
      throw new BadRequestException({ message: 'Question-set references are used from the question bank, not inserted as course resources', code: 'contentbank.question_set_not_insertable' });
    }
    const cm = await this.courses.createCm(actorId, input.courseId, { sectionId: input.sectionId, component: 'mod_resource', name: row.name });
    const cmContextId = await this.courses.cmContextId(cm.id);
    let copiedFileId: string | null = null;
    if (row.fileId) {
      const { file, data } = await this.files.readContent(row.fileId);
      const copy = await this.files.upload({
        contextId: cmContextId!, component: 'mod_resource', fileArea: 'content', itemId: cm.id,
        fileName: file.fileName, data, mimeType: file.mimeType ?? undefined, userId: actorId,
      });
      copiedFileId = copy.id;
    } else if (row.externalUrl) {
      // Học liệu liên kết: bản sao trong khoá là file .url trỏ về liên kết gốc
      // (mod_url chuyên dụng thuộc lát sau); nội dung kho không bị phụ thuộc.
      const shortcut = Buffer.from(`[InternetShortcut]\r\nURL=${row.externalUrl}\r\n`, 'utf8');
      const copy = await this.files.upload({
        contextId: cmContextId!, component: 'mod_resource', fileArea: 'content', itemId: cm.id,
        fileName: `${row.name}.url`, data: shortcut, mimeType: 'text/plain', userId: actorId,
      });
      copiedFileId = copy.id;
    }
    return { cmId: cm.id, courseId: input.courseId, sectionId: input.sectionId, fileId: copiedFileId, sourceContentId: row.id };
  }
}
