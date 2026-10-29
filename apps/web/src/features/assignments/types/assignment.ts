/**
 * Kiểu dữ liệu của trang Bài tập thuộc feature assignments. Tách
 * từ module dữ liệu phẳng `src/lib/assignment-data.ts` khi tổ chức
 * lại apps/web theo mô hình features/ (issue #500): kiểu nằm ở
 * tầng types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn và
 * đột biến ở tầng queries/.
 */

/** Thân ghi tự do của các thao tác bài tập (cấu trúc do panel dựng theo biểu mẫu của nó). */
export type AssignmentWriteBody = Record<string, unknown>;
