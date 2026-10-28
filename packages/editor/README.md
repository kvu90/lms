# @lms/editor — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

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
| Phía XEM nội dung (học sinh đọc đề/phản hồi) dùng trình render tĩnh (`RichTextView`, static renderer) — bề mặt học không tải cả bộ editor: nhẹ hơn và không có đường nào để người xem sửa nội dung qua giao diện xem. | `rich-text-view.tsx` |
| Annotation/phản hồi khi chấm bài: phản hồi gắn theo vị trí trên nội dung/ảnh (annotation vector theo trang + toạ độ %) là hướng đã chốt cho chấm/phản hồi theo năng lực — editor phục vụ việc soạn/gắn phản hồi đó, không tự định nghĩa vòng đời trả bài (vòng đời trả bài NGUYÊN TỬ nằm ở apps/api). | Research chấm/phản hồi 24/10/2026; issue #88 |
| **Vỏ editor (lát E1 #248, theo editor giaokhoa)**: package có CSS riêng `src/editor.css` (app nạp qua `@lms/editor/editor.css`) lo khung vùng soạn (bo góc, cao tối thiểu ~20rem trường chính / ~6rem trường phụ theo prop `size`), trạng thái `aria-pressed` của toolbar, và panel công thức dạng **overlay nổi**. Toolbar dùng **nút icon lucide** (bộ icon của hệ) theo đúng thông số thị giác của Button/Toggle ghost `icon-sm` của `@lms/ui` — package này KHÔNG import `@lms/ui` vì ui là package source-only cho Vite còn editor build dist bằng `tsc` (NodeNext, rootDir riêng); các nút vì vậy là `<button>` mang class trong `editor.css` + icon `lucide-react` (dependency trực tiếp, cùng phiên bản ui đang dùng). | Hồ sơ `editor-giaokhoa-gap-2026-10-26.md`; quyết định 11:20 ngày 26/10/2026 |
| **Hoàn tác/làm lại (lát E2 #248)**: extension `UndoRedo` của `@tiptap/extensions` nằm trong `plainTextExtensions`; hai nút ở đầu toolbar, disabled theo `can()`. Chỉ là hành vi soạn — không đổi hình dạng tài liệu. | Hồ sơ gap, trục 4 |
| **Một toolbar cho editor đang active (lát E3 #248, theo editor giaokhoa)**: toolbar chỉ hiện khi editor được focus và được portal vào `#editor-toolbar-slot` ở header trang nếu trang có slot (trang không có thì neo sticky trên editor); tương tác ra ngoài editor thì ẩn toolbar + đóng panel. Tài liệu phát qua `onChange` luôn là dạng đem-lưu `contentForSave` (dọn paragraph tiếp nối rỗng sau block nguyên tử ở cuối), tài liệu nạp vào được `ensureTerminalContinuation` bảo đảm paragraph viết tiếp — xem `src/document-continuation.ts`. | Hồ sơ gap, trục 3 + 14 |

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
- Nguồn: `rich-text-editor.tsx`, `rich-text-view.tsx`, `extensions.ts`; test ở
  `editor.spec.tsx`.
