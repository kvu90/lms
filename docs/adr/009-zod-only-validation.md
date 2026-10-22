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

## Trạng thái chuyển đổi — ĐÃ GỠ HOÀN TOÀN (đợt rà soát bề mặt cũ)

- Toàn bộ DTO cũ (access, users, auth, custom-fields, files, courses, groups,
  enrol, completion, grades, questions, messaging, calendar, badges,
  competencies, social) đã chuyển sang schema Zod: schema nền ở
  `packages/contracts` (identity/course/assessment/engagement/platform),
  file `dto/*.dto.ts` của mỗi module chỉ re-export schema + type suy ra và
  EXTEND cho nhu cầu riêng của server (ép kiểu query string/multipart bằng
  `z.coerce`, đúng mẫu privacy/search trước đây).
- `class-validator` và `class-transformer` đã GỠ HẲN khỏi mọi
  `package.json` và khỏi đồ thị lockfile (không còn package entry nào;
  chỉ còn khai báo peer tuỳ chọn trong metadata của chính các gói Nest).
  Global `ValidationPipe` đã gỡ khỏi `main.ts` và khỏi test helper — mọi
  validation đi qua `APP_PIPE` (`I18nStandardSchemaValidationPipe`).
- Env validation của ConfigModule (api + worker) vốn đã là Zod
  (`validateEnv`), giữ nguyên.
- Để pnpm không tự cài lại các peer tuỳ chọn này cho `@nestjs/common` /
  `@nestjs/swagger`, `pnpm-workspace.yaml` đặt `autoInstallPeers: false` —
  từ nay mọi peer cần thiết phải khai tường minh trong `package.json`.
- Hệ quả phụ: cảnh báo peer chưa thoả của `@nestjs/i18n` (xem ADR-008)
  biến mất hoàn toàn.

## Hệ quả
- Mọi payload mới phải có schema ở contracts trước khi có endpoint.
- Thông điệp validation mặc định của Zod không bao giờ lộ ra ngoài: pipe
  dịch theo catalog; thiếu khoá ở dev/test sẽ lộ qua missingKey 'throw'.
