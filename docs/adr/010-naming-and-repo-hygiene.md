# ADR-010: Quy ước đặt tên theo nghiệp vụ và vệ sinh repo

## Trạng thái
Accepted (22/10/2026).

## Quyết định
- **Mọi thứ đặt theo nghiệp vụ/bounded context**: định danh, file, thư mục,
  tên test, comment và commit subject mang tên tính năng/nghiệp vụ (ví dụ
  "fee enrolment", "privacy provider registry"). **CẤM nhãn phase**
  (kiểu P0, P1, …) trong code, comment, tên test và commit subject; nhãn
  phase chỉ được sống trong tài liệu kế hoạch và
  `docs/business-traceability.md`.
- **CẤM commit sản phẩm biên dịch**: không commit `dist/`, không commit
  file `.js`/`.d.ts`/`.js.map` sinh ra cạnh source. Đầu ra build chỉ vào
  `dist/` (đã ignore); file cấu hình gốc của app (ví dụ
  `apps/api/drizzle.config.ts`) bị exclude khỏi chương trình build phát
  hành. Trước mỗi commit phải kiểm tra `git status`.
- Ngoại lệ lịch sử đã biết: `apps/api/drizzle.config.js/.d.ts/.js.map` bị
  track từ những đợt đầu — đợt refactor dọn repo sẽ gỡ; từ nay không thêm
  file mới thuộc loại này.

## Hai guard tương ứng
Script `scripts/check-repo-hygiene.mjs` (chạy trong bước verify, nhận
tham số base ref tuỳ chọn):
1. **Guard sản phẩm biên dịch**: mọi file `.js/.d.ts/.js.map` bị track
   ngoài `dist/`/`node_modules` mà không nằm trong allowlist lịch sử ở
   trên đều làm guard fail.
2. **Guard nhãn phase**: quét các dòng được thêm (git diff so với base
   ref) trong `apps/*/src`, `apps/*/test`, `packages/*/src` — dòng chứa
   mẫu nhãn phase (`\bP\d+\b` trong code/comment/tên test) làm guard fail.
   File tài liệu kế hoạch và traceability được miễn trừ theo thiết kế.

## Bổ sung: cấu trúc schema theo bounded context

- Mỗi module sở hữu các bảng Drizzle của mình tại
  `apps/api/src/modules/<module>/schema.ts`; các bảng hạ tầng nền tảng
  (config, outbox, event log, task config/log…) nằm ở
  `apps/api/src/db/infrastructure.schema.ts`.
- `apps/api/src/db/schema.ts` chỉ là barrel re-export toàn bộ, là điểm vào
  duy nhất cho `drizzle.config.ts` và DrizzleModule; `relations.ts` cũng
  dựng trên barrel này.
- Worker giữ bản sao subset của riêng nó tại `apps/worker/src/db/schema.ts`
  (chỉ các bảng/cột mà processor của worker chạm tới) vì worker là tiến
  trình riêng; nguồn canonical là các file schema theo module ở API.
- Di chuyển schema giữa các file KHÔNG được đổi tên bảng/cột/kiểu/ràng
  buộc và không được sinh migration mới (`drizzle-kit generate` phải báo
  không có thay đổi schema).
