# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/contracts`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của contracts.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT;
   tài liệu mới hơn không tự thắng sổ; mâu thuẫn thì DỪNG và báo main chat.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Đổi schema ở đây gần như luôn kéo theo thay đổi ở api/web —
  các thay đổi đó thuộc cùng feat/PR, không tách PR riêng cho contracts.
- Chỉ mô tả hình dạng dữ liệu. Cần logic/ràng buộc chạy → đặt ở `apps/api`.

## Điều cấm package-specific

- Cấm đổi mã lỗi/khuôn ProblemDetails đã chốt (vd vượt trần tin nhắn = 400) theo cảm
  tính — mã lỗi là hợp đồng nghiệp vụ, đổi phải có quyết định trong sổ.
- Cấm thêm scope MCP mới (đặc biệt scope ghi bank chung) khi chưa có quyết định chốt.
- Cấm thêm khoá site-config không có quyết định nghiệp vụ đi kèm.
- Cấm dùng kiểu ngày giờ không biểu diễn được trong JSON Schema ở schema route
  (`z.date()` làm crash boot production qua Swagger) — dùng `z.iso.datetime(...)`.
- Cấm định nghĩa trùng một schema đã có: một miền một file, xuất qua `index.ts`.

## Kiểm chứng bắt buộc

- **Typecheck + build trước khi push**: `pnpm --filter @lms/contracts typecheck`
  rồi build để `dist` mới — sau đó mới typecheck các app tiêu thụ trong cùng feat.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Local chỉ test targeted
  (`contracts.spec`); suite nặng giữ khoá `flock
  ~/workspace/lms-nest-ops/heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Test contracts phải kiểm các ràng buộc NGHIỆP VỤ của hình dạng (giới hạn độ dài,
  enum trạng thái đúng tập đã chốt, scope đúng tập đã chốt), không chỉ kiểm "schema
  parse được JSON mẫu". Nới một ràng buộc nghiệp vụ thì test phải fail.
- Đổi schema mà mọi test vẫn xanh nguyên = dấu hiệu test chưa bám nghiệp vụ — bổ
  sung test bám quyết định trong cùng lượt.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.

## Chuẩn comment TSDoc (sổ quyết định mục F — chốt 13:14 ngày 26/10/2026)

Mọi code TypeScript viết mới hoặc sửa trong `packages/contracts` phải có
comment **tiếng Việt theo chuẩn TSDoc**, chi tiết nhất có thể — ở package này
comment flow mang thêm một vai trò riêng: ghi lại **quyết định nghiệp vụ mà
hình dạng dữ liệu đang mã hoá**, để lần sửa schema sau dựa vào nội dung code
đang có chứ không dựa vào trí nhớ của trợ lý:

- Đầu mỗi file: khối TSDoc mô tả miền nghiệp vụ của file + các hợp đồng chính
  trong file + luồng sử dụng (ai định nghĩa → app nào tiêu thụ → ràng buộc
  nào được thực thi ở đâu).
- Mỗi schema/type trọng yếu: TSDoc `/** ... */` tiếng Việt gồm ý nghĩa nghiệp
  vụ của trường/kiểu, ràng buộc đã chốt (giới hạn độ dài, tập enum, tập scope
  đóng…), mã lỗi tương ứng trong khuôn ProblemDetails khi ràng buộc bị phá,
  và quyết định trong sổ mà hình dạng này đang mã hoá (nếu có).
- Ràng buộc khó nhìn (vì sao một trường optional, vì sao một enum chỉ có đúng
  các giá trị đó): comment nội tuyến tiếng Việt nói lý do — không lặp lại
  điều schema đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example` khi cần); định danh và tên
  tag giữ tiếng Anh.
- Sửa schema thì căn cứ vào comment đang có trong code; thấy comment lệch
  schema/quyết định thật thì sửa comment **trong cùng lượt** với sửa schema.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  flow đạt chuẩn là chưa đạt. Code cũ chưa có comment được phủ theo đợt riêng
  của issue #272, không tự trộn việc phủ vào feat đang bay.

## Bản đồ flow của package

- **Cấu trúc:** một miền một file trong `src/`, xuất tập trung qua
  `src/index.ts`: `identity.ts` (định danh/người dùng), `course.ts`,
  `classes.ts`, `assessment.ts` (câu hỏi/đề/bài tập/điểm theo bài),
  `engagement.ts`, `platform.ts`, `site-config.ts` (khoá cấu hình cấp site),
  `tenants.ts`, `curriculum.ts` (chương trình GDPT/YCCĐ), `books.ts`,
  `dashboard.ts`, `guardian.ts`, `health.ts`, `mcp.ts` (scope + công cụ MCP),
  `rich-text.ts` (hợp đồng nội dung soạn thảo dùng chung với
  `packages/editor`), `problem-details.ts` (khuôn lỗi dùng chung), `ids.ts`
  (UUIDv7). Test hợp đồng ở `src/contracts.spec.ts`.
- **Luồng dữ liệu:** schema Zod định nghĩa MỘT lần ở đây → build ra `dist` →
  `apps/api` dùng để kiểm chứng request/response ở biên, `apps/web` dùng làm
  kiểu + kiểm chứng dữ liệu hiển thị, `apps/worker` dùng các kiểu dùng chung
  khi xử lý nền. Đổi một hình dạng ở đây = đổi đồng thời ở cả ba app sau khi
  build lại `dist` (dist cũ là nguồn lỗi type giả kinh điển — xem mục kiểm
  chứng ở trên).
- Package **không** chứa logic chạy: ràng buộc trong schema là khai báo hình
  dạng; việc thực thi luật (gác quyền, cổng công bố…) nằm ở `apps/api` như
  mục ranh giới đã ghi.
