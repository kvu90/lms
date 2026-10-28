# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/db-schema`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của db-schema.
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
- Chỉ định nghĩa dữ liệu. Cần hành vi → `apps/api`; cần hình dạng API →
  `packages/contracts`.

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

- **Typecheck + build trước khi push**: `pnpm --filter @lms/db-schema typecheck`
  và build lại `dist`, rồi mới typecheck apps/api + apps/worker.
- Kiểm chứng migrate phải làm trên **cây merge** (hoặc chờ CI trên PR): kiểm trên
  cây branch riêng không đủ — bẫy hai baseline chỉ lộ ở cây merge.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Suite nặng local giữ khoá
  `flock /tmp/lms-heavy-suite.lock`, tối đa một vòng nặng một lúc.

## Kỷ luật test theo nghiệp vụ

- Bất biến dữ liệu phải có spec khoá: số bảng, số mặc định uuidv7, số policy RLS,
  index dẫn đầu cho FK — đếm lại trên baseline cuối và ghi con số thật, không nới
  khẳng định cho qua.
- Đổi một quan hệ nghiệp vụ trong schema (vd lớp–khoá, tenant) mà spec ở apps/api
  vẫn xanh nguyên = test chưa bám nghiệp vụ; bổ sung/sửa spec trong cùng PR.

## Chuẩn comment TSDoc

Mọi code TypeScript viết mới hoặc sửa trong `packages/db-schema` phải có comment
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
