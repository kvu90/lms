# Nhật ký đính chính dataset chương trình GDPT 2018

Tài liệu này là log đính chính của các dataset trong thư mục này
(`program-data/`, 21 file). Mọi chỗ sửa và mọi kết luận giữ nguyên đều
được ghi tại đây kèm số trang của văn bản nguồn đã đối chiếu.

## Quy tắc đính chính

- Dataset chép nguyên văn từ văn bản chính chủ ban hành kèm Thông tư
  32/2018/TT-BGDĐT. Chỉ sửa dữ liệu sau khi đối chiếu văn bản chính
  chủ của đúng trang đó; tuyệt đối không dựng lại văn bản không có
  trong nguồn chính chủ, kể cả khi phần còn lại của một ý đã mất.
- Mọi chỗ sửa đi qua quy trình: sửa ở dataset → nạp vào DB chuẩn bằng
  importer → các dòng bị gộp được đánh dấu rút (`retired_at`), không
  xoá dòng, ID của dòng giữ lại không đổi → xuất lại dump đông cứng
  với version mới → đếm lại và cập nhật mọi khẳng định số liệu bị
  ảnh hưởng.
- Công cụ chỉ dùng để kiểm đếm và hậu kiểm; cấm tách, gộp hay gán
  YCCĐ một cách cơ học bằng script. Mỗi kết luận dưới đây là kết luận
  đọc hiểu từng ca, kèm căn cứ trang.

## Đợt đính chính ngày 27/10/2026 (issue #333)

### TOAN-0006 — SỬA: gộp 4 mảnh thành một YCCĐ trọn câu

- Bản ghi: TOAN-0006, Toán lớp 1, văn bản `ct-toan-official.pdf`,
  trang 22–23.
- Hiện trạng trước sửa: ý đầu của bản ghi bị cắt thành 4 mảnh trong
  `outcomes[]` tại các dấu gạch ngang của phép liệt kê cặp:
  "Nhận biết được vị trí, định hướng trong không gian: trên" /
  "dưới, phải" / "trái, trước" / "sau, ở giữa." — trong khi
  `outcome_text` của chính bản ghi chứa trọn câu.
- Đính chính: gộp 4 mảnh thành đúng một tài liệu YCCĐ, giữ vị trí
  đầu của bản ghi:
  "Nhận biết được vị trí, định hướng trong không gian: trên – dưới,
  phải – trái, trước – sau, ở giữa."
  Hai ý còn lại của bản ghi giữ nguyên, chuyển về vị trí 2 và 3.
- Khi nạp bằng importer: dòng vị trí 1 được sửa chữ tại chỗ (giữ ID);
  3 dòng mảnh còn lại được đánh dấu rút (`retired_at`), không xoá;
  2 dòng còn lại chỉ đổi vị trí (giữ ID). Không có gắn kết câu hỏi
  hay ánh xạ sách nào trỏ vào các dòng bị ảnh hưởng trong DB chuẩn
  (DB chuẩn chỉ chứa dữ liệu chương trình; số đếm gắn kết trong báo
  cáo thay đổi của importer bằng 0).
- Kết quả: bản ghi TOAN-0006 còn 3 dòng YCCĐ hiện hành, ý đầu là một
  ý trọn câu khớp nguyên văn trang 22–23.

### TOAN-0065 — GIỮ NGUYÊN: mảnh tiếp nối qua ranh trang, không phải cắt tại dấu gạch ngang

- Bản ghi: TOAN-0065, Toán lớp 4, văn bản `ct-toan-official.pdf`,
  trang 37 (ý kề trước thuộc TOAN-0064, trang 36).
- Căn cứ: ý đầu "sau: các phân số có cùng mẫu số; có một mẫu số chia
  hết cho các mẫu số còn lại." là phần tiếp nối của ý cuối TOAN-0064
  "Thực hiện được phép cộng, phép trừ phân số trong những trường
  hợp" — hai mảnh ghép thành một câu trọn qua ranh trang 36–37.
  Đây là dạng cắt qua ranh giới bản ghi do ngắt trang, không phải
  dạng cắt tại dấu gạch ngang trong cùng một bản ghi như TOAN-0006.
- Kết luận: giữ nguyên cả hai bản ghi. Gộp qua ranh giới bản ghi sẽ
  làm đổi tổng số bản ghi và định danh hiển thị của các dòng, vượt
  phạm vi đính chính của đợt này (đợt này giữ nguyên tổng 2.115 bản
  ghi). Dạng cắt qua ranh trang được ghi nhận để đợt rà soát ranh
  giới bản ghi xử lý riêng.

### TOAN-0086 — GIỮ NGUYÊN: bản ghi artifact trích xuất, không phải dạng cắt tại dấu gạch ngang

- Bản ghi: TOAN-0086, Toán lớp 5, văn bản `ct-toan-official.pdf`,
  trang 42.
- Căn cứ: nội dung của bản ghi ("tìm hai số khi biết tổng (hoặc
  hiệu) và tỉ số của hai số đó;") đã có nguyên văn trong ý thứ hai
  của TOAN-0085; ý duy nhất của bản ghi ("tính tỉ số") là một mảnh
  không hoàn chỉnh — không có động từ, không có dấu kết câu — và
  không ghép thành câu hoàn chỉnh với bất kỳ ý kề nào trong dataset
  (nối với ý cuối TOAN-0085 "Vận dụng được tỉ lệ bản đồ để giải
  quyết" cho câu sai ngữ pháp). `outcome_text` của chính bản ghi
  chỉ chứa mảnh đó, không chứa câu trọn để gộp về như TOAN-0006.
- Kết luận: giữ nguyên, không xoá và không viết lại. Mảnh được giữ
  làm bằng chứng trích xuất; việc xử lý bản ghi artifact (gộp hay
  loại khỏi danh sách bản ghi) thuộc đợt rà soát ranh giới bản ghi,
  vì nó làm đổi tổng số bản ghi.

### TOAN-0121 — GIỮ NGUYÊN: mảnh tiếp nối qua ranh trang, không phải cắt tại dấu gạch ngang

- Bản ghi: TOAN-0121, Toán lớp 6, văn bản `ct-toan-official.pdf`,
  trang 54 (ý kề trước thuộc TOAN-0120, trang 53).
- Căn cứ: ý đầu "năng ứng với mặt xuất hiện của đồng xu,...)." là
  phần tiếp nối của ý cuối TOAN-0120 "Làm quen với mô hình xác suất
  trong một số trò chơi, thí nghiệm đơn giản (ví dụ: ở trò chơi tung
  đồng xu thì mô hình xác suất gồm hai khả" — hai mảnh ghép thành
  một câu trọn qua ranh trang 53–54.
- Kết luận: giữ nguyên, cùng lý do như TOAN-0065 (cắt qua ranh giới
  bản ghi, ngoài phạm vi đợt này).

### TOAN-0144 — GIỮ NGUYÊN: mảnh tiếp nối qua ranh trang, không phải cắt tại dấu gạch ngang

- Bản ghi: TOAN-0144, Toán lớp 7, văn bản `ct-toan-official.pdf`,
  trang 61 (ý kề trước thuộc TOAN-0143, trang 60).
- Căn cứ: ý đầu "môn học khác và trong thực tiễn." là phần tiếp nối
  của ý cuối TOAN-0143 "Thực hiện và lí giải được việc thu thập,
  phân loại dữ liệu theo các tiêu chí cho trước từ những nguồn: văn
  bản, bảng biểu, kiến thức trong các" — hai mảnh ghép thành một
  câu trọn qua ranh trang 60–61.
- Kết luận: giữ nguyên, cùng lý do như TOAN-0065.

### TOAN-0148 — GIỮ NGUYÊN: mảnh tiếp nối qua ranh trang, không phải cắt tại dấu gạch ngang

- Bản ghi: TOAN-0148, Toán lớp 7, văn bản `ct-toan-official.pdf`,
  trang 62 (ý kề trước thuộc TOAN-0147, trang 61).
- Căn cứ: ý đầu "của biến cố ngẫu nhiên trong các ví dụ đơn giản."
  là phần tiếp nối của ý cuối TOAN-0147 "Làm quen với các khái niệm
  mở đầu về biến cố ngẫu nhiên và xác suất" — hai mảnh ghép thành
  một câu trọn qua ranh trang 61–62.
- Kết luận: giữ nguyên, cùng lý do như TOAN-0065.

### LS-0047 — GIỮ NGUYÊN: hàng khái lược đủ ý, thiếu 0, thừa 0

- Bản ghi: LS-0047, Lịch sử lớp 11, văn bản `ct-lichsu-official.pdf`,
  trang 41.
- Bảng đối chiếu ý nguồn ↔ ý trong dataset cho hàng "Khái lược về
  cải cách" (nội dung: "Khái lược về cải cách – Khái niệm cải cách
  – Một số biểu hiện của các cuộc cải cách"):

  | Ý theo văn bản nguồn (trang 41) | Ý trong dataset | Kết quả |
  | --- | --- | --- |
  | Khái niệm cải cách | "Giải thích được khái niệm cải cách." | Khớp |
  | Một số biểu hiện của các cuộc cải cách | "Phân tích được những biểu hiện của các cuộc cải cách." | Khớp |

- Kết luận: trong phạm vi bản ghi LS-0047, thiếu 0 ý, thừa 0 ý;
  bản ghi giữ nguyên.
- Phát hiện ghi nhận kèm (không sửa trong đợt này): trong cùng
  chuyên đề "Một số cuộc cải cách lớn trong lịch sử Việt Nam (trước
  năm 1858)", hàng cải cách nhà Hồ không có bản ghi nào trong
  dataset — nội dung hàng này vắng mặt, chỉ còn một mảnh đuôi ở đầu
  bản ghi LS-0048 ("trong sự nghiệp cải cách và kháng chiến bảo vệ
  Tổ quốc."). LS-0048 nằm ngoài phạm vi sửa của đợt này nên không
  đụng tới; phần đầu của ý nhà Hồ không khôi phục được từ dataset
  nên tuyệt đối không dựng lại. Việc khôi phục hàng nhà Hồ cần trích
  lại trang 41 từ văn bản gốc và được xử lý ở đợt riêng.

### LS-0024, LS-0048 — KHÔNG ĐỤNG

- Hai bản ghi này giữ nguyên theo quy tắc toàn vẹn nguyên văn: phần
  đầu ý đã mất ngay trong chính văn bản nguồn, mảnh còn lại được giữ
  làm bằng chứng, không dựng lại.

## Số liệu sau đợt đính chính ngày 27/10/2026

- Tổng số bản ghi: 2.115 (không đổi).
- Tổng số dòng YCCĐ hiện hành: 7.389 (trước đợt: 7.392; giảm 3 do
  gộp TOAN-0006).
- Toán: 300 bản ghi, 852 dòng YCCĐ hiện hành (trước đợt: 855);
  trong DB chuẩn còn 3 dòng TOAN-0006 ở trạng thái đã rút.
- Lịch sử: 98 bản ghi, 341 dòng YCCĐ hiện hành (không đổi).
- Cây chương trình: 3.506 node, 146 chương trình (không đổi).
- Dump đông cứng: version mới `2026-10-27.1` (trước đợt:
  `2026-10-26.1`); tổng số dòng trong dump là 7.392 dòng YCCĐ (gồm
  3 dòng đã rút), khớp số dòng hiện hành 7.389 sau khi trừ dòng rút.
- Cổng toàn vẹn đạt trên toàn bộ 21 file sau sửa.
