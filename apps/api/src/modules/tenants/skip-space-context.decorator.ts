import { SetMetadata } from '@nestjs/common';
export const SKIP_SPACE_CONTEXT_KEY = 'skipSpaceContext';
/**
 * Đánh dấu một route tự gắn trung tâm thay vì để `SpaceContextGuard`
 * ghim: dùng cho các đường phải chạy được TRƯỚC khi phiên thuộc về
 * trung tâm — đọc nhận diện công khai của trung tâm (trang đăng nhập
 * cần tên/logo trước khi đăng nhập) và kích hoạt lời mời (tài khoản
 * chưa có phiên thuộc trung tâm nào). Handler của các route này tự
 * gắn trung tâm (phân giải slug → chuẩn bị kho → đọc/ghi trong ngữ
 * cảnh ALS của kho đó) nên việc bỏ qua guard không phải là bỏ qua
 * gắn trung tâm — chỉ là tránh luật 401 `auth.centre_mismatch` của
 * phiên chưa có claim ở địa chỉ trung tâm.
 */
export const SkipSpaceContext = () => SetMetadata(SKIP_SPACE_CONTEXT_KEY, true);
