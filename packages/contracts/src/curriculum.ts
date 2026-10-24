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

/** Cấp của một node trong cây nội dung: mạch nội dung / chủ đề / bài–nội dung. */
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

/** Payload tạo yêu cầu cần đạt (learning outcome) dưới một node nội dung. */
export const createLearningOutcomeSchema = z.strictObject({
  nodeId: uuidIdSchema,
  content: z.string().min(1),
  position: positionSchema.optional(),
});
export type CreateLearningOutcome = z.infer<typeof createLearningOutcomeSchema>;

/** Payload sửa yêu cầu cần đạt. */
export const updateLearningOutcomeSchema = z.strictObject({
  content: z.string().min(1).optional(),
  position: positionSchema.optional(),
});
export type UpdateLearningOutcome = z.infer<typeof updateLearningOutcomeSchema>;
