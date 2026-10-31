import { z } from 'zod';
import { COGNITIVE_LEVELS } from './assessment.js';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của KHO NGÂN HÀNG HỆ THỐNG (issue #585, chương trình
 * tenant #579): bản chính tập trung của Ngân hàng câu hỏi hệ thống
 * trên database riêng phía platform — phiên bản bất biến, giáo viên
 * tìm câu qua API, khi đưa câu vào đề thì sao chép bản chụp đúng
 * phiên bản vào kho trung tâm kèm truy vết nguồn.
 *
 * Ranh giới nghiệp vụ của tầng này:
 * - Gói phiên bản là tài liệu JSON tự chứa: nội dung câu, đáp án +
 *   quy tắc chấm, phản hồi, ngữ liệu đi kèm (NỘI DUNG stimulus, không
 *   phải id — id stimulus thuộc kho nghiệp vụ nên không có nghĩa
 *   xuyên kho), tuỳ chọn theo dạng câu, và các liên kết YCCĐ của câu
 *   tại thời điểm đóng gói (mã chuẩn gốc + mức độ nhận thức từng
 *   liên kết). Media đi kèm nằm trong chính tài liệu Tiptap dưới dạng
 *   tham chiếu contentHash của object storage dùng chung nên không
 *   cần trường riêng.
 * - Các trường tài liệu Tiptap (`questionText`, `generalFeedback`,
 *   `stimulusContent`, `answer`, `feedback`) kiểm chứng ở mức cấu trúc
 *   lỏng (`z.unknown()`): hợp đồng khoá khung gói (các khoá bắt buộc,
 *   dạng câu, liên kết YCCĐ), còn nội dung tài liệu do tầng service
 *   kiểm chứng theo dạng câu khi phát hành — tránh hợp đồng vỡ vì một
 *   node Tiptap mới.
 * - Checksum KHÔNG do client cung cấp: server tự tính SHA-256 trên
 *   dạng chuẩn hoá của gói khi phát hành, lưu cùng phiên bản, và phía
 *   nhập kiểm chứng lại trước khi ghi bản chụp.
 * - Mọi thao tác ghi yêu cầu capability quản trị platform hiện hữu
 *   (`tenant:manage` tại context hệ thống — site admin vượt qua cổng
 *   này theo lối tắt của evaluator) — tầng này không dựng mô hình
 *   tài khoản quản trị riêng, không sinh capability mới.
 */
export const SYSTEM_BANK_QUESTION_TYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;

/** Một đáp án trong gói phiên bản: nội dung + đúng/sai + phản hồi riêng + thứ tự hiển thị. */
export const systemBankPackageAnswerSchema = z.strictObject({
  answer: z.unknown(),
  isCorrect: z.boolean(),
  feedback: z.unknown().nullable(),
  sortOrder: z.number().int(),
});
export type SystemBankPackageAnswer = z.infer<typeof systemBankPackageAnswerSchema>;

/** Một liên kết YCCĐ trong gói: id chuẩn gốc phía platform + mức độ nhận thức của liên kết. */
export const systemBankPackageOutcomeSchema = z.strictObject({
  outcomeId: uuidIdSchema,
  cognitiveLevel: z.enum(COGNITIVE_LEVELS),
});
export type SystemBankPackageOutcome = z.infer<typeof systemBankPackageOutcomeSchema>;

/** Gói phiên bản tự đủ của một câu hỏi hệ thống. */
export const systemBankPackageSchema = z.strictObject({
  questionText: z.unknown(),
  generalFeedback: z.unknown().nullable(),
  stimulusContent: z.unknown().nullable(),
  answers: z.array(systemBankPackageAnswerSchema),
  answerKey: z
    .strictObject({
      guidance: z.unknown().nullable(),
      solution: z.unknown().nullable(),
    })
    .nullable(),
  options: z.record(z.string(), z.unknown()).nullable(),
  outcomes: z.array(systemBankPackageOutcomeSchema),
});
export type SystemBankPackage = z.infer<typeof systemBankPackageSchema>;

/** Phát hành câu hỏi hệ thống mới kèm phiên bản đầu tiên (nguyên tử, cùng một transaction kho ngân hàng). */
export const createSystemBankQuestionSchema = z.strictObject({
  /** Id ổn định của câu — vắng thì server sinh uuidv7; đường di trú dữ kiện hiện hữu truyền id gốc để giữ truy vết. */
  id: uuidIdSchema.optional(),
  qtype: z.enum(SYSTEM_BANK_QUESTION_TYPES),
  package: systemBankPackageSchema,
});
export type CreateSystemBankQuestion = z.infer<typeof createSystemBankQuestionSchema>;

/** Phát hành phiên bản mới cho câu hỏi đã có (nội dung cũ không bị ghi đè). */
export const createSystemBankVersionSchema = z.strictObject({
  package: systemBankPackageSchema,
});
export type CreateSystemBankVersion = z.infer<typeof createSystemBankVersionSchema>;

/** Rút câu hỏi hệ thống: ngừng khám phá + ngừng nhập mới ngay, ghi sự kiện thông báo các trung tâm đã nhập. */
export const withdrawSystemBankQuestionSchema = z.strictObject({
  reason: z.string().min(1).max(500),
});
export type WithdrawSystemBankQuestion = z.infer<typeof withdrawSystemBankQuestionSchema>;

/**
 * Truy vấn khám phá câu hỏi hệ thống (chỉ câu đang phát hành):
 * lọc theo dạng câu, theo YCCĐ nguồn (outcomeId — vị trí chương trình
 * được suy qua YCCĐ: client duyệt cây chương trình qua API gói YCCĐ
 * rồi chọn chuẩn, không cần trường vị trí riêng trên câu hỏi), theo
 * mức độ nhận thức của liên kết. Phân trang bằng limit/offset (giới
 * hạn 100 như mọi danh sách khác của hệ).
 */
export const discoverSystemBankQuestionsSchema = z.strictObject({
  qtype: z.enum(SYSTEM_BANK_QUESTION_TYPES).optional(),
  outcomeId: uuidIdSchema.optional(),
  cognitiveLevel: z.enum(COGNITIVE_LEVELS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DiscoverSystemBankQuestions = z.infer<typeof discoverSystemBankQuestionsSchema>;

/**
 * Nhập bản chụp một phiên bản câu hỏi hệ thống vào kho trung tâm:
 * đích mặc định là bank cá nhân của người nhập (như đường copy câu
 * hiện hữu); đích tường minh phải là bank/category thuộc về bank đó.
 * Phiên bản vắng thì nhập phiên bản mới nhất đang phát hành.
 */
export const importSystemBankQuestionSchema = z.strictObject({
  sourceQuestionId: uuidIdSchema,
  sourceVersionNumber: z.coerce.number().int().min(1).optional(),
  targetBankId: uuidIdSchema.optional(),
  targetCategoryId: uuidIdSchema.optional(),
});
export type ImportSystemBankQuestion = z.infer<typeof importSystemBankQuestionSchema>;

/**
 * Phát hành một gói YCCĐ phía platform: định danh phiên bản (duy nhất
 * toàn kho, dạng `YYYY.MM.DD.N`) + phạm vi (`all` hoặc slug môn học).
 * Ánh xạ mã cũ→mã mới là thông tin tham chiếu kèm theo gói (từ YCCĐ
 * cũ sang YCCĐ mới khi tách/gộp/đổi vị trí) — bản cài không tự sửa
 * các gắn chuẩn cũ theo ánh xạ.
 */
export const createSystemOutcomePackageSchema = z.strictObject({
  version: z.string().min(1).max(50),
  scope: z.string().min(1).max(100),
  mappings: z
    .array(
      z.strictObject({
        fromOutcomeId: uuidIdSchema,
        toOutcomeId: uuidIdSchema,
        note: z.string().max(500).default(''),
      }),
    )
    .default([]),
});
export type CreateSystemOutcomePackage = z.infer<typeof createSystemOutcomePackageSchema>;
