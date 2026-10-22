# ADR-015: Site Config — bounded context cho cấu hình site và cấu hình theo plugin

## Trạng thái
Accepted (23/10/2026).

## Bối cảnh
Blueprint (§2#30, Config/Admin) yêu cầu cấu hình phân tầng kiểu Moodle:
mặc định trong code < giá trị quản trị lưu cơ sở dữ liệu < cấu hình theo
plugin (`component + name`), mọi thay đổi phải qua capability
`moodle/site:config` và có vết. Schema nền đã có sẵn ba bảng (`config`,
`plugin_config`, `admin_setting_audit`) từ đợt hạ tầng, nhưng chưa có
module nào đọc/ghi chúng — các quyết định vận hành (ví dụ cổng nhắn tin
`messagingallusers`) không có nơi neo, và rà soát nghiệp vụ ghi nhận đây
là bounded context còn thiếu ở cả hai tầng.

## Quyết định
- Dựng bounded context `site-config` (`apps/api/src/modules/site-config`)
  trên đúng ba bảng hạ tầng sẵn có, không thêm bảng mới:
  - `settings-registry.ts` khai báo tường minh từng setting (component,
    name, kiểu string/number/boolean/enum, giá trị mặc định). API từ chối
    khoá chưa đăng ký (`site_config.unknown_setting`) và giá trị sai kiểu
    (`site_config.invalid_value`) — không có "key tự do" để tránh cấu
    hình rác không ai kiểm chứng được.
  - Setting của `core` lưu ở bảng `config` (giá trị JSON); setting của
    component/plugin khác lưu ở `plugin_config` (JSON hoá trong cột text).
  - Mọi thao tác đặt/xoá ghi đè đều ghi `admin_setting_audit` (khoá,
    giá trị trước → sau, người thực hiện).
- API (`/api/v1/site-config`) gồm liệt kê, đọc một setting, PUT đặt ghi
  đè, DELETE xoá ghi đè (về mặc định), GET `audit` xem vết — tất cả đều
  `@RequireCapability('moodle/site:config')` ở context hệ thống.
- Các module khác tiêu thụ cấu hình qua `SiteConfigService.getValue`
  (export từ module) thay vì tự truy vấn bảng config; người tiêu thụ đầu
  tiên là cổng nhắn tin `core/messagingallusers` ở module messaging.
- Hợp đồng vận chuyển (hình dạng setting/audit) nằm ở
  `packages/contracts` (`site-config.ts`); kiểm chứng kiểu theo từng
  setting nằm ở registry phía máy chủ vì phụ thuộc vào khoá.

## Hệ quả và giới hạn đã biết
- Thêm setting mới = thêm một dòng registry kèm mặc định và (khi có
  người tiêu thụ) một điểm đọc qua `getValue`; không cần migration.
- Chưa có nhóm setting "bí mật" (mật khẩu dịch vụ ngoài) — khi xuất hiện
  nhu cầu thật (ví dụ SMTP) sẽ bổ sung cờ che giá trị trong audit/response
  ở registry thay vì mặc định lưu thô.
- Check API dạng khai báo của blueprint §2#30 vẫn do module health đảm
  nhiệm (health/readiness); site-config không nhân bản phần đó.
