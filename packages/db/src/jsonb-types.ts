/**
 * Hình dạng của các cột jsonb có cấu trúc nghiệp vụ riêng — trước
 * đây các kiểu này sống cạnh định nghĩa bảng trong các file
 * `*.schema.ts` (lớp schema bộ máy cũ) và được gắn vào cột qua
 * `$type<…>()`. Sau khi gỡ bộ máy cũ (issue #663), cây mã không còn
 * lớp schema: kiểu sinh từ database thật (`src/types/*-db.d.ts`)
 * khai các cột jsonb này là `Json`, và hình dạng nghiệp vụ chính
 * thức của chúng sống tại đây — `kysely-codegen` được cấu hình
 * (mục `customImports` trong `scripts/codegen/*.json`) để các cột
 * tương ứng trong kiểu sinh trỏ về đúng các kiểu này, nên đổi hình
 * dạng ở đây là đổi hợp đồng kiểu của mọi tầng đọc/ghi cột đó.
 */

/**
 * Hình dạng lưu trữ của `content`: tài liệu Tiptap của YCCĐ, lưu
 * trực tiếp dạng jsonb (không còn text trích). Ý đơn là một đoạn
 * văn; ý có ý con gồm đoạn văn (ý cha) và danh sách gạch đầu dòng
 * lồng (ý con). Text thuần canonical trích từ tài liệu này bằng
 * đúng một hàm chuẩn ở tầng nạp là chuẩn duy nhất cho kiểm chứng
 * toàn vẹn và cho mọi phép so khớp nguyên văn; mọi bề mặt đọc trả
 * text canonical đó ở trường `content` của mình và chỉ bề mặt bảng
 * chương trình mới phơi thêm tài liệu để render phân cấp cha–con.
 * Dạng tài liệu ở đây cố tình trùng cấu trúc với dạng tài liệu của
 * dataset ở tầng nạp (kiểm tra bằng kiểu cấu trúc, không import
 * chéo package): đổi một bên mà không đổi bên còn lại là lỗi kiểu
 * ở tầng nạp, không phải lỗi thầm ở dữ liệu.
 */
export interface LearningOutcomeDocNode {
  type: string;
  text?: string;
  marks?: unknown[];
  content?: LearningOutcomeDocNode[];
}

/** Một YCCĐ dạng tài liệu Tiptap lưu trong cột `learning_outcomes.content`. */
export interface LearningOutcomeDoc {
  type: 'doc';
  content?: LearningOutcomeDocNode[];
}

/** Một biến thể mã đề của một lần ghim: mã in trên đề + seed hoán vị thứ tự câu/đáp án khi in (kế thừa từ exam_deployments). */
export interface ExamVariant {
  code: string;
  seed: number;
}

/** Một dòng lịch sử trước/sau của sổ đăng ký (ảnh chụp JSON của dòng đăng ký). */
export type SpaceRegistrySnapshot = {
  id: string;
  slug: string;
  name: string;
  kind: string;
  status: string;
  databaseName: string;
  storageMode: string;
  connectionRoleRef: string;
  secretRef: string | null;
  schemaVersion: string | null;
  plan: string | null;
};

/** Kết quả một bước trong một lượt chạy migration (do công cụ fleet ghi). */
export type SchemaMigrationStep = {
  name: string;
  status: string;
  detail?: string;
};
