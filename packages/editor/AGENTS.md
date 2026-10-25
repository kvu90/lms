# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/editor`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của editor.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT;
   tài liệu mới hơn không tự thắng sổ; mâu thuẫn thì DỪNG và báo main chat.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Chỉ soạn/xem rich-text; nghiệp vụ bao quanh thuộc
  apps/api + apps/web.
- Đổi tập extension/định dạng tài liệu là đổi hợp đồng nội dung — phải đi cùng
  thay đổi ở `packages/contracts` trong cùng feat khi hình dạng thay đổi.

## Điều cấm package-specific

- Cấm lưu/nhận nội dung dạng HTML tự do ngoài hợp đồng rich-text của contracts.
- Cấm thêm extension mà phía xem tĩnh (`RichTextView`) không render được — mọi
  nút/định dạng phía soạn phải có đường hiển thị tương ứng phía xem.
- Cấm nhúng logic nghiệp vụ (gác quyền, trạng thái nộp/chấm) vào editor.
- Cấm apps/web tự chế editor khác thay package này — phát hiện bề mặt tự chế thì
  ghi nhận vào issue của feat, không âm thầm duy trì hai editor.

## Kiểm chứng bắt buộc

- **Typecheck + test của package trước khi push**: `pnpm --filter @lms/editor
  typecheck` và `pnpm --filter @lms/editor test`; build lại `dist` trước khi
  typecheck apps/web trong cùng feat.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT. Suite nặng local giữ khoá
  `flock ~/workspace/lms-nest-ops/heavy-suite.lock`.

## Kỷ luật test theo nghiệp vụ

- Test phải thể hiện luồng soạn–lưu–xem thật: soạn nội dung theo định dạng đã chốt
  → xem tĩnh hiển thị đúng cùng nội dung; nội dung ngoài hợp đồng bị từ chối.
  Không test chi tiết nội bộ của TipTap (thứ tự plugin, cấu trúc transaction).
- Thêm một khả năng soạn mới mà test phía xem không có ca tương ứng = chưa xong.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
