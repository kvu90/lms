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

## Chuẩn comment TSDoc (sổ quyết định mục F — chốt 13:14 ngày 26/10/2026)

Mọi code TypeScript/TSX viết mới hoặc sửa trong `packages/editor` phải có
comment **tiếng Việt theo chuẩn TSDoc**, chi tiết nhất có thể — flow kỹ thuật
phải nằm ngay trong code, để lần sửa sau dựa vào nội dung code đang có chứ
không dựa vào trí nhớ của trợ lý:

- Đầu mỗi file: khối TSDoc mô tả vai trò của file + flow tổng thể (tài liệu
  vào ở dạng nào → các bước biến đổi/soạn → tài liệu ra / hành vi hiển thị).
- Mỗi component/extension/hàm trọng yếu: TSDoc `/** ... */` tiếng Việt gồm
  mục đích, `@param`/`@returns` (props của component, tham số của hàm biến
  đổi tài liệu), các bước flow, bất biến của định dạng tài liệu (điều phía xem
  tĩnh phải render được), side-effect (sự kiện `onChange`, portal toolbar,
  panel phủ).
- Logic biến đổi tài liệu phức tạp (dọn paragraph tiếp nối ở cuối tài liệu,
  bảo đảm đoạn viết tiếp khi nạp): comment nội tuyến tiếng Việt nói bước flow
  và **lý do** — không lặp lại điều code đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example` khi cần); định danh và tên
  tag giữ tiếng Anh.
- Sửa code thì căn cứ vào comment flow đang có trong code; thấy comment lệch
  code thật thì sửa comment **trong cùng lượt** với sửa code.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  flow đạt chuẩn là chưa đạt. Code cũ chưa có comment được phủ theo đợt riêng
  của issue #272, không tự trộn việc phủ vào feat đang bay.

## Bản đồ flow của package

- **Thành phần chính:** `src/RichTextEditor.tsx` — trình soạn (TipTap 3);
  `src/RichTextView.tsx` — trình xem tĩnh cùng định dạng; `src/extensions.ts`
  — tập extension đã chốt của hợp đồng nội dung (gồm `UndoRedo`); `src/math.ts`
  + `src/MathEditorPanel.tsx` — soạn công thức bằng panel phủ (overlay);
  `src/document-continuation.ts` — chuẩn hoá đuôi tài liệu
  (`ensureTerminalContinuation` khi nạp, dạng đem-lưu `contentForSave` khi
  phát); `src/editor.css` — vỏ vùng soạn + toolbar; xuất qua `src/index.ts`;
  test ở `src/editor.spec.tsx`.
- **Luồng dữ liệu:** `apps/web` gắn editor với tài liệu đầu vào đúng hợp đồng
  rich-text của `@lms/contracts` → tài liệu được bảo đảm đoạn viết tiếp ở
  cuối → người dùng soạn qua **một toolbar duy nhất cho editor đang active**
  (portal vào `#editor-toolbar-slot` ở header trang khi trang có slot, không
  có thì neo trên editor; mất focus thì ẩn) → mỗi thay đổi phát qua `onChange`
  ở dạng đem-lưu → web gửi API lưu. Phía học sinh/người xem không qua editor:
  cùng tài liệu được `RichTextView` render tĩnh.
- Mọi nút/định dạng phía soạn phải có đường hiển thị tương ứng ở phía xem —
  đó là bất biến của hợp đồng nội dung (xem điều cấm ở trên).
