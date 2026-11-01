/**
 * Repository của module DASHBOARD trên Kysely — hạng mục nhóm C của
 * chiến dịch chuyển tầng dữ liệu sang `packages/db` + Kysely (issue
 * #652), chuyển từ repository Drizzle cũ ở
 * `apps/api/src/modules/dashboard/dashboard.repository.ts`.
 *
 * Vai trò: mọi truy cập dữ liệu của dashboard việc cần làm (DASH1,
 * issue #121) — tập khoá người dùng thuộc về (ghi danh hiệu lực, gán
 * vai tại context khoá), các nguồn việc đến hạn (quiz, bài tập), điểm
 * và vết công bố, hàng đợi chấm (bài nộp chờ chấm, lượt quiz chờ chấm
 * tay, phiếu giấy chờ xử lý), mốc xem dashboard và tuỳ chọn thẻ khoá
 * cá nhân. Mọi truy vấn đều GOM theo tập khoá của người dùng trong
 * một câu SQL cho mỗi nguồn — không vòng lặp truy vấn theo từng khoá.
 * Luật nghiệp vụ (lọc công bố điểm qua facade Grades, xác định đội
 * giảng dạy qua evaluator) nằm ở tầng service phía ứng dụng;
 * repository này chỉ là lớp truy cập dữ liệu thuần.
 *
 * Cổng phụ thuộc registry ngữ cảnh: định nghĩa các mức ngữ cảnh
 * (`CONTEXT_LEVELS`) là registry sống phía ứng dụng (module access)
 * và là NGUỒN ĐỊNH NGHĨA DUY NHẤT của hệ — package này cấm giữ bản
 * sao của registry (hai nguồn định nghĩa là lỗi thiết kế). Vì vậy
 * file này chỉ khai HÌNH DẠNG của registry: danh sách khoá
 * (`CONTEXT_LEVEL_KEYS`) và kiểu ánh xạ khoá → số mức
 * (`ContextLevels`). Giá trị số thật của từng mức do phía ứng dụng
 * cấp qua tham số constructor (điểm tiêm là DI token trong module
 * dashboard phía `apps/api`, implementation trỏ thẳng tới registry
 * hiện hành). Tại thời điểm chuyển đổi, repository chỉ tiêu thụ đúng
 * một khoá qua cổng: `COURSE` (lọc gán vai tại context khoá).
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package): bên trong dùng tên cột snake_case
 * của interface schema codegen; bên ngoài giữ nguyên hợp đồng dòng
 * camelCase của repository Drizzle cũ qua danh sách cột tường minh
 * có bí danh; các hàm ánh xạ ghi loại `undefined` từng trường (thử
 * nghiệm T-4); mọi giá trị where là tham số bắt buộc. Module này
 * không tham gia transaction nào (kiểm kê tại file cũ: 0 điểm mở
 * transaction, phía service gọi từng method độc lập) nên repository
 * không nhận handle giao dịch — cấm giao dịch lai vì vậy không có
 * bề mặt để vi phạm.
 *
 * Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 * dụng, không tự mở pool, không đọc biến môi trường.
 */
import type { CentreDb } from '../client';

/**
 * Danh sách khoá của registry mức ngữ cảnh — HÌNH DẠNG của registry,
 * không phải giá trị của nó: hằng này chỉ nêu các khoá tồn tại trong
 * registry phía ứng dụng, tuyệt đối không mang số mức của bất kỳ
 * khoá nào. Đổi hình dạng registry (thêm/bớt khoá) thì sửa hằng này
 * cùng interface `ContextLevels` ở lượt chạm tương ứng; đổi GIÁ TRỊ
 * số mức chỉ sửa ở registry phía ứng dụng, package không phải chạm.
 */
export const CONTEXT_LEVEL_KEYS = [
  'SYSTEM',
  'TENANT',
  'USER',
  'COURSECAT',
  'CLASS',
  'COURSE',
  'MODULE',
  'BLOCK',
] as const;

/** Một khoá của registry mức ngữ cảnh (phần tử của `CONTEXT_LEVEL_KEYS`). */
export type ContextLevelKey = (typeof CONTEXT_LEVEL_KEYS)[number];

/**
 * Cổng phụ thuộc tới registry mức ngữ cảnh: ánh xạ mỗi khoá của
 * registry sang số mức của nó. Đây là interface cổng duy nhất mà
 * package cần từ registry — phía ứng dụng cấp object registry thật
 * (đúng hình dạng này) qua điểm tiêm; package không biết và không
 * giữ giá trị cụ thể nào.
 */
export interface ContextLevels {
  /** Mức ngữ cảnh hệ thống. */
  readonly SYSTEM: number;
  /** Mức ngữ cảnh trung tâm (tenant). */
  readonly TENANT: number;
  /** Mức ngữ cảnh người dùng. */
  readonly USER: number;
  /** Mức ngữ cảnh danh mục khoá. */
  readonly COURSECAT: number;
  /** Mức ngữ cảnh lớp. */
  readonly CLASS: number;
  /** Mức ngữ cảnh khoá học — khoá duy nhất repository này tiêu thụ. */
  readonly COURSE: number;
  /** Mức ngữ cảnh module hoạt động trong khoá. */
  readonly MODULE: number;
  /** Mức ngữ cảnh khối trong module. */
  readonly BLOCK: number;
}

/** Handle truy vấn kho trung tâm mà repository giữ: facade định tuyến theo không gian do phía ứng dụng cấp. */
export type DashboardDb = CentreDb;
