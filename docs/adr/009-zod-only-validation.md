# ADR-009: Validation chỉ bằng Zod qua Standard Schema

## Trạng thái
Accepted (22/10/2026).

## Bối cảnh
Trước đây code dùng class-validator làm mặc định. Chủ dự án chốt lại: cần
MỘT nguồn sự thật duy nhất cho shape dữ liệu, dùng chung giữa API và form
React, và thông điệp validation phải dịch được qua catalog i18n.

## Quyết định
- **Zod cho 100% validation** của code mới — KHÔNG có ngoại lệ
  class-validator. Nest 12 hỗ trợ Standard Schema first-class (chương
  Validation hiện hành của docs.nestjs.com): gắn schema qua tuỳ chọn
  `schema` của `@Body()/@Query()/@Param()` và bind pipe toàn cục.
- Schema nền sống ở `packages/contracts` (mỗi bounded context một file),
  dùng chung cho (a) validation ở API và (b) form phía React.
- Field nào backend cần mà frontend không có thì **EXTEND** schema nền ở
  phía server bằng `extend/omit/pick/partial`, `superRefine` cho ràng buộc
  chéo, `transform/coerce` khi cần — không viết hệ validation thứ hai.
  Ví dụ đã áp dụng: schema tự phục vụ của privacy request chỉ có `type`;
  schema phía server extend thêm `userid` (chỉ admin gửi hộ); schema chèn
  tài liệu thô của search extend thêm `title/content/contextid/ownerid`
  (chỉ indexer nội bộ dùng).
- Schema payload dùng `z.strictObject`: field lạ bị từ chối (tương đương
  lớp `forbidNonWhitelisted` trước đây).
- **Dịch thông điệp validation** theo cơ chế được tài liệu @nestjs/i18n hỗ
  trợ cho đường Standard Schema: bind `I18nStandardSchemaValidationPipe`
  qua `APP_PIPE` (thay cho `StandardSchemaValidationPipe` thuần). Pipe tra
  khoá theo thứ tự: khoá tường minh nhúng bằng `i18nIssueMessage()` trong
  schema → `validation.<format>` → `validation.<code>.<origin>` →
  `validation.<code>` trong catalog. Ánh xạ issue code → khoá catalog do đó
  nằm ở **catalog `validation.json`** của api (vi/en), không nằm trong code.
  KHÔNG dùng `I18nValidationPipe` (chỉ dành cho class-validator).

## Lý do bỏ class-validator
Một nguồn sự thật duy nhất (schema) phục vụ cả API lẫn form React; type
được suy trực tiếp từ schema (`z.infer`) nên không tồn tại hai định nghĩa
song song (class DTO + type) dễ lệch nhau; bỏ class-validator cũng đóng
luôn block peer của @nestjs/i18n (ADR-008).

## Trạng thái chuyển đổi (ghi đúng thực tế)
- Code mới của đợt nền tảng dịch vụ đã chuyển 100% sang Zod: toàn bộ DTO
  của search, web services, backup, analytics, reports, content bank,
  payments, privacy là schema/type suy từ `@lms/contracts`.
- Code cũ (các module đã xây trước) vẫn còn class-validator trong
  dependencies và trong DTO của chúng. Việc **gỡ hẳn class-validator khỏi
  dependencies của toàn repo + chuyển đổi code cũ** thuộc đợt rà soát
  ngược tiếp theo — CHƯA làm, ADR này không ghi là đã gỡ xong. Trong thời
  gian chuyển tiếp, global `ValidationPipe` (main.ts) vẫn phục vụ DTO cũ;
  các param gắn `schema` được pipe Standard Schema xử lý (hai pipe không
  chồng chéo vì param schema không có class metatype).

## Hệ quả
- Mọi payload mới phải có schema ở contracts trước khi có endpoint.
- Thông điệp validation mặc định của Zod không bao giờ lộ ra ngoài: pipe
  dịch theo catalog; thiếu khoá ở dev/test sẽ lộ qua missingKey 'throw'.
