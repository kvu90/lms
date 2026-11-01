# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/db`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của db.
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

- 1 issue = 1 feat = 1 PR: đổi schema + baseline sinh từ schema + spec đếm ở
  apps/api là các chặng của CÙNG một PR, không tách.
- Định nghĩa dữ liệu và — với phần đã chuyển sang Kysely — các hàm truy cập
  dữ liệu thuần (repository nhận handle, không giữ kết nối, không đọc ngữ
  cảnh app) thuộc package này. Cần hành vi nghiệp vụ → `apps/api`; cần hình
  dạng API → `packages/contracts`.

## Điều cấm package-specific

- Cấm tạo bảng nghiệp vụ thiếu `tenant_id`/ngoài khuôn RLS fail-closed đã chốt, trừ
  bảng nền tảng được nêu đích danh trong quyết định đã chốt.
- Cấm đổi khoá chính sang kiểu khác UUIDv7 cho bảng nghiệp vụ mới (ngoại lệ phải có
  quyết định riêng).
- Cấm regen/gộp baseline làm mất SQL RLS viết tay: baseline chứa các câu RLS mà
  drizzle-kit không sinh lại được — gộp phải giữ nguyên và kiểm chứng cây MERGE
  chứa đúng MỘT thư mục `*_baseline` (đếm THƯ MỤC, không đếm file).
- Cấm đổi FK của dữ liệu chuẩn GDPT về cascade (phải giữ `restrict`).
- Cấm literal múi giờ `Asia/Saigon` trong mọi SQL mặc định/giá trị sinh — chỉ
  `Asia/Ho_Chi_Minh`.

## Kiểm chứng bắt buộc

- **Typecheck + build trước khi push**: `pnpm --filter @lms/db typecheck`
  và build lại `dist`, rồi mới typecheck apps/api + apps/worker.
- Kiểm chứng migrate phải làm trên **cây merge** (hoặc chờ CI trên PR): kiểm trên
  cây branch riêng không đủ — bẫy hai baseline chỉ lộ ở cây merge.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Suite nặng local giữ khoá
  `flock /tmp/lms-heavy-suite.lock`, tối đa một vòng nặng một lúc.

## Kỷ luật khung Kysely (chiến dịch chuyển ORM)

- Kiểu của ba kho nằm ở `src/types/` và được SINH bằng lệnh `db:types`
  (kysely-codegen từ DB thật dựng từ rỗng bằng SQL mang dữ liệu). Cấm sửa
  tay file sinh; đổi hình dạng DB xong phải chạy lại `db:types` và commit
  kết quả sinh cùng lượt — CI kiểm `git diff` trên `src/types/` phải rỗng.
- Cấm bật camelCase ở mọi tầng (không `--camel-case` khi sinh kiểu, không
  `CamelCasePlugin` khi truy vấn): tên cột trong code giữ snake_case như DB.
- Cột jsonb có hình dạng nghiệp vụ (`$type<…>` phía Drizzle) phải có
  override từng cột trong `scripts/codegen/<kho>.json` ở cùng lượt chạm
  tới cột đó; `--type-mapping` của codegen là ánh xạ theo kiểu dữ liệu
  toàn cục, cấm dùng thay override từng cột.
- Mọi repository Kysely nhận handle qua kiểu của `src/client.ts`
  (`CentreDb`/`CentreTx`, `ControlPlaneDb`/`ControlPlaneTx`,
  `SystemBankDb`/`SystemBankTx`); cấm repository import từ `apps/*`, đọc
  ALS/ngữ cảnh app, tự mở pool hay đọc biến môi trường. Package không tự
  mở pool ở bất kỳ đâu ngoài harness test (`src/test-support/`).
- Một module thuộc hẳn về một ORM; cấm giao dịch lai (một thao tác mở
  đồng thời giao dịch Drizzle và giao dịch Kysely). Các file
  `src/*.schema.ts` của Drizzle đóng băng tới hạng mục gỡ Drizzle: không
  sửa, không xoá trong các PR chuyển đổi.
- Cổng đếm kiểu sinh trên cụm PG18: số cột `id` có mặc định `uuidv7()`
  theo catalog là trung tâm 187 / control plane 5 / ngân hàng hệ thống
  10 — đổi schema làm lệch các con số này phải cập nhật README của
  package bằng con số đếm thật trong cùng PR.

## Kỷ luật test theo nghiệp vụ

- Bất biến dữ liệu phải có spec khoá: số bảng, số mặc định uuidv7, số policy RLS,
  index dẫn đầu cho FK — đếm lại trên baseline cuối và ghi con số thật, không nới
  khẳng định cho qua.
- Đổi một quan hệ nghiệp vụ trong schema (vd lớp–khoá, tenant) mà spec ở apps/api
  vẫn xanh nguyên = test chưa bám nghiệp vụ; bổ sung/sửa spec trong cùng PR.

## Chuẩn comment TSDoc

Mọi code TypeScript viết mới hoặc sửa trong `packages/db` phải có comment
**tiếng Việt theo chuẩn TSDoc**, chi tiết nhất có thể — luồng nghiệp vụ của dữ
liệu phải nằm ngay trong code, để lần sửa sau dựa vào nội dung code đang có chứ
không dựa vào trí nhớ của trợ lý. Chuẩn ngôn ngữ chung của repo: code bằng tiếng
Anh (định danh, tên bảng/cột/hàm, chuỗi kỹ thuật); **comment — gồm cả comment
luồng nghiệp vụ — bằng tiếng Việt**; mọi tài liệu bằng tiếng Việt:

- Đầu mỗi file schema: khối TSDoc mô tả vai trò của nhóm bảng + luồng nghiệp vụ
  dữ liệu tổng thể (bảng phục vụ nghiệp vụ gì, quan hệ với các bảng khác, tầng
  nào ghi/đọc dữ liệu).
- Mỗi bảng/cột/hàm trọng yếu: TSDoc `/** ... */` tiếng Việt gồm mục đích, các
  bất biến và ràng buộc (khoá chính UUIDv7, `tenant_id` + RLS fail-closed, FK
  `restrict` đối với dữ liệu chuẩn GDPT…), giá trị mặc định và lý do chọn chúng.
- Logic phức tạp (cột jsonb mang cấu hình, cột suy biến phục vụ truy vấn, khoá
  tự nhiên của dữ liệu chuẩn): comment nội tuyến tiếng Việt nói bước xử lý và
  **lý do** — không lặp lại điều code đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example` khi cần); định danh và tên tag
  giữ tiếng Anh.
- Sửa code thì căn cứ vào comment đang có trong code; thấy comment lệch code
  thật thì sửa comment **trong cùng lượt** với sửa code.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  đạt chuẩn là chưa đạt. Comment tiếng Anh còn tồn đọng trong package được dịch
  theo đợt riêng của chương trình sửa chuẩn ngôn ngữ toàn repo, không tự trộn
  việc dịch vào feat đang bay.
