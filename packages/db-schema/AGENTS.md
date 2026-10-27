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
  `flock ~/workspace/lms-nest-ops/heavy-suite.lock`, tối đa một vòng nặng một lúc.

## Kỷ luật test theo nghiệp vụ

- Bất biến dữ liệu phải có spec khoá: số bảng, số mặc định uuidv7, số policy RLS,
  index dẫn đầu cho FK — đếm lại trên baseline cuối và ghi con số thật, không nới
  khẳng định cho qua.
- Đổi một quan hệ nghiệp vụ trong schema (vd lớp–khoá, tenant) mà spec ở apps/api
  vẫn xanh nguyên = test chưa bám nghiệp vụ; bổ sung/sửa spec trong cùng PR.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
