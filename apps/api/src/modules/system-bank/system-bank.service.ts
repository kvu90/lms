/**
 * Service của kho ngân hàng hệ thống (issue #585): bản chính tập trung
 * của Ngân hàng câu hỏi hệ thống trên database riêng phía platform.
 *
 * Luồng nghiệp vụ chính:
 * - Phát hành (quản trị platform): tạo câu kèm phiên bản đầu tiên,
 *   hoặc tạo phiên bản mới cho câu đã có — mỗi phiên bản mang gói tự
 *   đủ + checksum SHA-256 do server tự tính trên dạng chuẩn hoá của
 *   gói; nội dung phiên bản cũ không bao giờ bị ghi đè. Liên kết YCCĐ
 *   trong gói là ẢNH CHỤP tại thời điểm phát hành (bảng liên kết của
 *   kho nghiệp vụ gắn theo câu, không theo version): sửa liên kết mà
 *   không phát hành version mới thì gói cũ không đổi — muốn làm mới
 *   gói thì phát hành version mới.
 * - Kiểm chứng gói theo dạng câu ở mức thô (không lặp lại toàn bộ
 *   chuẩn hoá sâu của module câu hỏi — kiểm chứng Tiptap sâu xảy ra
 *   ở lúc nhập vào kho trung tâm qua `QuestionsService`):
 *   multichoice đúng 4 lựa chọn + đúng 1 đáp án đúng; truefalse TF-A
 *   không mang dòng đáp án; shortanswer ít nhất 1 đáp án và mọi dòng
 *   đều là đáp án được chấp nhận; essay không mang dòng đáp án.
 * - Rút câu (quản trị platform): đổi metadata trạng thái của câu
 *   thành `withdrawn` (tách khỏi nội dung phiên bản — các phiên bản cũ
 *   vẫn đọc lại nguyên vẹn), ghi sự kiện `question_withdrawn` vào
 *   nhật ký append-only, và trả về danh sách slug các trung tâm đã
 *   nhập câu để tầng trên phát thông báo (kênh sự kiện platform).
 * - Đọc: câu + từng phiên bản + phiên bản mới nhất, kèm checksum để
 *   phía nhập kiểm chứng trước khi ghi bản chụp. Vì gói chứa đáp án
 *   và khoá đáp án, đường đọc nội dung gói đi qua cổng người xem
 *   `question:useall` tại context hệ thống (xem
 *   `assertPackageViewer`) — khác đường khám phá chỉ trả metadata.
 *
 * Mọi thao tác đều cần kho ngân hàng đã cấu hình
 * (`SYSTEM_BANK_DATABASE_URL`); chưa cấu hình thì repository ném
 * `system_bank.not_configured` (503). Mọi thao tác ghi gác bằng
 * capability quản trị platform hiện hữu (`tenant:manage` tại context
 * hệ thống — site admin vượt qua cổng này theo lối tắt của evaluator);
 * tầng này không sinh capability mới.
 */
import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { curricula, curriculumNodes, learningOutcomes, subjects } from '@lms/db';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { tenantAls } from '../tenants/tenant-als';
import { TenantDbService } from '../tenants/tenant-db.service';
import type { RichTextInput, SystemBankPackage } from '@lms/contracts';
import { QuestionsService, type QuestionContentInput } from '../questions/questions.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { canonicalizeJson, checksumPackage, packageValidationError, verifyPackageChecksum } from './system-bank-package';
import { SystemBankCentreRepository } from './system-bank-centre.repository';
import { SystemBankConnection } from './system-bank.connection';
import { SystemBankRepository } from './system-bank.repository';
import type {
  CreateSystemBankQuestionDto,
  CreateSystemBankVersionDto,
  CreateSystemOutcomePackageDto,
  DiscoverSystemBankQuestionsDto,
  ImportSystemBankQuestionDto,
  WithdrawSystemBankQuestionDto,
} from './dto/system-bank.dto';

/** Bóc lỗi vi phạm unique của PostgreSQL (23505) dù Drizzle có bọc qua cause hay không. */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (e !== null && typeof e === 'object') {
    if ((e as { code?: unknown }).code === '23505') {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

@Injectable()
export class SystemBankService {
  constructor(
    private readonly repo: SystemBankRepository,
    private readonly centreRepo: SystemBankCentreRepository,
    private readonly connection: SystemBankConnection,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly tenantDb: TenantDbService,
    private readonly questions: QuestionsService,
    private readonly banks: QuestionBanksService,
  ) {}

  /** Kho ngân hàng đã được cấu hình kết nối hay chưa. */
  get isConfigured(): boolean {
    return this.connection.isConfigured;
  }

  /**
   * Gác quản trị platform: chỉ người giữ `tenant:manage` tại context
   * hệ thống mới được phát hành/rút câu — cùng helper với bề mặt quản
   * trị tenant và control plane hiện hữu.
   */
  private async assertPlatformManager(actorId: string): Promise<void> {
    const systemId = (await this.contexts.ensureSystemContext()).id;
    await this.evaluator.requireCapability(actorId, 'tenant:manage', systemId);
  }

  /**
   * Gác người xem cho các đường đọc NỘI DUNG GÓI (câu + từng phiên
   * bản): gói mang đáp án và khoá đáp án nên đường đọc đi qua cổng
   * người xem `question:useall` theo chuẩn cổng đọc câu hỏi của hệ
   * (issue #55). Ngữ cảnh gác là context HỆ THỐNG — câu hệ thống là
   * nội dung platform, không thuộc category hay ngữ cảnh của bất kỳ
   * trung tâm nào (cùng ngữ cảnh mà đường phát hành gác bằng
   * `tenant:manage` ở trên). Không có quyền thì trả 404
   * `system_bank.question_not_found` như câu không tồn tại: không lộ
   * sự tồn tại của câu lẫn gói cho người không được xem (học sinh,
   * phụ huynh không có `question:useall` trong registry capability).
   */
  private async assertPackageViewer(actorId: string, questionId: string): Promise<void> {
    const systemId = (await this.contexts.ensureSystemContext()).id;
    const canView = await this.evaluator
      .hasCapability(actorId, 'question:useall', systemId)
      .catch(() => false);
    if (!canView) {
      throw new NotFoundException({
        message: `System question ${questionId} not found`,
        code: 'system_bank.question_not_found',
      });
    }
  }

  /**
   * Gác người nhận sự kiện cho hai đường sự kiện phía trung tâm
   * (liệt kê sự kiện chưa ghi nhận + ghi nhận sự kiện): sự kiện rút
   * câu là thông báo vận hành của TRUNG TÂM, không phải dữ kiện của
   * từng thành viên — chỉ người giữ `question:useall` tại context
   * hệ thống (cùng cổng với các đường đọc nội dung gói, xem
   * `assertPackageViewer`) mới được xem và ghi nhận thay trung
   * tâm. Đường sự kiện không gắn với một câu cụ thể nên chỉ kiểm
   * capability thuần, không kiểm sự tồn tại của gói; trượt cổng thì
   * ném 403 `access.capability_denied` như các cổng
   * `requireCapability` khác trong module. Cổng luôn chạy TRƯỚC
   * mọi thao tác đọc/ghi của hai đường này: người trượt cổng không
   * thấy danh sách và tuyệt đối không để lại vết ghi nhận — nếu
   * không, bất kỳ thành viên nào của trung tâm (kể cả học sinh)
   * cũng ghi nhận thay được và sự kiện biến khỏi danh sách chờ của
   * giáo viên cùng trung tâm, thông báo rút câu bị tiêu thụ bởi
   * sai người.
   */
  private async assertEventViewer(actorId: string): Promise<void> {
    const systemId = (await this.contexts.ensureSystemContext()).id;
    await this.evaluator.requireCapability(actorId, 'question:useall', systemId);
  }

  /**
   * Kiểm chứng gói theo dạng câu ở mức thô (luật ở
   * `packageValidationError` trong `system-bank-package.ts`).
   * @throws BadRequestException `system_bank.bad_package` khi gói vi
   * phạm luật của dạng câu.
   */
  private assertPackageForQtype(qtype: string, pkg: SystemBankPackage): void {
    const error = packageValidationError(qtype, pkg);
    if (error) {
      throw new BadRequestException({ message: error, code: 'system_bank.bad_package' });
    }
  }

  /** Phát hành câu hỏi hệ thống mới kèm phiên bản đầu tiên (nguyên tử). */
  async publishQuestion(actorId: string, dto: CreateSystemBankQuestionDto) {
    await this.assertPlatformManager(actorId);
    this.assertPackageForQtype(dto.qtype, dto.package);
    const checksum = checksumPackage(dto.package);
    return this.repo.createQuestionWithFirstVersion({
      id: dto.id,
      qtype: dto.qtype,
      createdBy: actorId,
      package: dto.package,
      checksum,
    });
  }

  /** Phát hành phiên bản mới cho câu đã có (câu chưa rút mới được phát hành tiếp). */
  async publishVersion(actorId: string, questionId: string, dto: CreateSystemBankVersionDto) {
    await this.assertPlatformManager(actorId);
    const question = await this.repo.getQuestion(questionId);
    if (!question) {
      throw new NotFoundException({ message: `System question ${questionId} not found`, code: 'system_bank.question_not_found' });
    }
    if (question.status === 'withdrawn') {
      throw new BadRequestException({
        message: `System question ${questionId} is withdrawn and cannot receive new versions`,
        code: 'system_bank.question_withdrawn',
      });
    }
    this.assertPackageForQtype(question.qtype, dto.package);
    const checksum = checksumPackage(dto.package);
    return this.repo.createVersion(questionId, dto.package, checksum);
  }

  /**
   * Rút câu hỏi: đổi trạng thái + ghi sự kiện + trả về slug các trung
   * tâm đã nhập (để tầng trên phát thông báo qua kênh sự kiện
   * platform). Rút câu đã rút là thao tác idempotent ở mức trạng thái
   * nhưng vẫn ghi thêm một sự kiện — tránh rút trùng, service từ chối
   * rút lần hai.
   */
  async withdrawQuestion(actorId: string, questionId: string, dto: WithdrawSystemBankQuestionDto) {
    await this.assertPlatformManager(actorId);
    const question = await this.repo.getQuestion(questionId);
    if (!question) {
      throw new NotFoundException({ message: `System question ${questionId} not found`, code: 'system_bank.question_not_found' });
    }
    if (question.status === 'withdrawn') {
      throw new BadRequestException({
        message: `System question ${questionId} is already withdrawn`,
        code: 'system_bank.question_withdrawn',
      });
    }
    const updated = await this.repo.markWithdrawn(questionId, { reason: dto.reason, by: actorId });
    if (!updated) {
      throw new NotFoundException({ message: `System question ${questionId} not found`, code: 'system_bank.question_not_found' });
    }
    const event = await this.repo.recordEvent({
      type: 'question_withdrawn',
      sourceQuestionId: questionId,
      payload: { reason: dto.reason, withdrawnBy: actorId, withdrawnAt: new Date().toISOString() },
    });
    const notifiedCentres = await this.repo.listImporterSlugs(questionId);
    return { question: updated, event, notifiedCentres };
  }

  /**
   * Đọc một câu hỏi hệ thống (mọi trạng thái — cả câu đã rút vẫn
   * đọc được để đối chiếu). Qua cổng người xem gói trước khi đọc
   * (xem `assertPackageViewer`).
   */
  async getQuestion(actorId: string, questionId: string) {
    await this.assertPackageViewer(actorId, questionId);
    const question = await this.repo.getQuestion(questionId);
    if (!question) {
      throw new NotFoundException({ message: `System question ${questionId} not found`, code: 'system_bank.question_not_found' });
    }
    return question;
  }

  /** Đọc một phiên bản kèm checksum (phía nhập dùng để kiểm chứng gói trước khi ghi). Qua cổng người xem gói. */
  async getVersion(actorId: string, questionId: string, version: number) {
    await this.assertPackageViewer(actorId, questionId);
    const row = await this.repo.getVersionByNumber(questionId, version);
    if (!row) {
      throw new NotFoundException({
        message: `System question ${questionId} version ${version} not found`,
        code: 'system_bank.version_not_found',
      });
    }
    return row;
  }

  /** Liệt kê mọi phiên bản của một câu theo thứ tự số tăng dần. Qua cổng người xem gói. */
  async listVersions(actorId: string, questionId: string) {
    await this.getQuestion(actorId, questionId);
    return this.repo.listVersions(questionId);
  }

  /** Đọc phiên bản mới nhất của một câu (phía khám phá dùng để biết bản đang phát hành). Qua cổng người xem gói. */
  async getLatestVersion(actorId: string, questionId: string) {
    await this.getQuestion(actorId, questionId);
    const row = await this.repo.getLatestVersion(questionId);
    if (!row) {
      throw new NotFoundException({
        message: `System question ${questionId} has no versions`,
        code: 'system_bank.version_not_found',
      });
    }
    return row;
  }

  /**
   * Khám phá câu hỏi hệ thống đang phát hành: chỉ câu có trạng thái
   * `published` mới xuất hiện (câu đã rút biến khỏi khám phá ngay).
   * Kết quả trả định danh nguồn + danh sách mọi phiên bản của câu để
   * giáo viên chọn đúng phiên bản cần nhập. Lọc theo YCCĐ/mức độ
   * khớp khi BẤT KỲ phiên bản nào của câu mang liên kết đó (phiên bản
   * cũ vẫn nhập được). Không sinh capability mới: đường này chỉ yêu
   * cầu người gọi đã xác thực và đang ở trong ngữ cảnh một trung tâm
   * (tenant hiệu lực); cổng `question:add` áp ở lúc nhập, không áp
   * ở lúc xem.
   */
  async discover(query: DiscoverSystemBankQuestionsDto) {
    const store = tenantAls.getStore();
    if (!store?.tenantId && !store?.spaceSlug) {
      throw new ForbiddenException({
        message: 'System bank discovery requires a centre context',
        code: 'system_bank.centre_context_required',
      });
    }
    const entries = await this.repo.listPublishedQuestionsWithVersions({
      qtype: query.qtype,
      outcomeId: query.outcomeId,
      cognitiveLevel: query.cognitiveLevel,
    });
    const total = entries.length;
    const page = entries.slice(query.offset, query.offset + query.limit);
    return {
      items: page.map((entry) => ({
        id: entry.question.id,
        qtype: entry.question.qtype,
        status: entry.question.status,
        createdAt: entry.question.createdAt,
        versions: entry.versions.map((version) => ({
          version: version.version,
          checksum: version.checksum,
          createdAt: version.createdAt,
        })),
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Suy slug trung tâm của request hiện tại cho dòng importer: ưu
   * tiên slug kho riêng trong ngữ cảnh ALS (trung tâm đã ở kho riêng),
   * nếu không thì tra slug của tenant hiệu lực trong kho nghiệp vụ
   * (thế giới kho chung). Không suy được thì fail-closed — nhập bản
   * chụp bắt buộc phải gắn với đúng một trung tâm.
   */
  private async resolveCentreSlug(): Promise<string> {
    const store = tenantAls.getStore();
    if (store?.spaceSlug) return store.spaceSlug;
    if (store?.tenantId) {
      const slug = await this.centreRepo.resolveTenantSlug(store.tenantId);
      if (slug) return slug;
    }
    throw new BadRequestException({
      message: 'System bank import requires a centre context',
      code: 'system_bank.centre_context_required',
    });
  }

  /**
   * Nhập bản chụp một phiên bản câu hỏi hệ thống vào kho trung tâm
   * (đường duy nhất đưa câu hệ thống vào đề/bank của trung tâm —
   * đường thi không bao giờ đọc trực tiếp từ kho ngân hàng):
   * 1. Câu phải đang phát hành; phiên bản vắng thì lấy mới nhất.
   * 2. Tính lại checksum của gói và đối chiếu với checksum đã lưu:
   *    lệch thì từ chối, không ghi gì vào kho trung tâm.
   * 3. Mọi YCCĐ trong gói phải đã có trong bản cài YCCĐ cục bộ của
   *    trung tâm — thiếu thì fail-closed kèm danh sách id thiếu (trung
   *    tâm cập nhật gói YCCĐ trước rồi nhập lại), không nhập nửa vời.
   * 4. Đích nhập theo đúng đường copy câu hiện hữu: mặc định bank cá
   *    nhân của người nhập; đích tường minh phải thuộc về bank đó;
   *    cổng `question:add` tại category đích.
   * 5. Ghi dòng importer SAU khi đích và cổng quyền đã qua, TRƯỚC
   *    khi ghi câu vào kho trung tâm (upsert idempotent): nhập bị từ
   *    chối ở đích/quyền thì KHÔNG để lại dòng importer — trung tâm
   *    chưa từng nhập không bị thông báo rút câu oan. Lỗi tạo câu
   *    sau điểm này để lại dòng importer thừa lành tính (thông báo
   *    rút câu tới trung tâm chưa nhập thành công), đối chiếu được
   *    bằng dòng truy vết nhập phía trung tâm vốn chỉ ghi khi tạo
   *    câu xong.
   * 6. Tạo câu trung tâm qua `QuestionsService` (đi qua chuẩn hoá nội
   *    dung + cổng quyền như câu soạn tay) — ngữ liệu trong gói (nếu
   *    có) được tạo mới trong category đích trước — gắn các liên kết
   *    YCCĐ của gói, rồi ghi dòng truy vết nhập (kind `pristine`,
   *    phiên bản nguyên trạng = version 1 của câu mới).
   * Hai kho (ngân hàng + trung tâm) không có transaction chung: thứ
   * tự trên bảo đảm lỗi ở bước nào cũng để lại trạng thái lành tính
   * và ghi rõ trong thân PR.
   */
  async importSystemQuestion(actorId: string, dto: ImportSystemBankQuestionDto) {
    const centreSlug = await this.resolveCentreSlug();
    const question = await this.repo.getQuestion(dto.sourceQuestionId);
    if (!question) {
      throw new NotFoundException({
        message: `System question ${dto.sourceQuestionId} not found`,
        code: 'system_bank.question_not_found',
      });
    }
    if (question.status !== 'published') {
      throw new BadRequestException({
        message: `System question ${dto.sourceQuestionId} is withdrawn and cannot be imported`,
        code: 'system_bank.question_withdrawn',
      });
    }
    const version = dto.sourceVersionNumber !== undefined
      ? await this.repo.getVersionByNumber(dto.sourceQuestionId, dto.sourceVersionNumber)
      : await this.repo.getLatestVersion(dto.sourceQuestionId);
    if (!version) {
      throw new NotFoundException({
        message: `System question ${dto.sourceQuestionId} version ${dto.sourceVersionNumber ?? 'latest'} not found`,
        code: 'system_bank.version_not_found',
      });
    }
    const pkg = version.package as SystemBankPackage;
    if (!verifyPackageChecksum(pkg, version.checksum)) {
      throw new BadRequestException({
        message: `System question ${dto.sourceQuestionId} version ${version.version} failed checksum verification`,
        code: 'system_bank.checksum_mismatch',
      });
    }
    const missingOutcomes: string[] = [];
    for (const outcome of pkg.outcomes) {
      if (!(await this.centreRepo.outcomeExists(outcome.outcomeId))) {
        missingOutcomes.push(outcome.outcomeId);
      }
    }
    if (missingOutcomes.length > 0) {
      throw new BadRequestException({
        message: `System bank import blocked: centre has not installed outcomes: ${missingOutcomes.join(', ')}`,
        code: 'system_bank.outcome_not_installed',
      });
    }
    const targetBank = dto.targetBankId
      ? await this.banks.getBankOrThrow(dto.targetBankId)
      : await this.banks.ensurePersonalBank(actorId, 'question', { forCopy: true });
    if (await this.banks.isForeignPersonalBank(actorId, targetBank)) {
      throw new NotFoundException({ message: `Question bank ${targetBank.id} not found`, code: 'question.bank_not_found' });
    }
    let targetCategory;
    if (dto.targetCategoryId) {
      targetCategory = await this.questions.getCategory(dto.targetCategoryId);
      if (!(await this.banks.categoryBelongsToBank(targetCategory, targetBank))) {
        throw new BadRequestException({
          message: 'Target category does not belong to the target bank',
          code: 'question.copy_target_category_mismatch',
        });
      }
    } else {
      targetCategory = await this.banks.defaultCategoryOfBank(targetBank);
    }
    await this.evaluator.requireCapability(actorId, 'question:add', targetCategory.contextId);
    // Chỉ khi đích và cổng quyền đã qua mới ghi dòng importer (bước
    // 5 trong flow ở đầu hàm): nhập bị từ chối ở trên không để lại
    // vết nhập nào ở phía ngân hàng.
    await this.repo.recordImporter({
      sourceQuestionId: dto.sourceQuestionId,
      centreSlug,
      importedBy: actorId,
    });
    const stimulusId = pkg.stimulusContent
      ? (await this.questions.createStimulus(actorId, {
          categoryId: targetCategory.id,
          content: pkg.stimulusContent as RichTextInput,
        })).id
      : null;
    const content: QuestionContentInput = {
      questionText: pkg.questionText as RichTextInput,
      generalFeedback: (pkg.generalFeedback ?? undefined) as RichTextInput | undefined,
      guidance: (pkg.answerKey?.guidance ?? undefined) as RichTextInput | undefined,
      stimulusId,
      answers: pkg.answers.map((answer) => ({
        text: answer.answer as RichTextInput,
        correct: answer.isCorrect,
        feedback: (answer.feedback ?? undefined) as RichTextInput | undefined,
      })),
      options: (pkg.options ?? undefined) as QuestionContentInput['options'],
      solution: pkg.answerKey?.solution
        ? (pkg.answerKey.solution as QuestionContentInput['solution'])
        : undefined,
    };
    const created = await this.questions.createQuestion(actorId, {
      categoryId: targetCategory.id,
      qtype: question.qtype,
      ...content,
    });
    for (const outcome of pkg.outcomes) {
      await this.questions.attachOutcome(actorId, created.question.id, outcome.outcomeId, outcome.cognitiveLevel);
    }
    const importRow = await this.centreRepo.insertImportRow({
      questionId: created.question.id,
      sourceQuestionId: dto.sourceQuestionId,
      sourceVersionId: version.id,
      sourceVersionNumber: version.version,
      packageChecksum: version.checksum,
      importedVersionNumber: 1,
      importedBy: actorId,
      kind: 'pristine',
    });
    return { question: created, import: importRow, source: { questionId: question.id, version: version.version } };
  }

  /**
   * Liệt kê các sự kiện kho ngân hàng mà trung tâm hiện tại CHƯA ghi
   * nhận — đường giao thông báo phía trung tâm (hiện tại là sự kiện
   * rút câu):
   * 1. Suy slug trung tâm của request (fail-closed khi không có ngữ
   *    cảnh trung tâm, như đường nhập).
   * 2. Chỉ sự kiện về các câu CHÍNH trung tâm này đã nhập mới thuộc
   *    diện giao: tập câu lấy từ sổ importer phía ngân hàng, sự
   *    kiện lấy từ nhật ký append-only theo tập câu đó.
   * 3. Loại các sự kiện đã có vết ghi nhận của chính trung tâm này
   *    (bảng receipts trong kho trung tâm) — trung tâm khác ghi
   *    nhận không làm sự kiện biến khỏi danh sách của trung tâm này.
   * Trung tâm biết định danh sự kiện TỪ CHÍNH danh sách này rồi gọi
   * đường ghi nhận; không cần (và không có) kênh nào khác để biết id
   * sự kiện. Trước mọi bước trên, người gọi phải qua cổng
   * `assertEventViewer` (`question:useall` tại context hệ thống):
   * danh sách là thông báo vận hành của trung tâm, không mở cho
   * mọi thành viên của trung tâm.
   */
  async listPendingEvents(actorId: string) {
    await this.assertEventViewer(actorId);
    const centreSlug = await this.resolveCentreSlug();
    const questionIds = await this.repo.listImportedQuestionIds(centreSlug);
    if (questionIds.length === 0) return [];
    const events = await this.repo.listEventsForQuestions(questionIds);
    if (events.length === 0) return [];
    const received = new Set(await this.centreRepo.listEventReceiptEventIds(centreSlug));
    return events.filter((event) => !received.has(event.id));
  }

  /**
   * Ghi nhận trung tâm đã nhận một sự kiện kho ngân hàng (hiện tại là
   * sự kiện rút câu): idempotent theo cặp sự kiện + slug trung tâm.
   * Trung tâm gọi sau khi nhận thông báo rút câu qua kênh sự kiện
   * platform; vết này để platform đối chiếu trung tâm nào đã nhận.
   * Người gọi phải qua cổng `assertEventViewer` (`question:useall`
   * tại context hệ thống) TRƯỚC khi ghi: trượt cổng thì không có
   * vết ghi nhận nào được tạo, sự kiện vẫn nằm nguyên trong danh
   * sách chờ của trung tâm.
   */
  async acknowledgeEvent(actorId: string, eventId: string) {
    await this.assertEventViewer(actorId);
    const centreSlug = await this.resolveCentreSlug();
    return this.centreRepo.insertEventReceipt({ eventId, centreSlug });
  }

  /**
   * Phát hành một gói YCCĐ phía platform (quản trị platform): chụp cây
   * chương trình hiện hành từ kho nghiệp vụ trong ngữ cảnh platform
   * (một transaction đọc nhất quán) rồi ghi nguyên trạng vào kho ngân
   * hàng kèm checksum trên JSON canonical của toàn bộ items.
   * - Phạm vi `all`: toàn bộ cây; phạm vi slug môn: chỉ môn đó (môn
   *   không có ở cây platform thì 404).
   * - Chỉ chụp YCCĐ chuẩn platform (tenantId NULL) và đang hiện hành
   *   (retiredAt NULL): YCCĐ đã rút khỏi chương trình không được hồi
   *   sinh qua gói; YCCĐ derived thuộc trung tâm không phải nội dung
   *   platform nên không nằm trong gói.
   * - Môn học không nằm trong gói (môn mang context phân quyền, thuộc
   *   dữ kiện nền của trung tâm): gói chỉ mang subjectSlug để bản cài
   *   giải quyết môn ở trung tâm.
   * - Định danh phiên bản trùng thì 409 (không ghi đè gói đã phát hành).
   */
  async createOutcomePackage(actorId: string, dto: CreateSystemOutcomePackageDto) {
    await this.assertPlatformManager(actorId);
    const snapshot = await this.tenantDb.withPlatform(async (tx) => {
      const subjectRows =
        dto.scope === 'all'
          ? await tx.select().from(subjects)
          : await tx.select().from(subjects).where(eq(subjects.slug, dto.scope));
      if (dto.scope !== 'all' && subjectRows.length === 0) {
        throw new NotFoundException({
          message: `Subject ${dto.scope} not found in the platform programme`,
          code: 'curriculum.subject_not_found',
        });
      }
      const subjectIds = subjectRows.map((row) => row.id);
      const curriculumRows =
        subjectIds.length === 0
          ? []
          : await tx.select().from(curricula).where(inArray(curricula.subjectId, subjectIds));
      const curriculumIds = curriculumRows.map((row) => row.id);
      const nodeRows =
        curriculumIds.length === 0
          ? []
          : await tx.select().from(curriculumNodes).where(inArray(curriculumNodes.curriculumId, curriculumIds));
      const nodeIds = nodeRows.map((row) => row.id);
      const outcomeRows =
        nodeIds.length === 0
          ? []
          : await tx
              .select()
              .from(learningOutcomes)
              .where(
                and(
                  inArray(learningOutcomes.nodeId, nodeIds),
                  isNull(learningOutcomes.tenantId),
                  isNull(learningOutcomes.retiredAt),
                ),
              );
      return { subjectRows, curriculumRows, nodeRows, outcomeRows };
    });
    const subjectSlugById = new Map(snapshot.subjectRows.map((row) => [row.id, row.slug]));
    const packageCurricula = snapshot.curriculumRows.map((row) => ({
      curriculumId: row.id,
      subjectSlug: subjectSlugById.get(row.subjectId) ?? '',
      grade: row.grade,
    }));
    const packageNodes = snapshot.nodeRows.map((row) => ({
      nodeId: row.id,
      curriculumId: row.curriculumId,
      parentId: row.parentId,
      title: row.title,
      kind: row.kind,
      position: row.position,
      durationPeriods: row.durationPeriods,
      durationPercent: row.durationPercent,
    }));
    const packageOutcomes = snapshot.outcomeRows.map((row) => ({
      outcomeId: row.id,
      nodeId: row.nodeId,
      position: row.position,
      content: row.content,
      sourceKind: row.sourceKind,
      sourceRef: row.sourceRef,
    }));
    const checksum = createHash('sha256')
      .update(
        canonicalizeJson({
          curricula: packageCurricula,
          nodes: packageNodes,
          outcomes: packageOutcomes,
          mappings: dto.mappings,
        }),
      )
      .digest('hex');
    try {
      const pkg = await this.repo.createPackageWithItems({
        version: dto.version,
        scope: dto.scope,
        checksum,
        outcomeCount: packageOutcomes.length,
        createdBy: actorId,
        curricula: packageCurricula,
        nodes: packageNodes,
        outcomes: packageOutcomes,
        mappings: dto.mappings,
      });
      return { package: pkg, counts: { curricula: packageCurricula.length, nodes: packageNodes.length, outcomes: packageOutcomes.length } };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({
          message: `Outcome package version ${dto.version} already exists`,
          code: 'system_bank.package_version_exists',
        });
      }
      throw err;
    }
  }

  /** Liệt kê các gói YCCĐ đã phát hành (mới nhất trước). */
  async listOutcomePackages() {
    return this.repo.listPackages();
  }

  /** Đọc một gói YCCĐ theo định danh phiên bản (kèm items). */
  async getOutcomePackage(version: string) {
    const pkg = await this.repo.getPackageByVersion(version);
    if (!pkg) {
      throw new NotFoundException({
        message: `Outcome package ${version} not found`,
        code: 'system_bank.package_not_found',
      });
    }
    const items = await this.repo.getPackageItems(pkg.id);
    return { package: pkg, ...items };
  }

  /**
   * Cài một gói YCCĐ vào kho trung tâm (trung tâm chủ động nhận gói
   * mới): upsert chương trình → node (cha trước, depth tính từ chuỗi
   * cha trong code vì bảng node gốc không có cột depth) → YCCĐ theo
   * id giữ nguyên, cập nhật nội dung tại chỗ. Vì gắn chuẩn trỏ theo
   * id nên cập nhật gói KHÔNG sửa ngược các gắn chuẩn đã có; ánh xạ
   * mã cũ→mã mới trong gói chỉ là thông tin tham chiếu.
   * - Gác quyền: `curriculum:manage` tại context của từng môn mà gói
   *   chạm tới trong kho trung tâm (đúng cổng ghi chương trình hiện
   *   hữu) — môn chưa có ở trung tâm thì fail-closed (trung tâm cần
   *   dữ kiện nền môn trước, thuộc bước cấp phát).
   * - Xung đột chương trình: trung tâm đã có chương trình (môn, khối)
   *   với id khác id gói thì fail-closed kèm cặp (slug môn, khối) —
   *   không tự gộp hai cây khác id.
   * - Gói hỏng (node cha vắng khỏi gói hoặc cha khác chương trình)
   *   thì fail-closed trước khi ghi.
   * - Ở thế giới kho chung, cây chương trình và vết cài là dùng chung
   *   giữa các trung tâm chung DB — cài theo trung tâm thật sự chỉ
   *   có sau khi #587 tách kho vật lý; int-spec chạy trên DB trung
   *   tâm riêng nên kiểm được ngữ nghĩa theo trung tâm.
   */
  async installOutcomePackage(actorId: string, version: string) {
    const pkg = await this.repo.getPackageByVersion(version);
    if (!pkg) {
      throw new NotFoundException({
        message: `Outcome package ${version} not found`,
        code: 'system_bank.package_not_found',
      });
    }
    const items = await this.repo.getPackageItems(pkg.id);
    const subjectsBySlug = new Map<string, { id: string; contextId: string }>();
    for (const curriculum of items.curricula) {
      if (!subjectsBySlug.has(curriculum.subjectSlug)) {
        const subject = await this.centreRepo.findSubjectBySlug(curriculum.subjectSlug);
        if (!subject) {
          throw new BadRequestException({
            message: `Centre has no subject ${curriculum.subjectSlug}; provision the centre foundation data first`,
            code: 'system_bank.subject_not_installed',
          });
        }
        subjectsBySlug.set(curriculum.subjectSlug, { id: subject.id, contextId: subject.contextId });
      }
    }
    for (const subject of subjectsBySlug.values()) {
      await this.evaluator.requireCapability(actorId, 'curriculum:manage', subject.contextId);
    }
    for (const curriculum of items.curricula) {
      const subject = subjectsBySlug.get(curriculum.subjectSlug)!;
      const existing = await this.centreRepo.findCurriculumBySubjectGrade(subject.id, curriculum.grade);
      if (existing && existing.id !== curriculum.curriculumId) {
        throw new ConflictException({
          message: `Centre already has a curriculum for subject ${curriculum.subjectSlug} grade ${curriculum.grade} with a different id`,
          code: 'system_bank.curriculum_conflict',
        });
      }
    }
    const nodesById = new Map(items.nodes.map((node) => [node.nodeId, node]));
    for (const node of items.nodes) {
      if (node.parentId !== null) {
        const parent = nodesById.get(node.parentId);
        if (!parent || parent.curriculumId !== node.curriculumId) {
          throw new BadRequestException({
            message: `Outcome package ${version} has a corrupt node tree (node ${node.nodeId})`,
            code: 'system_bank.bad_package',
          });
        }
      }
    }
    const depthOf = (nodeId: string, seen: Set<string>): number => {
      if (seen.has(nodeId)) {
        throw new BadRequestException({
          message: `Outcome package ${version} has a cyclic node tree`,
          code: 'system_bank.bad_package',
        });
      }
      const node = nodesById.get(nodeId)!;
      if (node.parentId === null) return 0;
      seen.add(nodeId);
      return depthOf(node.parentId, seen) + 1;
    };
    const nodesByDepth = [...items.nodes].sort(
      (a, b) => depthOf(a.nodeId, new Set()) - depthOf(b.nodeId, new Set()),
    );
    for (const curriculum of items.curricula) {
      const subject = subjectsBySlug.get(curriculum.subjectSlug)!;
      await this.centreRepo.upsertCurriculum({
        id: curriculum.curriculumId,
        subjectId: subject.id,
        grade: curriculum.grade,
      });
    }
    for (const node of nodesByDepth) {
      await this.centreRepo.upsertCurriculumNode({
        id: node.nodeId,
        curriculumId: node.curriculumId,
        parentId: node.parentId,
        title: node.title,
        kind: node.kind,
        position: node.position,
        durationPeriods: node.durationPeriods,
        durationPercent: node.durationPercent,
      });
    }
    for (const outcome of items.outcomes) {
      await this.centreRepo.upsertLearningOutcome({
        id: outcome.outcomeId,
        nodeId: outcome.nodeId,
        position: outcome.position,
        content: outcome.content,
        sourceKind: outcome.sourceKind,
        sourceRef: outcome.sourceRef,
      });
    }
    const previous = await this.centreRepo.getOutcomePackageInstall();
    const install = await this.centreRepo.recordOutcomePackageInstall({
      packageVersion: pkg.version,
      previousVersion: previous?.packageVersion ?? null,
      scope: pkg.scope,
      installedBy: actorId,
    });
    return {
      install,
      package: pkg,
      counts: { curricula: items.curricula.length, nodes: items.nodes.length, outcomes: items.outcomes.length },
    };
  }
}
