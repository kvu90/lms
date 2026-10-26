import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API Curriculum (port từ giaokhoa, chương trình GDPT 2018):
 * subjects → curricula (duy nhất theo cặp môn + khối 1–12) →
 * curriculum_nodes (cây) → learning_outcomes (yêu cầu cần đạt).
 * Môn học neo vào một context (như question category của ngân hàng câu hỏi):
 * quyền đọc/ghi quyết qua PermissionEvaluator tại context đó, không theo
 * sở hữu cá nhân.
 */

/**
 * Cấp của một node trong cây nội dung: mạch nội dung / chủ đề / nội dung.
 * 'lesson' là **nội dung của chương trình** GDPT 2018 (không phải
 * chương/bài SGK — SGK thuộc tầng ánh xạ riêng ngoài cây chuẩn, mục A.4).
 */
export const curriculumNodeKindSchema = z.enum(['strand', 'topic', 'lesson']);
export type CurriculumNodeKind = z.infer<typeof curriculumNodeKindSchema>;

const positionSchema = z.number().int().positive();
const durationPeriodsSchema = z.number().int().min(0).nullable();
const durationPercentSchema = z.number().min(0).max(100).nullable();

/** Payload tạo môn học trong một context. Slug là mã đường dẫn duy nhất toàn hệ. */
export const createSubjectSchema = z.strictObject({
  contextId: uuidIdSchema,
  name: z.string().min(1),
  slug: z.string().min(1),
  position: positionSchema.optional(),
});
export type CreateSubject = z.infer<typeof createSubjectSchema>;

/** Payload sửa môn học; context neo quyền không đổi qua API này. */
export const updateSubjectSchema = z.strictObject({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  position: positionSchema.optional(),
});
export type UpdateSubject = z.infer<typeof updateSubjectSchema>;

/** Payload tạo chương trình của một môn ở một khối (1–12); mỗi cặp môn + khối chỉ có một chương trình. */
export const createCurriculumSchema = z.strictObject({
  subjectId: uuidIdSchema,
  grade: z.number().int().min(1).max(12),
});
export type CreateCurriculum = z.infer<typeof createCurriculumSchema>;

/** Payload sửa chương trình; chỉ khối là đổi được (đổi môn = tạo chương trình khác). */
export const updateCurriculumSchema = z.strictObject({
  grade: z.number().int().min(1).max(12).optional(),
});
export type UpdateCurriculum = z.infer<typeof updateCurriculumSchema>;

/**
 * Payload tạo node trong cây nội dung của một chương trình. Node gốc để
 * parentId trống; kind mặc định 'topic' — node cấp mạch dùng kind 'strand'.
 * durationPeriods là thời lượng dự kiến theo tiết, durationPercent là tỉ
 * trọng % thời lượng của node trong chương trình (căn cứ tỉ lệ điểm ma trận).
 */
export const createCurriculumNodeSchema = z.strictObject({
  curriculumId: uuidIdSchema,
  parentId: uuidIdSchema.nullable().optional(),
  title: z.string().min(1),
  kind: curriculumNodeKindSchema.optional(),
  position: positionSchema.optional(),
  durationPeriods: durationPeriodsSchema.optional(),
  durationPercent: durationPercentSchema.optional(),
});
export type CreateCurriculumNode = z.infer<typeof createCurriculumNodeSchema>;

/** Payload sửa node; parentId đặt tường minh (null = đưa lên node gốc). */
export const updateCurriculumNodeSchema = z.strictObject({
  parentId: uuidIdSchema.nullable().optional(),
  title: z.string().min(1).optional(),
  kind: curriculumNodeKindSchema.optional(),
  position: positionSchema.optional(),
  durationPeriods: durationPeriodsSchema.optional(),
  durationPercent: durationPercentSchema.optional(),
});
export type UpdateCurriculumNode = z.infer<typeof updateCurriculumNodeSchema>;

/**
 * Nguồn của một YCCĐ (Chặng 2, mục A.3): 'program' = chép nguyên văn
 * Chương trình môn học của Bộ; 'derived' = tổ chuyên môn biên tập/tách
 * theo mức từ một YCCĐ gốc (ghi ở derivedFromId).
 */
export const outcomeSourceKindSchema = z.enum(['program', 'derived']);
export type OutcomeSourceKind = z.infer<typeof outcomeSourceKindSchema>;

/** Payload tạo yêu cầu cần đạt (learning outcome) dưới một node nội dung. */
export const createLearningOutcomeSchema = z.strictObject({
  nodeId: uuidIdSchema,
  content: z.string().min(1),
  position: positionSchema.optional(),
  sourceKind: outcomeSourceKindSchema.optional(),
  sourceRef: z.string().min(1).nullable().optional(),
  derivedFromId: uuidIdSchema.nullable().optional(),
});
export type CreateLearningOutcome = z.infer<typeof createLearningOutcomeSchema>;

/** Payload sửa yêu cầu cần đạt. */
export const updateLearningOutcomeSchema = z.strictObject({
  content: z.string().min(1).optional(),
  position: positionSchema.optional(),
  sourceKind: outcomeSourceKindSchema.optional(),
  sourceRef: z.string().min(1).nullable().optional(),
  derivedFromId: uuidIdSchema.nullable().optional(),
});
export type UpdateLearningOutcome = z.infer<typeof updateLearningOutcomeSchema>;

/**
 * Mức độ nhận thức của cặp (câu hỏi × YCCĐ) — Chặng 2, mục A.2: mức nằm
 * trên dòng nối câu–YCCĐ, không nằm trên câu hỏi/phiên bản. Khoá text:
 * khung 3 mức hiện hành cho trung học (Biết/Hiểu/Vận dụng) cộng
 * 'van_dung_cao' dự phòng cho biến thể 4 mức.
 */
export const cognitiveLevelSchema = z.enum(['biet', 'hieu', 'van_dung', 'van_dung_cao']);
export type CognitiveLevel = z.infer<typeof cognitiveLevelSchema>;

/** Payload gắn một câu hỏi vào một môn học (mức môn, chưa gắn YCCĐ cụ thể). */
export const attachQuestionSubjectSchema = z.strictObject({
  subjectId: uuidIdSchema,
});
export type AttachQuestionSubject = z.infer<typeof attachQuestionSubjectSchema>;

/** Payload gắn một câu hỏi vào một YCCĐ kèm mức độ nhận thức của cặp đó. */
export const attachQuestionOutcomeSchema = z.strictObject({
  outcomeId: uuidIdSchema,
  cognitiveLevel: cognitiveLevelSchema,
});
export type AttachQuestionOutcome = z.infer<typeof attachQuestionOutcomeSchema>;

/** Payload đổi mức độ nhận thức của một dòng nối câu–YCCĐ đã gắn. */
export const updateQuestionOutcomeLinkSchema = z.strictObject({
  cognitiveLevel: cognitiveLevelSchema,
});
export type UpdateQuestionOutcomeLink = z.infer<typeof updateQuestionOutcomeLinkSchema>;

/**
 * Nạp dữ liệu chương trình chuẩn (K0a): dataset là một file bản ghi đã
 * kiểm chứng nguyên văn với văn bản ban hành kèm Thông tư 32/2018 (ví dụ
 * Toán, Ngữ văn). `datasetKey` là khoá ổn định của dataset trong manifest
 * phía máy chủ — môn nào có dataset đã kiểm chứng mới nạp được môn đó.
 */
export const importProgramDatasetSchema = z.strictObject({
  datasetKey: z.string().min(1),
});
export type ImportProgramDataset = z.infer<typeof importProgramDatasetSchema>;

/** Trạng thái nạp của một dataset: đã nạp bao nhiêu trên tổng số bản ghi đã kiểm chứng. */
export const programDatasetStatusSchema = z.object({
  datasetKey: z.string(),
  subjectName: z.string(),
  slug: z.string(),
  grades: z.array(z.number().int()),
  totalRecords: z.number().int(),
  importedRecords: z.number().int(),
  subjectId: uuidIdSchema.nullable(),
  lastImportedAt: z.string().nullable(),
});
export type ProgramDatasetStatus = z.infer<typeof programDatasetStatusSchema>;

/**
 * Loại thay đổi của một dòng YCCĐ trong một lượt nạp dataset (đợt neo
 * lại định danh theo vị trí, issue #161): `text-changed` = sửa chữ tại
 * chỗ giữ id và mọi liên kết; `added` = dòng mới của dataset;
 * `removed` = dòng rời chương trình hiện hành (được rút, không xoá);
 * `moved` = văn không đổi, chỉ xô vị trí vì chèn/bớt dòng khác;
 * `revived` = dòng đã rút được hồi sinh vì nguyên văn quay lại.
 */
export const programImportChangeKindSchema = z.enum(['text-changed', 'added', 'removed', 'moved', 'revived']);
export type ProgramImportChangeKind = z.infer<typeof programImportChangeKindSchema>;

/**
 * Một mục thay đổi theo từng dòng YCCĐ trong báo cáo của một lượt nạp
 * — sản phẩm cho người duyệt đối chiếu "lần nạp này Bộ đã sửa những
 * dòng nào" (áp dụng ngay rồi báo cáo, KHÔNG duyệt hai cấp). `position`
 * là vị trí trong dataset MỚI; với `removed` là vị trí cuối cùng trước
 * khi rút. `shiftSuspected` gắn khi ca sửa chữ có thể đã ghép nhầm
 * dòng vì vừa sửa chữ vừa xô lệch; `identicalTextAmbiguous` gắn ở ca
 * rút trong nhóm dòng trùng hệt nhau (không phân định được bằng văn
 * bản — quy ước giữ dòng ở vị trí thấp). Số liên kết chỉ đếm tại thời
 * điểm nạp cho `removed` và `text-changed` — hai ca người duyệt phải
 * nhìn thấy ảnh hưởng lên câu hỏi/ánh xạ sách đang trỏ vào dòng.
 */
export const programImportChangeSchema = z.object({
  recordId: z.string(),
  position: z.number().int(),
  kind: programImportChangeKindSchema,
  oldText: z.string().optional(),
  newText: z.string().optional(),
  generation: z.number().int().optional(),
  shiftSuspected: z.boolean().optional(),
  identicalTextAmbiguous: z.boolean().optional(),
  linkedQuestions: z.number().int().optional(),
  linkedBookMappings: z.number().int().optional(),
});
export type ProgramImportChange = z.infer<typeof programImportChangeSchema>;

/**
 * Kết quả một lượt nạp dataset: tạo mới / cập nhật (dataset đính
 * chính) / bỏ qua (đã khớp) + báo cáo thay đổi của lần nạp. Luật
 * không-xoá giữ nguyên: node của bản ghi đã rút khỏi dataset đếm ở
 * `orphanedNodes` và được GIỮ NGUYÊN trong DB; YCCĐ rời dataset nay
 * chuyển sang trạng thái ĐÃ RÚT lưu ở DB (`retiredOutcomes` là tổng số
 * dòng đang rút của dataset sau lần nạp) thay cho đếm orphaned cũ —
 * pool sinh đề và bản đặc tả nhờ đó phân biệt được hiện hành/đã rút.
 * `changes` bị cắt ở trần 500 mục mỗi lượt nạp một dataset (số bị cắt
 * ở `changesOmitted`); `changeCounts` luôn đầy đủ cả sáu đếm.
 */
export const programImportResultSchema = z.object({
  datasetKey: z.string(),
  subjectId: uuidIdSchema,
  totalRecords: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  outcomesWritten: z.number().int(),
  orphanedNodes: z.number().int(),
  retiredOutcomes: z.number().int(),
  changeCounts: z.object({
    textChanged: z.number().int(),
    added: z.number().int(),
    removed: z.number().int(),
    moved: z.number().int(),
    revived: z.number().int(),
    shiftSuspected: z.number().int(),
  }),
  changes: z.array(programImportChangeSchema),
  changesOmitted: z.number().int(),
});
export type ProgramImportResult = z.infer<typeof programImportResultSchema>;

/**
 * Một YCCĐ chụp trong neo khung của section: nội dung chép nguyên văn
 * tại thời điểm nạp (hiển thị trong khoá từ bản chụp này, không đọc lại
 * cây chương trình); `outcomeId` là truy vết về YCCĐ gốc, null khi gốc
 * đã bị xoá.
 */
export const courseSectionFrameOutcomeSchema = z.object({
  outcomeId: uuidIdSchema.nullable(),
  content: z.string(),
});
export type CourseSectionFrameOutcome = z.infer<typeof courseSectionFrameOutcomeSchema>;

/**
 * Neo khung chương trình của một section (K0a): section là bản sao độc
 * lập, neo ghi node nguồn + tựa chụp; sửa cây chương trình sau đó không
 * đổi section đã nạp.
 */
export const courseSectionFrameSchema = z.object({
  nodeId: uuidIdSchema.nullable(),
  nodeTitle: z.string(),
  outcomes: z.array(courseSectionFrameOutcomeSchema),
});
export type CourseSectionFrame = z.infer<typeof courseSectionFrameSchema>;

/**
 * Payload nạp khung chương trình vào khoá: mỗi node được chọn (đơn vị
 * chủ đề/mạch — node không phải `lesson`) thành một section mang toàn bộ
 * YCCĐ trong subtree của nó, theo thứ tự cây. `insertAtSection` là số
 * thứ tự section muốn chèn vào trước (≥ 1; section 0 là section chung
 * không bị đẩy); bỏ trống = nối vào cuối outline.
 */
export const applyCurriculumFrameSchema = z.strictObject({
  curriculumId: uuidIdSchema,
  nodeIds: z.array(uuidIdSchema).min(1),
  insertAtSection: z.number().int().min(1).optional(),
});
export type ApplyCurriculumFrame = z.infer<typeof applyCurriculumFrameSchema>;

