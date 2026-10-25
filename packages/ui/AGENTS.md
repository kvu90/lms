# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/ui`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — bất biến shadcn, cách đồng bộ, danh sách ngoại lệ
   đã ghi chép.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT;
   tài liệu mới hơn không tự thắng sổ; mâu thuẫn thì DỪNG và báo main chat.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

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
  `flock ~/workspace/lms-nest-ops/heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Package này không mang nghiệp vụ nên không bịa test nghiệp vụ: kiểm chứng là
  typecheck + test của app tiêu thụ (apps/web) thể hiện luồng người dùng còn
  nguyên vẹn sau thay đổi ở package.
- Đổi hành vi một component nền (đóng/mở, focus, phím…) phải có ca kiểm ở phía
  app thể hiện hành vi người dùng quan sát được, không test class nội bộ.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
