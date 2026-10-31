/**
 * Gói phiên bản bất biến của câu hỏi hệ thống (issue #585).
 *
 * Một phiên bản của câu hỏi hệ thống được lưu kèm một gói tự đủ
 * (self-contained): toàn bộ nội dung cần thiết để một trung tâm nhập
 * bản chụp mà không phải đọc thêm từ kho ngân hàng — nội dung câu,
 * đáp án + quy tắc chấm, phản hồi, ngữ liệu kèm, tài nguyên, và các
 * liên kết YCCĐ của câu (mã chuẩn + mức độ nhận thức từng liên kết).
 * Tài nguyên (media) không có bảng riêng: tài liệu Tiptap mang tham
 * chiếu `contentHash` tới kho đối tượng dùng chung (module files) nên
 * tài liệu trong gói đã mang tham chiếu nguyên vẹn, không sao chép tệp.
 *
 * Tính bất biến: nội dung đã phát hành không bao giờ bị ghi đè — mỗi
 * lần sửa tạo một phiên bản mới với gói + checksum mới; phiên bản cũ
 * đọc lại vẫn nguyên vẹn. Checksum là SHA-256 của dạng chuẩn hoá
 * (canonical JSON: khoá sắp xếp đệ quy) của gói, để phía trung tâm
 * kiểm chứng lại trước khi ghi bản chụp: checksum lệch thì từ chối
 * nhập, không ghi nửa vời.
 */
import { createHash } from 'node:crypto';

/**
 * Nội dung gói của một phiên bản câu hỏi hệ thống. Các trường tài liệu
 * dùng kiểu `unknown` có chủ đích: chúng là tài liệu Tiptap đã lưu
 * trong kho nghiệp vụ, gói chỉ mang nguyên vẹn, không diễn giải lại.
 */
export type SystemQuestionPackage = {
  /** Nội dung câu hỏi (tài liệu Tiptap của `question_versions`). */
  questionText: unknown;
  /** Phản hồi chung của câu hỏi (có thể null). */
  generalFeedback: unknown | null;
  /** Nội dung ngữ liệu kèm theo (có thể null). */
  stimulusContent: unknown | null;
  /** Các đáp án, giữ thứ tự hiển thị gốc qua `sortOrder`. */
  answers: Array<{
    /** Nội dung đáp án (tài liệu Tiptap). */
    answer: unknown;
    /** Đáp án này có đúng không. */
    isCorrect: boolean;
    /** Phản hồi riêng của đáp án (có thể null). */
    feedback: unknown | null;
    /** Thứ tự hiển thị của đáp án. */
    sortOrder: number;
  }>;
  /** Khoá đáp án 1-1 của phiên bản (có thể null với dạng chưa có khoá). */
  answerKey: {
    /** Hướng dẫn chấm (tài liệu Tiptap, có thể null). */
    guidance: unknown | null;
    /** Lời giải (tài liệu Tiptap, có thể null). */
    solution: unknown | null;
  } | null;
  /**
   * Hàng tuỳ chọn riêng theo dạng câu hỏi (multichoice/truefalse/
   * shortanswer/essay), đã lược bỏ id và id phiên bản — chỉ giữ nội
   * dung nghiệp vụ để gói tự đủ.
   */
  options: Record<string, unknown> | null;
  /**
   * Các liên kết YCCĐ của câu tại thời điểm đóng gói: mỗi liên kết
   * mang id chuẩn gốc của platform (`outcomeId`) và mức độ nhận thức
   * riêng của liên kết đó (`cognitiveLevel`).
   */
  outcomes: Array<{
    /** Id chuẩn gốc phía platform (uuid của `learning_outcomes`). */
    outcomeId: string;
    /** Mức độ nhận thức của liên kết này. */
    cognitiveLevel: string;
  }>;
};

/**
 * Chuẩn hoá một giá trị JSON thành chuỗi xác định: khoá đối tượng sắp
 * xếp theo thứ tự từ điển ở mọi cấp, mảng giữ nguyên thứ tự. Hai gói
 * bằng nhau về nội dung luôn cho cùng một chuỗi, bất kể thứ tự khoá
 * lúc dựng — checksum vì vậy ổn định qua các lần đóng gói.
 *
 * @param value - Giá trị JSON cần chuẩn hoá.
 * @returns Chuỗi JSON chuẩn hoá.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJson(item)}`).join(',')}}`;
}

/**
 * Tính checksum SHA-256 (hex) của một gói phiên bản qua dạng chuẩn hoá.
 *
 * @param pkg - Gói phiên bản cần băm.
 * @returns Checksum hex 64 ký tự.
 */
export function checksumPackage(pkg: SystemQuestionPackage): string {
  return createHash('sha256').update(canonicalizeJson(pkg), 'utf8').digest('hex');
}

/**
 * Kiểm chứng một gói nhận được có khớp checksum đã lưu không.
 * Phía nhập dùng hàm này trước khi ghi bản chụp: lệch thì từ chối.
 *
 * @param pkg - Gói nhận được từ kho ngân hàng.
 * @param expectedChecksum - Checksum đã lưu cùng phiên bản.
 * @returns `true` khi gói nguyên vẹn.
 */
export function verifyPackageChecksum(pkg: SystemQuestionPackage, expectedChecksum: string): boolean {
  return checksumPackage(pkg) === expectedChecksum;
}

/**
 * Kiểm chứng gói theo dạng câu ở mức thô — cùng luật mà module câu hỏi
 * áp ở `normaliseContent`, nhưng chỉ phần đếm đáp án (không lặp lại
 * chuẩn hoá Tiptap sâu; kiểm chứng sâu xảy ra ở lúc nhập vào kho
 * trung tâm qua `QuestionsService`):
 * - multichoice: đúng 4 lựa chọn và đúng 1 đáp án đúng;
 * - truefalse (TF-A): không mang dòng đáp án (đáp án từng mệnh đề đi
 *   qua `answerKey.solution`);
 * - shortanswer: ít nhất 1 đáp án và mọi dòng đều là đáp án được chấp
 *   nhận;
 * - essay: không mang dòng đáp án.
 * Dạng câu ngoài 4 dạng đã chốt không qua được hợp đồng route nên
 * không tới được đây; gặp thì coi như gói lỗi.
 *
 * @param qtype - Dạng câu của gói.
 * @param pkg - Gói cần kiểm chứng.
 * @returns Thông báo lỗi khi gói vi phạm, hoặc `null` khi gói hợp lệ.
 */
export function packageValidationError(qtype: string, pkg: SystemQuestionPackage): string | null {
  const correctCount = pkg.answers.filter((answer) => answer.isCorrect).length;
  if (qtype === 'multichoice') {
    if (pkg.answers.length !== 4) return 'multichoice package must carry exactly 4 answers';
    if (correctCount !== 1) return 'multichoice package must carry exactly 1 correct answer';
    return null;
  }
  if (qtype === 'truefalse') {
    if (pkg.answers.length !== 0) {
      return 'truefalse (TF-A) packages do not carry answer rows; per-statement answers go through answerKey.solution';
    }
    return null;
  }
  if (qtype === 'shortanswer') {
    if (pkg.answers.length < 1) return 'shortanswer package must carry at least 1 accepted answer';
    if (correctCount !== pkg.answers.length) return 'shortanswer package answers must all be accepted answers';
    return null;
  }
  if (qtype === 'essay') {
    if (pkg.answers.length !== 0) return 'essay packages do not carry answer rows';
    return null;
  }
  return `unsupported question type: ${qtype}`;
}
