/**
 * Lỗi miền dùng chung của package `@lms/enrol`.
 *
 * Package này là code thuần tầng dữ liệu (không phụ thuộc Nest hay
 * HTTP), nên mọi lỗi nghiệp vụ nó ném ra đều mang một `code` kỹ thuật
 * ổn định (đúng mã ProblemDetails mà bề mặt API đã và đang trả cho
 * client) kèm thông điệp tiếng Anh như hiện hành. Tầng host (hôm nay
 * là `apps/api`) dịch các lỗi này về exception HTTP tương ứng — mã và
 * thông điệp giữ nguyên nên hành vi quan sát được từ ngoài không đổi:
 * cùng một chốt chặn bị vi phạm thì client nhận đúng mã lỗi và thông
 * điệp như trước khi trích xuất.
 */

/**
 * Lỗi nghiệp vụ mang mã kỹ thuật: nền của mọi lỗi mà các lõi trong
 * package này ném ra.
 */
export class SharedDomainError extends Error {
  /** Mã lỗi kỹ thuật (mã ProblemDetails ở bề mặt API). */
  readonly code: string;

  /**
   * @param code - mã lỗi kỹ thuật ổn định, không đổi theo ngôn ngữ hiển thị.
   * @param message - thông điệp lỗi tiếng Anh như bề mặt API hiện hành.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SharedDomainError';
    this.code = code;
  }
}

/**
 * Mã lỗi ProblemDetails dùng chung cho MỌI chốt chặn tách vai giáo
 * viên/học viên: cả ba funnel ghi danh và chốt chiều ngược ở đường
 * gán vai đều ném đúng một mã, để client và test nhận diện vi phạm
 * lẫn vai bằng một hằng số duy nhất.
 */
export const ROLE_CONTEXT_CONFLICT_CODE = 'access.role_context_conflict';

/**
 * Lỗi xung đột vai theo ngữ cảnh (một tài khoản vừa dạy vừa học cùng
 * một khoá/lớp) — xem định nghĩa kiểm (a)/(b) tại `RoleSeparationCore`.
 */
export class RoleContextConflictError extends SharedDomainError {
  /**
   * @param message - thông điệp lỗi tiếng Anh như bề mặt API hiện hành.
   */
  constructor(message: string) {
    super(ROLE_CONTEXT_CONFLICT_CODE, message);
    this.name = 'RoleContextConflictError';
  }
}

/**
 * Nhận diện một lỗi có phải lỗi xung đột vai theo ngữ cảnh hay không.
 *
 * Nhận cả ba hình dạng mà lỗi này mang trên các đường truyền khác
 * nhau: `RoleContextConflictError` của chính package này (đường lõi
 * dùng chung), một `SharedDomainError` mang đúng mã (lỗi đã được một
 * lõi khác bọc lại), và hình dạng exception HTTP của Nest
 * (`BadRequestException` mang thân `{ code }` — lỗi đã được tầng API
 * dịch) để các caller ở tầng host vẫn nhận diện được sau khi lỗi đã
 * qua lớp dịch. Các caller gọi hàng loạt (backfill cohort, listener
 * đồng bộ) dùng hàm này để bỏ qua RIÊNG thành viên vi phạm thay vì
 * làm hỏng cả vòng lặp; mọi lỗi khác phải nổi lên.
 *
 * @param err - lỗi bắt được từ một đường ghi danh/gán vai.
 * @returns true khi `err` mang mã `access.role_context_conflict`.
 */
export function isRoleContextConflictError(err: unknown): boolean {
  if (err instanceof SharedDomainError) return err.code === ROLE_CONTEXT_CONFLICT_CODE;
  if (err instanceof Error) {
    const shaped = err as { code?: unknown; getResponse?: unknown };
    if (shaped.code === ROLE_CONTEXT_CONFLICT_CODE) return true;
    if (typeof shaped.getResponse === 'function') {
      const response = (shaped.getResponse as () => unknown).call(err) as { code?: unknown } | string;
      return typeof response === 'object' && response !== null && response.code === ROLE_CONTEXT_CONFLICT_CODE;
    }
  }
  return false;
}
