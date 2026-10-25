# @lms/editor — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật cao nhất về quyết định: sổ quyết định `~/workspace/lms-nest-ops/decisions.md`.

## Package phụ trách nghiệp vụ gì

`packages/editor` là **trình soạn thảo rich-text dùng chung** của sản phẩm: nơi giáo
viên soạn nội dung học tập — đề bài/câu hỏi, phản hồi chấm bài, nội dung bài học — và
nơi học sinh xem lại nội dung đó. Package gồm trình soạn (`RichTextEditor`) và trình
xem (`RichTextView`). Mọi bề mặt soạn thảo trong `apps/web` phải dùng package này,
không tự chế editor riêng theo trang — nội dung soạn ở đâu cũng phải mở/xem được ở
mọi bề mặt khác.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Nội dung soạn thảo lưu ở **dạng cấu trúc theo hợp đồng rich-text của `packages/contracts`**, không lưu HTML tự do — nhờ vậy nội dung render được nhất quán ở web, ở phía xem của học sinh, và kiểm soát được những gì được phép xuất hiện trong nội dung (không nhúng script/HTML tuỳ ý của người soạn vào trang người học). | Hợp đồng `rich-text.ts` của @lms/contracts |
| Phía XEM nội dung (học sinh đọc đề/phản hồi) dùng trình render tĩnh (`RichTextView`, static renderer) — bề mặt học không tải cả bộ editor: nhẹ hơn và không có đường nào để người xem sửa nội dung qua giao diện xem. | `RichTextView.tsx` |
| Annotation/phản hồi khi chấm bài: phản hồi gắn theo vị trí trên nội dung/ảnh (annotation vector theo trang + toạ độ %) là hướng đã chốt cho chấm/phản hồi theo năng lực — editor phục vụ việc soạn/gắn phản hồi đó, không tự định nghĩa vòng đời trả bài (vòng đời trả bài NGUYÊN TỬ nằm ở apps/api). | Research chấm/phản hồi 24/10/2026; issue #88 |

## Ranh giới — package này KHÔNG làm gì

- Không chứa logic nghiệp vụ của câu hỏi/bài tập/chấm bài: editor chỉ soạn và hiển
  thị nội dung; lưu, gác quyền, vòng đời thuộc `apps/api` + `apps/web`.
- Không chứa component giao diện chung ngoài soạn/xem rich-text (đó là
  `packages/ui`).
- Không tự định nghĩa định dạng tài liệu riêng: định dạng theo hợp đồng
  `packages/contracts`.

## Kỹ thuật tối thiểu

- Xây trên TipTap 3 (`@tiptap/*`); tập extension chốt ở `src/extensions.ts` — thêm
  extension mới là thay đổi hợp đồng nội dung, phải cân nhắc phía xem tĩnh render
  được hay không.
- Nguồn: `RichTextEditor.tsx`, `RichTextView.tsx`, `extensions.ts`; test ở
  `editor.spec.tsx`.
