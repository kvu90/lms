# ADR-008: I18n bằng gói chính thức @nestjs/i18n

## Trạng thái
Accepted (22/10/2026).

## Bối cảnh
Mọi text hiển thị (title/detail của lỗi RFC 7807, thông điệp validation, nội
dung notification, nhãn enum) phải tập trung trong catalog theo locale, không
rải chuỗi cứng trong code. Locale mặc định là **tiếng Việt**, kèm tiếng Anh.

## Quyết định
- Dùng gói CHÍNH THỨC **@nestjs/i18n** (first-party của Nest), **ghim exact
  `0.0.1`** (pre-1.0, phát hành 29/09/2026 — không dùng `^` vì API có thể đổi
  ở bất kỳ bản nào trước 1.0). KHÔNG dùng `nestjs-i18n` (gói cộng đồng).
- Cấu hình: `I18nModule.forRoot({ defaultLocale: 'vi', supportedLocales:
  ['vi','en'], loader: JsonI18nLoader tại src/i18n/<locale>/*.json (mỗi file
  là một namespace), resolvers theo thứ tự Query('lang') → Header('x-lang') →
  AcceptLanguage → Cookie('lang'), missingKey: 'throw' ngoài production /
  'fallback' ở production })`.
- Exception nội bộ chỉ mang `code` ổn định bằng tiếng Anh; tầng biên (RFC 7807
  filter) tra `errors.<code>` trong catalog bằng hàm `t()` độc lập của gói để
  lấy detail theo ngôn ngữ của request.
- Worker dịch ngoài request context: truyền `locale` tường minh vào
  `I18nService.t(key, { locale })` (mẫu được tài liệu gói mô tả cho job nền
  viết cho user theo ngôn ngữ đã lưu; khi hệ thống chưa lưu locale theo user
  thì dùng locale mặc định 'vi'). `I18nContext.run(locale, fn)` là phương án
  tương đương khi cần dịch cả một đoạn xử lý.
- Frontend: `i18next` + `react-i18next`, resources tập trung tại
  `apps/web/src/i18n.ts` (vi mặc định, en kèm theo); khoá dùng chung với
  backend nằm trong cùng quy ước namespace.

## Block peer dependency — ĐÃ ĐÓNG bằng quyết định kiến trúc
`@nestjs/i18n@0.0.1` khai peer `class-validator ^0.14.0` (theo npm view).
Peer này là **tuỳ chọn** và chỉ cần khi dùng `I18nValidationPipe` của gói
(đường validation bằng class-validator). Dự án validate 100% bằng Zod (xem
ADR-009) và KHÔNG dùng `I18nValidationPipe`; đường dịch validation của dự án
là `I18nStandardSchemaValidationPipe` + ánh xạ Zod issue code → khoá catalog
(xem ADR-009). Vì vậy xung đột peer được đóng bằng quyết định "không dùng
class-validator", **không** dùng `legacy-peer-deps`.

Ghi nhận thực tế cài đặt: `pnpm add @nestjs/i18n@0.0.1 --save-exact` cài
thành công cho cả api và worker, chỉ kèm cảnh báo peer chưa thoả
(class-validator 0.15.1 còn trong cây từ code cũ) — không lỗi ERESOLVE.
ĐÃ ĐÓNG (đợt rà soát bề mặt cũ): class-validator/class-transformer đã gỡ
hẳn khỏi toàn repo (xem ADR-009, mục trạng thái chuyển đổi) nên cảnh báo
peer biến mất hoàn toàn; `pnpm-workspace.yaml` đặt `autoInstallPeers:
false` để pnpm không tự cài lại các peer tuỳ chọn này.

## Hệ quả
- Thiếu khoá dịch ở môi trường dev/test làm request lỗi 500 (missingKey
  'throw') — đây là chủ đích để phát hiện sớm; test parity của catalog
  (vi/en cùng tập khoá) chạy trong worker test suite.
- Catalog JSON phải được copy vào `dist/` khi build (tsc không copy JSON):
  build script của api/worker có bước `cp -r src/i18n dist/i18n`.
