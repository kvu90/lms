import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Tạo QueryClient cho app (theo tài liệu chính thức TanStack Query v5):
 * một client duy nhất cho cả vòng đời app, khai báo mặc định tập trung
 * tại đây thay vì rải rác từng hook.
 *
 * - staleTime 30 giây: dữ liệu máy chủ (quyền, khoá học, điểm…) coi là
 *   tươi trong 30 giây — các lần F5/điều hướng trong khoảng đó dựng ngay
 *   từ cache rồi mới làm mới nền (stale-while-revalidate), thay cho thác
 *   nước fetch nối tiếp trước đây.
 * - retry: lỗi phân quyền/không tồn tại (401/403/404) không thử lại vì
 *   thử lại không đổi kết quả; lỗi còn lại thử tối đa 2 lần.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && [401, 403, 404].includes(error.problem.status)) {
            return false;
          }
          return failureCount < 2;
        },
      },
    },
  });
}

/**
 * Client dùng chung của app thật (root.tsx bọc QueryClientProvider bằng
 * chính instance này) — để tầng phiên (auth) xoá được toàn bộ cache khi
 * đăng nhập/đăng xuất mà không phụ thuộc cây component.
 */
export const queryClient = createQueryClient();
