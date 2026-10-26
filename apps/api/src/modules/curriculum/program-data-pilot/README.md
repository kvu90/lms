# Thí điểm biểu diễn YCCĐ dạng Tiptap JSONB — chờ duyệt mẫu (Refs #161)

Thư mục này nằm NGOÀI manifest nạp (`program-datasets.ts` không trỏ tới đây) —
chỉ để duyệt mẫu biểu diễn + chất lượng đọc–tách trước khi áp hàng loạt.
Sau khi mẫu được duyệt, nội dung `outcomes` của các file thí điểm sẽ thay
thẳng vào dataset thật (cùng hình dạng file), và thư mục này bị xoá.

## Biểu diễn đã chốt theo hợp đồng research (#233, tổng kết 6404321347)

- Mỗi YCCĐ = một Tiptap doc JSON trong `outcomes[]`; KHÔNG thêm trường nào
  cho YCCĐ ở dataset. Mã hiển thị suy ra: `<record.id>.<vị trí 2 số>` theo
  thứ tự trong `outcomes[]` (vd `AN-0038.02`) — vì vậy thứ tự outcomes phải
  đúng thứ tự nguyên văn.
- YCCĐ đơn: `doc > paragraph > text` (nguyên văn, giữ nguyên dấu câu).
- YCCĐ có ý con (xuất hiện ở các môn đợt hàng loạt — GDCD/KHTN dùng `+`):
  `doc > paragraph (ý cha) + bulletList > listItem > paragraph (ý con)`,
  lồng sâu hơn bằng `bulletList` trong `listItem`. KHÔNG phẳng hoá ý con.
- `outcome_text` giữ nguyên 100%, vai trò: bằng chứng truy vết + neo kiểm
  chứng trung thực khi nạp.
- Text canonical cho UUIDv5/hash — đúng một hàm trích: duyệt doc theo thứ
  tự; mỗi paragraph = một dòng (nối các node text, bỏ qua marks); listItem
  cho dòng paragraph của nó rồi đệ quy vào bulletList lồng; các dòng nối
  bằng `\n`, cắt khoảng trắng hai đầu. Đổi định dạng lưu không đổi ID.
- Cổng lỗi importer (lỗi cứng khi `outcomes[]` rỗng mà `outcome_text` đa
  gạch) chỉ bật ở commit cuối của đợt áp hàng loạt, SAU khi mọi dataset đã
  sạch — không nằm trong PR thí điểm này.
- Công thức toán: giữ nguyên văn chữ trong node text, không tự chế LaTeX;
  chuyển công thức theo kết luận research riêng, lệnh bổ sung sau.

## Phạm vi thí điểm

- `program-amnhac.pilot.json` — TOÀN BỘ môn Âm nhạc đã đọc–tách tay:
  118 bản ghi; 115 bản ghi có outcome_text (trước: 115 dòng YCCĐ dạng cục)
  → **456 YCCĐ**; 3 bản ghi không có outcome (AN-0015, AN-0059, AN-0067)
  giữ nguyên. Hậu kiểm tái dựng: nối các ý theo thứ tự phải khớp
  `outcome_text` từng ký tự — đạt 112/115; 3 bản ghi lệch có chủ đích nằm
  trong danh sách ngoại lệ dưới đây.
- `program-toan-congthuc.pilot.json` — 10 bản ghi Toán chứa ký hiệu/công
  thức (TOAN-0045, 0068, 0070, 0158, 0179, 0211, 0236, 0237, 0245, 0277):
  42 YCCĐ sẵn có chuyển nguyên văn sang doc (không đổi số lượng, không đổi
  chữ — gồm cả ký tự công thức đã bị phẳng hoá trong text layer như
  `y = ax2`, `(a + b)n`, ký tự private-use thay `≠`).

## Ngoại lệ đã đọc và quyết tay (đối chiếu PDF nguồn)

1. **AN-0038** (PDF ct-amnhac, tr.20): extraction làm trôi `2, 3.` sang
   cuối ý trước; PDF đặt trong ý `Cảm nhận được tính chất nhịp 2, 3.` →
   đã trả về đúng ý. Lưu ý: text layer có thể đã mất dấu `/` của phân số
   nhịp (2/4, 3/4) — giữ theo text layer, chờ đối chiếu bản in.
2. **AN-0048** (tr.23): bỏ artefact `4.` (số thứ tự của cột nội dung lọt
   vào); ranh giới `tính chất nhịp – Biết ghi chép` tách theo PDF (hai
   dòng gạch riêng); ý `Cảm nhận được tính chất nhịp` nguyên văn không có
   dấu chấm cuối — giữ không chấm. PDF text layer ghi `nhịp 44` (có thể
   là 4/4), dataset không có số — giữ theo dataset, ghi cờ.
3. **AN-0052 + AN-0053**: một ô nguồn bị extractor cắt đôi ở ranh trang —
   ý cuối của AN-0052 cụt (`...nghệ sĩ, nghệ nhân,`) và ý đầu của AN-0053
   là mảnh nối (`nhà nghiên cứu,...`). Giữ nguyên văn; việc gộp hai bản
   ghi ngoài phạm vi thí điểm, cần quyết riêng.
4. **AN-0069**: ý `Cảm nhận được tính chất nhịp , .` — số nhịp bị mất hẳn
   trong extraction; giữ đúng từng ký tự, ghi cờ.
5. **AN-0090 + AN-0091**: cùng artefact cắt đôi ô — ý cuối AN-0090 cụt ở
   `duy trì`, ý đầu AN-0091 là `được tốc độ ổn định.`. Giữ nguyên văn.
6. Âm nhạc **không có** ý con lồng nhau, không dùng dấu `−` (U+2212),
   không dùng `+` — đã đọc toàn bộ 118 bản ghi để kết luận; các biến thể
   này thuộc các môn đợt hàng loạt.
