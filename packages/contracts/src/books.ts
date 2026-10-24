import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API Books (K0b tái cấu trúc, issue #67): sách là thực thể độc
 * lập — không nằm dưới chương trình; chương trình GDPT 2018 chỉ liên
 * quan qua lớp ánh xạ `book_mappings`. `BOOK_KINDS` là danh sách loại
 * sách đã biết ở tầng app (mở rộng được bằng cách thêm giá trị ở đây;
 * DB không khoá cứng). `attributionPublic` là cờ bản quyền theo sách
 * (mặc định false): chỉ sách bật cờ mới được ghi công khai nguồn ở bề
 * mặt dùng chung.
 */
export const BOOK_KINDS = ['textbook', 'reference', 'workbook', 'other'] as const;
export type BookKind = (typeof BOOK_KINDS)[number];

/**
 * Nạp dữ liệu SGK (K0b): dataset là một file bản ghi đã kiểm chứng
 * nguyên văn với mục lục in trong cuốn SGK (ví dụ Toán 1). `datasetKey`
 * là khoá ổn định của dataset trong manifest phía máy chủ — sách nào có
 * dataset đã kiểm chứng mới nạp được sách đó. Hình dạng đối ứng của
 * `importProgramDatasetSchema` ở tầng chương trình.
 */
export const importBookDatasetSchema = z.strictObject({
  datasetKey: z.string().min(1),
});
export type ImportBookDataset = z.infer<typeof importBookDatasetSchema>;

/** Trạng thái nạp của một dataset SGK: đã nạp bao nhiêu trên tổng số bản ghi bài đã kiểm chứng, bao nhiêu bản ghi có ánh xạ. */
export const bookDatasetStatusSchema = z.object({
  datasetKey: z.string(),
  subjectName: z.string(),
  slug: z.string(),
  bookTitle: z.string(),
  grade: z.number().int(),
  totalRecords: z.number().int(),
  importedRecords: z.number().int(),
  mappedRecords: z.number().int(),
  bookId: uuidIdSchema.nullable(),
  subjectId: uuidIdSchema.nullable(),
  lastImportedAt: z.string().nullable(),
});
export type BookDatasetStatus = z.infer<typeof bookDatasetStatusSchema>;

/** Kết quả một lượt nạp dataset SGK: tạo mới / cập nhật (dataset đính chính) / bỏ qua (đã khớp) + số dòng ánh xạ đã ghi. */
export const bookImportResultSchema = z.object({
  datasetKey: z.string(),
  bookId: uuidIdSchema,
  subjectId: uuidIdSchema,
  totalRecords: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  mappingsWritten: z.number().int(),
});
export type BookImportResult = z.infer<typeof bookImportResultSchema>;

/** Một cuốn sách trong danh sách (hàng của bảng `books`). Môn/khối/series là metadata mô tả, nullable. */
export const bookSchema = z.object({
  id: uuidIdSchema,
  kind: z.string(),
  title: z.string(),
  subjectId: uuidIdSchema.nullable(),
  grade: z.number().int().nullable(),
  series: z.string().nullable(),
  author: z.string().nullable(),
  publisher: z.string().nullable(),
  publishedYear: z.number().int().nullable(),
  isbn: z.string().nullable(),
  attributionPublic: z.boolean(),
  position: z.number().int(),
});
export type Book = z.infer<typeof bookSchema>;

/**
 * Một đích ánh xạ của một bài SGK: đúng một trong hai trường đích có
 * giá trị — node nội dung của cây chương trình hoặc một YCCĐ cụ thể.
 * `programRecordId` là mã bản ghi chương trình (ví dụ TOAN-0001) khi
 * đích thuộc dataset chương trình đã nạp — định danh truy vết ổn định
 * cho người đọc, không phải khoá kỹ thuật.
 */
export const bookMappingViewSchema = z.object({
  curriculumNodeId: uuidIdSchema.nullable(),
  learningOutcomeId: uuidIdSchema.nullable(),
  programRecordId: z.string().nullable(),
  targetTitle: z.string().nullable(),
});
export type BookMappingView = z.infer<typeof bookMappingViewSchema>;

/** Một bài SGK trong cây sách, kèm ánh xạ và YCCĐ suy qua ánh xạ (đã khử trùng theo thứ tự ánh xạ). */
export const bookLessonViewSchema = z.object({
  id: uuidIdSchema,
  title: z.string(),
  volume: z.number().int().nullable(),
  lessonNumber: z.number().int().nullable(),
  position: z.number().int(),
  recordId: z.string().nullable(),
  mappings: z.array(bookMappingViewSchema),
  outcomes: z.array(z.object({ outcomeId: uuidIdSchema, content: z.string() })),
});
export type BookLessonView = z.infer<typeof bookLessonViewSchema>;

/** Một chủ đề SGK và các bài trong nó. */
export const bookChapterViewSchema = z.object({
  id: uuidIdSchema,
  title: z.string(),
  volume: z.number().int().nullable(),
  position: z.number().int(),
  lessons: z.array(bookLessonViewSchema),
});
export type BookChapterView = z.infer<typeof bookChapterViewSchema>;

/** Cây đầy đủ của một cuốn SGK cho bề mặt quản trị và bề mặt chọn khung. */
export const bookTreeViewSchema = z.object({
  book: bookSchema,
  subject: z.object({ id: uuidIdSchema, name: z.string(), slug: z.string() }).nullable(),
  chapters: z.array(bookChapterViewSchema),
});
export type BookTreeView = z.infer<typeof bookTreeViewSchema>;

/**
 * Payload nạp khung SGK vào khoá: mỗi chủ đề được chọn thành một
 * section, các bài trong chủ đề thành mục của section (neo kép: mục
 * truy về bài SGK và về YCCĐ chương trình qua bản chụp lúc nạp).
 * `insertAtSection` như ở khung chương trình.
 */
export const applyBookFrameSchema = z.strictObject({
  bookId: uuidIdSchema,
  chapterNodeIds: z.array(uuidIdSchema).min(1),
  insertAtSection: z.number().int().min(1).optional(),
});
export type ApplyBookFrame = z.infer<typeof applyBookFrameSchema>;

/** Một YCCĐ chụp trong neo của một mục bài SGK (đối ứng của courseSectionFrameOutcomeSchema ở khung chương trình). */
export const courseSectionBookItemOutcomeSchema = z.object({
  outcomeId: uuidIdSchema.nullable(),
  content: z.string(),
});
export type CourseSectionBookItemOutcome = z.infer<typeof courseSectionBookItemOutcomeSchema>;

/** Một mục bài SGK trong một section đã nạp khung SGK: tựa chụp tại thời điểm nạp + YCCĐ chụp kèm. */
export const courseSectionBookItemSchema = z.object({
  nodeId: uuidIdSchema.nullable(),
  title: z.string(),
  outcomes: z.array(courseSectionBookItemOutcomeSchema),
});
export type CourseSectionBookItem = z.infer<typeof courseSectionBookItemSchema>;

/**
 * Neo khung SGK của một section (K0b): section là bản sao độc lập, neo
 * ghi node chủ đề nguồn + cuốn sách + tựa chụp; các mục bài nằm trong
 * `items` theo đúng thứ tự sách. Sửa cây sách sau đó không đổi section
 * đã nạp.
 */
export const courseSectionBookFrameSchema = z.object({
  nodeId: uuidIdSchema.nullable(),
  bookId: uuidIdSchema.nullable(),
  nodeTitle: z.string(),
  items: z.array(courseSectionBookItemSchema),
});
export type CourseSectionBookFrame = z.infer<typeof courseSectionBookFrameSchema>;
