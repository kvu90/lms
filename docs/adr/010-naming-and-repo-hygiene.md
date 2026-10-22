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
  `dist/` (đã ignore bằng `.gitignore` — cấu hình công cụ thông thường);
  file cấu hình gốc của app (ví dụ `apps/api/drizzle.config.ts`) không
  nằm trong chương trình build phát hành (`tsconfig.build.json` của api
  và worker chỉ `include` thư mục `src/`).
- **Cách thực thi — kỷ luật, không máy móc**: hai quy ước trên là chuẩn
  viết code của repo, đạt được bằng cách viết đúng ngay từ đầu và rà
  soát khi review. Repo **không** dựng cơ chế cưỡng chế tự động (không
  script kiểm tra, không bước CI riêng) cho các quy ước này — mục đích
  là code sạch tự thân, chỉ thể hiện luồng nghiệp vụ thật, không mang
  dấu vết quá trình triển khai; máy móc đi canh lỗi phong cách sẽ tự nó
  trở thành một dấu vết như vậy. Cơ chế tự động chỉ được đề xuất khi
  chủ dự án yêu cầu đích danh.
- Ghi chú lịch sử: các file `apps/api/drizzle.config.js/.d.ts/.js.map`
  từng bị track từ những đợt đầu đã được gỡ khỏi git trong đợt refactor
  cấu trúc của repo.

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


