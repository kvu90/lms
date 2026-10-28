# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/ui`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — bất biến shadcn, cách đồng bộ, danh sách ngoại lệ
   đã ghi chép.
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

- 1 issue = 1 feat = 1 PR. Package chỉ chứa lớp component nền shadcn/ui.
- Vỏ nghiệp vụ (bọc component theo luồng GV/HS) thuộc `apps/web/src/components/`.

## Điều cấm package-specific

- Cấm sửa tay file do shadcn CLI sinh ra (`src/components/**`,
  `src/styles/globals.css`) ngoài quy trình CLI/chuyển preset có ghi chép trong
  README. Ngoại lệ bất khả kháng: sửa tối thiểu + **ghi vào mục "Ngoại lệ" ở cuối
  README kèm lý do, trong cùng commit**.
- Cấm đặt component nghiệp vụ/mã tự viết của dự án vào package này.
- Cấm đổi preset/nền (Radix ↔ Base UI…) tự phát — chuyển nền là quy trình riêng
  có ghi chép, kèm kiểm chứng build + test của `@lms/web`.
- Cấm phá tính nhất quán vỏ dùng chung: thêm biến thể hình thức cho một trang
  riêng ở tầng package này.

## Kiểm chứng bắt buộc

- Sau mọi thay đổi/đồng bộ: `turbo run typecheck --filter=@lms/ui` + build và
  test targeted của `@lms/web`; đối chiếu diff `components.json` và
  `src/styles/globals.css` trước khi commit.
- **Typecheck trước khi push** là bắt buộc; build lại `dist` của package trước
  khi kết luận lỗi ở apps/web.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Suite nặng local giữ khoá
  `flock /tmp/lms-heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Package này không mang nghiệp vụ nên không bịa test nghiệp vụ: kiểm chứng là
  typecheck + test của app tiêu thụ (apps/web) thể hiện luồng người dùng còn
  nguyên vẹn sau thay đổi ở package.
- Đổi hành vi một component nền (đóng/mở, focus, phím…) phải có ca kiểm ở phía
  app thể hiện hành vi người dùng quan sát được, không test class nội bộ.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.

## Tính chất vendored & đợt phủ comment TSDoc (sổ mục F — chốt 14:40 ngày 26/10/2026)

Toàn bộ code trong package này là **code shadcn vendored** (sinh bằng shadcn
CLI từ upstream, xem `components.json` và README) — không phải code nghiệp vụ
của dự án. Hệ quả đã chốt trong sổ quyết định:

- **LOẠI HẲN khỏi đợt phủ comment TSDoc** (issue #272 và mọi đợt phủ sau):
  tuyệt đối **không viết comment TSDoc** (kể cả comment flow tiếng Việt theo
  chuẩn mục F) vào bất kỳ file code nào của package này. Chuẩn comment mục F
  áp cho code do dự án tự viết (apps/*, packages/contracts, packages/editor…)
  — không áp cho code vendored ở đây.
- **Hạn chế sửa trực tiếp** code vendored: thay đổi đi qua quy trình shadcn
  CLI / đồng bộ theo upstream như README và mục "Điều cấm" ở trên đã ghi;
  ngoại lệ bất khả kháng phải sửa tay thì sửa tối thiểu và ghi vào mục
  "Ngoại lệ" ở cuối README kèm lý do, trong cùng commit — để lần đồng bộ
  upstream sau không âm thầm mất dấu chỗ đã sửa.
- Cần hành vi khác cho một luồng nghiệp vụ cụ thể thì **bọc component ở
  `apps/web/src/components/`**, không sửa bản vendored để phục vụ một trang.
- Vì tính chất trên, AGENTS.md của package này **không có bản đồ flow nghiệp
  vụ**: package không mang flow nghiệp vụ nào — luồng người dùng nằm ở
  `apps/web`, package chỉ cung cấp component nền.
