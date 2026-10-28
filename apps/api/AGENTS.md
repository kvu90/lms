# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `apps/api`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của `apps/api`.
2. Issue đặc tả của việc đang làm trên GitHub — nguồn sự thật cho việc đó: bối cảnh,
   phạm vi, các quyết định liên quan (viết trọn vẹn ngay trong issue) và tiêu chí
   nghiệm thu đều nằm trong chính issue. Không viện dẫn sổ quyết định, hồ sơ hay tệp
   ngoài repo làm căn cứ. Tài liệu trong repo mâu thuẫn với issue thì DỪNG, báo
   main chat.
3. `AGENTS.md` ở thư mục gốc của repo — quy định chung cho AI toàn repo, gồm chuẩn
   văn bản tự chứa cho issue và PR.

## Chuẩn ngôn ngữ

Code (định danh, tên hàm/biến/lớp, chuỗi kỹ thuật) viết bằng tiếng Anh.
Toàn bộ comment trong code — gồm comment mô tả luồng nghiệp vụ — viết
bằng tiếng Việt. Mọi tài liệu trong repo (README, các file AGENTS, tài
liệu của package) và mọi văn bản trên GitHub (issue, PR, comment) viết
bằng tiếng Việt. Khi sửa code, comment tiếng Việt liên quan phải được
cập nhật khớp với code trong cùng lượt thay đổi. Nội dung đầy đủ của
chuẩn này nằm ở mục "Chuẩn ngôn ngữ" trong `AGENTS.md` ở thư mục gốc
của repo.

## Ranh giới phạm vi

- Chỉ sửa module thuộc phạm vi việc được giao. Việc phát sinh thuộc cùng feat thì ghi
  vào đúng issue của feat đó (mở lại nếu đã đóng), không xé issue/PR mới.
  **1 issue = 1 feat = 1 PR**; các chặng là commit đẩy vào chính PR đó.
- Nghiệp vụ phải gác ở server. Không "gác" bằng cách giấu ở client.

## Điều cấm package-specific

- Cấm capability có tiền tố (`moodle/`, `mod/`, `lms/`, `report/`) — dạng duy nhất
  `<area>:<name>`. Thêm capability phải đăng ký vào registry và cập nhật mọi spec đếm.
- Cấm schema route dùng `z.date()`/`z.coerce.date()` — chỉ `z.iso.datetime(...)`
  (Swagger `createDocument` lúc boot production sẽ crash; e2e không bắt được lớp này,
  đã có test hồi quy `openapi-document` — không được xoá/yếu hoá test đó).
- Cấm nới cổng công bố điểm: học sinh/phụ huynh chỉ thấy điểm ĐÃ CÔNG BỐ. Mọi đường
  đọc điểm mới phải qua cùng một cổng công bố.
- Cấm để API phía học viên trả trường nguồn sách (`book` attribution) của câu hỏi.
- Cấm literal múi giờ `Asia/Saigon` trong SQL — chỉ dùng IANA canonical
  `Asia/Ho_Chi_Minh` (CI không có alias, local có — lỗi "local xanh CI đỏ" kinh điển).
- Cấm tuỳ tiện regen baseline Drizzle: baseline chứa SQL RLS viết tay mà drizzle-kit
  không sinh lại được. Gộp baseline phải giữ RLS và kiểm chứng cây MERGE chứa đúng
  MỘT thư mục `*_baseline`.
- Cấm custom jobId BullMQ chứa dấu `:` — nối khoá dedupe bằng `-`.
- Cấm viết script probe chứa pattern `token=<biến>` hoặc khoá `"password":` viết
  thẳng trong thân script (bị biến tướng khi truyền qua công cụ ghi file).

## Kiểm chứng bắt buộc

- **Typecheck package trước khi push**: sửa file nào thì typecheck tối thiểu trọn
  package (`pnpm --filter @lms/api typecheck`) — tuyệt đối không đẩy code chưa qua
  typecheck để CI đổ ở bước rẻ nhất. Đụng package dùng chung thì build lại dist của
  package đó trước khi kết luận lỗi type (dist cũ = lỗi type giả kinh điển).
- CI trên PR là cổng kiểm chứng chính; kết luận về CI chỉ từ **LOG THẬT**
  (log của job `verify` trên GitHub Actions của chính PR), không suy từ thời
  lượng bước hay thông báo của helper.
- Local chỉ chạy test targeted của đúng phần mình đụng. Chạy suite e2e/vitest nặng ở
  local phải giữ khoá `flock /tmp/lms-heavy-suite.lock` suốt lượt
  chạy; tối đa một vòng nặng tại một thời điểm trên máy này.
- Suite api và worker không chạy đồng thời trên cùng một DB; giữ cách ly DB như CI
  (`lms_test_api` / `lms_test_worker`).

## Kỷ luật test theo nghiệp vụ

- Test phải thể hiện **luồng nghiệp vụ thật** (GV/HS làm gì, hệ thống phải giữ quy tắc
  gì), không viết test chỉ để mô tả chi tiết triển khai (tên hàm nội bộ, cấu trúc
  trung gian). Đổi nghiệp vụ đã chốt thì test tương ứng **phải fail** — nếu đổi quyết
  định mà test vẫn xanh, test đó viết sai và phải sửa cùng lượt.
- Không yếu hoá assertion, không nới khẳng định để "cho qua" khi sửa spec đếm/cố định
  (registry capability, số bảng/uuidv7 trong baseline): đếm lại trên cây merge cuối
  và ghi con số thật.

## Chuẩn comment TSDoc (sổ quyết định mục F — chốt 13:14 ngày 26/10/2026)

Mọi code TypeScript viết mới hoặc sửa trong `apps/api` phải có comment **tiếng Việt
theo chuẩn TSDoc**, chi tiết nhất có thể — flow kỹ thuật phải nằm ngay trong code,
để lần sửa sau dựa vào nội dung code đang có chứ không dựa vào trí nhớ của trợ lý:

- Đầu mỗi file/module: khối TSDoc mô tả vai trò của file + flow tổng thể
  (dữ liệu vào → các bước xử lý → dữ liệu ra / side-effect).
- Mỗi hàm/class/giao diện trọng yếu: TSDoc `/** ... */` tiếng Việt gồm mục đích,
  `@param`/`@returns`, các bước flow, bất biến/ràng buộc, mã lỗi ném ra
  (mã ProblemDetails của `@lms/contracts`), side-effect (ghi DB, ghi outbox/phát
  sự kiện cho worker và realtime, gọi hệ ngoài).
- Logic phức tạp/nhánh rẽ quan trọng (gác capability theo context, cổng công bố
  điểm, khớp 3 điều kiện thanh toán, RLS/tenant): comment nội tuyến tiếng Việt
  nói bước flow và **lý do** — không lặp lại điều code đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example`/`@throws` khi cần); định danh và
  tên tag giữ tiếng Anh.
- Sửa code thì căn cứ vào comment flow đang có trong code; thấy comment lệch
  code thật thì sửa comment **trong cùng lượt** với sửa code.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  flow đạt chuẩn là chưa đạt. Code cũ chưa có comment được phủ theo đợt riêng
  của issue #272, không tự trộn việc phủ vào feat đang bay.

## Bản đồ flow của package

- **Điểm vào:** `src/main.ts` bootstrap ứng dụng NestJS (prefix `/api/v1`);
  `src/app.module.ts` lắp toàn bộ module; `src/review-seed.ts` là seed tài khoản
  demo phục vụ nghiệm thu.
- **Lớp cắt ngang:** `src/common/` — guard (`jwt-auth.guard`,
  `better-auth-session.guard`, `capability.guard`), decorator
  (`current-user`, `require-capability`, `public`), `problem-details.filter`
  (mọi lỗi ra theo khuôn ProblemDetails), middleware security headers,
  `client-ip`. `src/db/` — kết nối DB, schema Drizzle, `tenant-pool` (ngữ cảnh
  tenant/RLS theo request). Thêm `src/config/`, `src/infra/`, `src/i18n/`.
- **Luồng một request:** HTTP vào → guard xác thực (JWT/Better Auth) → thiết
  lập ngữ cảnh tenant → guard capability theo cây context → controller kiểm
  chứng body bằng schema route của `@lms/contracts` → service thực thi luật
  nghiệp vụ (giao dịch khi cần) → ghi/đọc DB qua Drizzle với `tenant_id` + RLS
  fail-closed → trả response đúng contract. Side-effect nền đi qua **outbox/sự
  kiện** cho `apps/worker` và realtime, không chạy việc nền dài trong request;
  hành động nhạy cảm ghi `event-log`/audit.
- **Module nghiệp vụ** nằm ở `src/modules/<tên>`, một module một miền:
  - Định danh & nền tảng: `auth`, `users`, `access`, `tenants`, `site-config`,
    `health`, `seed`.
  - Học tập cốt lõi: `classes`, `courses`, `enrol`, `groups`, `content`,
    `completion`, `availability`, `calendar`, `dashboard`.
  - Đánh giá & ngân hàng nội dung: `questions`, `exams`, `quiz`, `assignments`,
    `grades`, `paper-grading`, `content-bank`, `curriculum`, `books`.
  - Tương tác & vận hành: `messaging`, `mail`, `social`, `badges`,
    `competencies`, `custom-fields`, `files`, `backup`, `privacy`,
    `guardians`, `reports`, `analytics`, `search`, `event-log`,
    `integrations`, `payments`, `mcp`.
