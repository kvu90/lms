import { SetMetadata } from '@nestjs/common';
export const IS_PLATFORM_ROUTE_KEY = 'isPlatformRoute';
/**
 * Đánh dấu một controller/route thuộc BỀ MẶT VẬN HÀNH platform (issue
 * #584): chỉ token mang audience `platform` — cấp từ bề mặt đăng
 * nhập quản trị platform riêng — mới được gọi; token nghiệp vụ
 * thường bị `AudienceGuard` từ chối và ngược lại (token platform
 * không gọi được route nghiệp vụ). Hiện chỉ controller control
 * plane mang dấu này; bề mặt vận hành mở rộng thì gắn thêm đúng
 * controller đó, không nới guard.
 */
export const PlatformRoute = () => SetMetadata(IS_PLATFORM_ROUTE_KEY, true);
