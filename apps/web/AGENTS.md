# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `apps/web`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của `apps/web`.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT về
   quyết định đang hiệu lực (sidebar, chuông thông báo, hiển thị nhóm "Học tập"… đều
   nằm ở đó). Tài liệu mới hơn không tự thắng sổ; mâu thuẫn thì DỪNG và báo main chat.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR; việc phát sinh của cùng feat comment vào đúng issue đó.
- Chỉ trình bày + dẫn luồng. Thấy thiếu gác quyền ở API thì ghi nhận/báo, không tự
  "vá" bằng cách giấu phần tử giao diện (bài học #134: giấu UI không phải là gác).

## Điều cấm package-specific

- Cấm sao chép component shadcn từ `packages/ui` vào `src/components/` để sửa riêng;
  cần đổi hành vi thì bọc component ở `apps/web/src/components/` hoặc sửa ở package ui
  theo quy trình của package đó.
- Cấm tự chế kiểu collapse/section/accordion riêng cho từng trang — dùng component
  dùng chung đã thống nhất; giữ nguyên hành vi đã nghiệm thu (trạng thái mở/đóng,
  neo URL + scroll) khi thay vỏ.
- Cấm hiển thị nguồn sách trên bề mặt học sinh làm bài, cấm hiển thị điểm chưa công
  bố cho HS/PH — kể cả khi API lỡ trả thừa trường (lọc ở tầng hiển thị + báo API sửa).
- Cấm dựng lại bề mặt blog/hỏi-đáp (đã gỡ theo chốt 25/10/2026) và cấm thêm mục điều
  hướng ngoài cấu trúc sidebar đã chốt trong sổ quyết định.
- Cấm đổi cấu trúc sidebar ngân hàng khác 3 mục top-level + tab Cá nhân/Hệ thống trong từng màn danh sách đã chốt (sổ mục B, chốt lại 26/10/2026 11:40).

## Kiểm chứng bắt buộc

- **Typecheck trước khi push**: `pnpm --filter @lms/web typecheck` (build của web có
  kèm typecheck). Dist cũ của `@lms/ui`/`@lms/editor`/`@lms/contracts` là nguồn lỗi
  type giả — build lại package phụ thuộc trước khi kết luận.
- Feat lớn xong phải có lượt nghiệm thu trên **trình duyệt thật** bằng tài khoản seed
  đổi đủ vai liên quan (tài khoản demo ghi công khai trong README gốc của repo — tự
  đọc mà dùng, tự gõ vào form đăng nhập, không hỏi ngược Lão gia, không chờ thẻ
  Secure Vault).
- Kiểm chứng gồm cả **tính nhất quán hình thức** (vỏ component, trạng thái hover,
  chevron, khoảng cách) — không chỉ kiểm cấu trúc/chức năng.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Local chỉ test targeted
  (`pnpm --filter @lms/web test -- <spec liên quan>`); suite nặng phải giữ khoá
  `flock ~/workspace/lms-nest-ops/heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Test web phải thể hiện luồng người dùng thật theo vai (GV tạo khoá trong lớp, HS
  chỉ thấy điểm đã công bố, HS không thấy nhóm ngân hàng…), không test chi tiết
  triển khai (tên class, cấu trúc DOM trung gian). Đổi quyết định nghiệp vụ thì test
  tương ứng phải fail — xanh giả là test sai, sửa cùng lượt.
- Neo URL/trạng thái điều hướng đã nghiệm thu là hành vi nghiệp vụ: test phải giữ
  được chúng khi refactor vỏ.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
