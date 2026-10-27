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

## Đợt bổ sung nhóm mạch ngày 28/10/2026 (issue #335)

- Nền xuất phát: sau đợt #333, dataset còn 277/2.115 bản ghi rỗng cả
  ba trường `stream`/`section`/`topic` (đo lại trên main tại thời điểm
  bắt đầu: đúng 277, phân bổ theo môn khớp thân issue #335).
- Kết quả đợt này: 255 bản ghi được gán nhóm mạch/chủ đề; 22 bản ghi
  Giáo dục thể chất giữ nguyên rỗng kèm kết luận riêng từng bản ghi
  (mục Giáo dục thể chất dưới đây) — không ép gán. Tổng số bản ghi
  giữ 2.115; tổng số dòng YCCĐ hiện hành giữ 7.389; không bản ghi nào
  bị đổi chữ ở `content` hay YCCĐ (diff của đợt này chỉ gồm 255 dòng
  trường cấu trúc, mỗi bản ghi đúng một dòng).
- Quy tắc gán áp dụng thống nhất:
  - Trường gán theo đúng hình dạng của dataset đó: Âm nhạc, Khoa học
    tự nhiên, Vật lí gán `topic`; các môn còn lại gán `section`
    (Vật lí VL-0056 gán `section` chuyên đề; Sinh học SH-0102 chỉ gán
    `section`, để trống `topic` vì nhãn chủ đề của hàng đó không khôi
    phục được từ bản ghi — xem mục Sinh học).
  - Tên nhóm lấy đúng tên nhóm đã có trong cùng dataset khi nhóm đó
    đã xuất hiện ở bản ghi khác (để các bản ghi cùng nhóm rơi vào
    cùng một node cây); tên nhóm mới viết theo cùng quy cách viết hoa
    của dataset đó (dạng Title Case như `Trồng Trọt`,
    `Địa Lí Tự Nhiên`), ứng với tiêu đề trong văn bản nguồn viết
    thường theo câu.
  - Căn cứ gán theo thứ tự ưu tiên: (1) nhãn nhóm in ngay đầu nội
    dung bản ghi; (2) nội dung trùng nguyên văn với bản ghi đã có
    nhóm trong cùng dataset; (3) vị trí kẹp giữa hai nhóm trong cùng
    khối lớp và YCCĐ của bản ghi; (4) với bản ghi nối hai nhóm (đuôi
    nhóm trước + đầu nhóm sau), gán theo nhóm mà toàn bộ YCCĐ của bản
    ghi phục vụ, phần tiêu đề treo không có YCCĐ không quyết định.
  - Không sửa các giá trị `section`/`topic` đã có sẵn (kể cả các giá
    trị trông như bị rò từ nhóm kề trước ở một số bản ghi đã có mạch
    như KHTN-0021/0022, các bản ghi chuyên đề của Vật lí, các bản ghi
    Âm nhạc mang mảnh nội dung ở `topic`): các trường hợp đó nằm ngoài
    phạm vi đợt này (chỉ bổ sung cho 277 bản ghi rỗng cả ba trường)
    và được ghi nhận ở cuối mục này để đợt riêng xử lý.

### Âm nhạc — 95 bản ghi, gán `topic`

- Văn bản: `ct-amnhac-official.pdf`, trang 11–42.
- Cấu trúc gán (6 mạch nội dung của chương trình môn Âm nhạc, theo
  nhãn in đầu mỗi bản ghi): Hát (13), Nghe nhạc (13), Đọc nhạc (12),
  Nhạc cụ (14), Lí thuyết âm nhạc (9), Thường thức âm nhạc (30),
  cộng 4 bản ghi chuyên đề gán bằng chính tên chuyên đề.
- Chi tiết: AN-0001, AN-0007, AN-0014, AN-0015, AN-0022, AN-0043,
  AN-0054, AN-0064, AN-0075, AN-0076, AN-0087, AN-0098, AN-0108 → Hát;
  AN-0002, AN-0008, AN-0016, AN-0023, AN-0024, AN-0044, AN-0045,
  AN-0055, AN-0065, AN-0077, AN-0088, AN-0099, AN-0109 → Nghe nhạc;
  AN-0003, AN-0009, AN-0017, AN-0025, AN-0046, AN-0056, AN-0066,
  AN-0067, AN-0078, AN-0089, AN-0100, AN-0110 → Đọc nhạc; AN-0004,
  AN-0010, AN-0011, AN-0018, AN-0026, AN-0047, AN-0057, AN-0068,
  AN-0079, AN-0080, AN-0090, AN-0101, AN-0111, AN-0112 → Nhạc cụ;
  AN-0027, AN-0048, AN-0058, AN-0059, AN-0069, AN-0081, AN-0092,
  AN-0102, AN-0113 → Lí thuyết âm nhạc; AN-0005, AN-0006, AN-0012,
  AN-0013, AN-0019, AN-0020, AN-0021, AN-0042, AN-0049, AN-0050,
  AN-0051, AN-0052, AN-0060, AN-0061, AN-0062, AN-0063, AN-0070,
  AN-0071, AN-0072, AN-0073, AN-0074, AN-0082, AN-0083, AN-0084,
  AN-0085, AN-0086, AN-0103, AN-0104, AN-0114, AN-0115 → Thường thức
  âm nhạc (gồm các mục con: Tìm hiểu nhạc cụ, Câu chuyện âm nhạc,
  Tác giả và tác phẩm, Hình thức biểu diễn, Thể loại âm nhạc,
  Âm nhạc và đời sống); AN-0097 → Chuyên đề 10.3: Phương pháp xác
  định tiết điệu đệm; AN-0105 → Chuyên đề 11.1: Kĩ năng biểu diễn
  thanh nhạc; AN-0106 → Chuyên đề 11.2: Kĩ năng biểu diễn nhạc cụ;
  AN-0107 → Chuyên đề 11.3: Kĩ năng chỉ huy.
- Các bản ghi tiếp nối (nội dung bắt đầu bằng dấu gạch ngang hoặc
  mảnh câu thường, không có nhãn): gán theo mạch của bản ghi kề trước
  trong cùng mạch, ví dụ AN-0011 (mảnh thực hành tiết tấu) tiếp nối
  AN-0010 (nhãn Nhạc cụ); AN-0015 tiếp nối AN-0014 (Hát); AN-0024
  tiếp nối AN-0023 (Nghe nhạc); AN-0042 (Hình thức biểu diễn) tiếp
  nối nhóm Thường thức âm nhạc của lớp 5; AN-0071 tiếp nối AN-0070
  (Thường thức âm nhạc); AN-0084 tiếp nối AN-0083 (Thường thức âm
  nhạc).

### Công nghệ — 51 bản ghi, gán `section`

- Văn bản: `ct-congnghe-official.pdf`, trang 11–45.
- Tiểu học: CN-0001–CN-0006 (Tự nhiên và Công nghệ; Sử dụng đèn học,
  quạt điện, máy thu thanh, máy thu hình; An toàn với môi trường
  công nghệ trong gia đình) → Công Nghệ Và Đời Sống; CN-0008, CN-0009
  (Làm biển báo giao thông; Làm đồ chơi) → Thủ Công Kĩ Thuật;
  CN-0012 (mảnh `trong chậu`, toàn bộ YCCĐ về trồng hoa và cây cảnh
  trong chậu) → Công Nghệ Và Đời Sống.
- THCS: CN-0024 → Nhà Ở; CN-0025 → Bảo Quản Và Chế Biến Thực Phẩm;
  CN-0026 → Trang Phục Và Thời Trang; CN-0027 → Đồ Dùng Điện Trong
  Gia Đình; CN-0034 → Vẽ Kĩ Thuật; CN-0035 → Cơ Khí; CN-0036 →
  An Toàn Điện; CN-0037 → Kĩ Thuật Điện; CN-0038 → Thiết Kế Kĩ
  Thuật; CN-0039 → Nghề Nghiệp Trong Lĩnh Vực Kĩ Thuật, Công Nghệ;
  CN-0040 → Giáo Dục Kĩ Thuật, Công Nghệ Trong Hệ Thống Giáo Dục
  Quốc Dân; CN-0041 → Thị Trường Lao Động Kĩ Thuật, Công Nghệ Tại
  Việt Nam; CN-0042 → Lựa Chọn Nghề Nghiệp Trong Lĩnh Vực Kĩ Thuật,
  Công Nghệ.
- THPT (định hướng công nghiệp): CN-0060, CN-0061 → Khái Quát Về
  Công Nghệ; CN-0062 → Vẽ Kĩ Thuật; CN-0063 → Thiết Kế Kĩ Thuật;
  CN-0064–CN-0067 (Giới thiệu chung về cơ khí chế tạo; Vật liệu cơ
  khí; Các phương pháp gia công cơ khí; Sản xuất cơ khí) → Cơ Khí
  Chế Tạo; CN-0071–CN-0074 (Giới thiệu chung về kĩ thuật điện; Hệ
  thống điện quốc gia; Hệ thống điện trong gia đình; An toàn và tiết
  kiệm điện năng) → Kĩ Thuật Điện.
- THPT (định hướng nông nghiệp): CN-0080–CN-0087 → Trồng Trọt;
  CN-0088–CN-0093 → Chăn Nuôi; CN-0094–CN-0096 (Giới thiệu chung về
  lâm nghiệp; Trồng và chăm sóc rừng; Bảo vệ và khai thác tài nguyên
  rừng bền vững) → Lâm Nghiệp.

### Khoa học tự nhiên — 29 bản ghi, gán `topic`

- Văn bản: `ct-khtn-official.pdf`, trang 23–59.
- Lớp 6: KHTN-0001 (giới thiệu dụng cụ đo, quy tắc an toàn phòng thực
  hành) → Mở đầu; KHTN-0002–KHTN-0006 (Các thể của chất; Oxygen và
  không khí; Một số vật liệu, nhiên liệu, nguyên liệu; Chất tinh
  khiết, hỗn hợp, dung dịch; Tách chất ra khỏi hỗn hợp) → Chất và sự
  biến đổi của chất; KHTN-0007–KHTN-0009 (Tế bào – đơn vị cơ sở của
  sự sống; Sự lớn lên và sinh sản của tế bào; Từ tế bào đến cơ thể)
  → Tế bào.
- Lớp 8: KHTN-0045 (Mở đầu: dụng cụ, hoá chất, thiết bị điện của môn
  Khoa học tự nhiên 8) → Mở đầu; KHTN-0046–KHTN-0054 → Phản ứng hoá
  học; KHTN-0055–KHTN-0059 → Acid – Base – pH – Oxide – Muối;
  KHTN-0060 → Phân bón hoá học; KHTN-0061 → Khối lượng riêng và áp
  suất; KHTN-0062 → Tác dụng làm quay của lực; KHTN-0063 (Hiện tượng
  nhiễm điện; Dòng điện; Tác dụng của dòng điện; Nguồn điện; Mạch
  điện đơn giản) → Điện.
- Lớp 9: KHTN-0083 (Biện pháp duy trì cân bằng tự nhiên, tiếp nối
  KHTN-0082 cùng chủ đề) → Cân bằng tự nhiên.

### Hoạt động trải nghiệm — 24 bản ghi, gán `section`

- Văn bản: `ct-hdtn-official.pdf`, trang 13–39.
- HDTN-0001, HDTN-0002, HDTN-0016, HDTN-0017, HDTN-0024, HDTN-0025,
  HDTN-0032, HDTN-0033, HDTN-0040, HDTN-0041, HDTN-0048, HDTN-0049,
  HDTN-0056, HDTN-0057 (Hoạt động khám phá bản thân; Hoạt động rèn
  luyện bản thân) → Hoạt Động Hướng Vào Bản Thân.
- HDTN-0007 (Hoạt động tìm hiểu và bảo vệ môi trường; nội dung trùng
  với HDTN-0014 đã mang nhóm này) → Hoạt Động Hướng Đến Tự Nhiên.
- HDTN-0063, HDTN-0064, HDTN-0065, HDTN-0074, HDTN-0075, HDTN-0084,
  HDTN-0085, HDTN-0094, HDTN-0095 (Tìm hiểu nghề nghiệp; Rèn luyện
  phẩm chất, năng lực phù hợp với định hướng nghề nghiệp; Lựa chọn
  hướng nghề nghiệp và lập kế hoạch học tập) → Hoạt Động Hướng
  Nghiệp.
- Ghi nhận (không sửa trong đợt này): một số bản ghi có trường lớp
  ghi sau bản ghi kề trước trong cùng nhóm (ví dụ HDTN-0007 mang lớp
  2 nhưng nội dung thuộc nhóm Tự nhiên của lớp 1–2; các bản ghi hướng
  nghiệp lớp 9–12 xuất hiện cả ở đầu khối lớp và ở cuối khối lớp);
  việc gán chỉ dựa vào nội dung và YCCĐ, không đổi trường lớp.

### Vật lí — 20 bản ghi, gán `topic` (trừ VL-0056 gán `section`)

- Văn bản: `ct-vatli-official.pdf`, trang 17–28.
- VL-0029–VL-0032 (Dao động; Dao động điều hoà; Dao động tắt dần,
  hiện tượng cộng hưởng) → Dao động.
- VL-0057–VL-0060 (Sự chuyển thể; Nội năng, định luật 1 của nhiệt
  động lực học; Thang nhiệt độ, nhiệt kế; Nhiệt dung riêng, nhiệt
  nóng chảy riêng, nhiệt hoá hơi riêng) → Vật lí nhiệt. Riêng VL-0060
  mang thêm đầu đề `Khí lí tưởng` ở cuối nội dung nhưng toàn bộ
  YCCĐ của bản ghi đều về nhiệt dung riêng nên gán theo Vật lí nhiệt
  (quy tắc bản ghi nối hai nhóm).
- VL-0061–VL-0065 (Mô hình động học phân tử chất khí; Phương trình
  trạng thái; Áp suất khí theo mô hình động học phân tử; Động năng
  phân tử) → Khí lí tưởng. Riêng VL-0065 mang thêm đầu đề
  `Trường từ (Từ trường)` ở cuối nội dung nhưng toàn bộ YCCĐ đều về
  động năng phân tử nên gán theo Khí lí tưởng.
- VL-0066–VL-0068 (Khái niệm từ trường; Lực từ tác dụng lên đoạn dây
  dẫn mang dòng điện, cảm ứng từ; Từ thông, cảm ứng điện từ) →
  Trường từ (Từ trường). Riêng VL-0068 mang thêm đầu đề
  `Vật lí hạt nhân và phóng xạ` ở cuối nội dung nhưng toàn bộ YCCĐ
  đều về từ thông và cảm ứng điện từ nên gán theo Trường từ.
- VL-0069–VL-0071 (Cấu trúc hạt nhân; Độ hụt khối và năng lượng liên
  kết hạt nhân; Sự phóng xạ và chu kì bán rã) → Vật lí hạt nhân và
  phóng xạ.
- VL-0056 (Thiết bị cảm biến; toàn bộ YCCĐ về ứng dụng và nguyên tắc
  hoạt động của thiết bị cảm biến; đầu đề `Vật lí nhiệt` ở cuối nội
  dung không có YCCĐ nào) → `section` Chuyên đề 11.3. Mở đầu về điện
  tử học (cùng chuyên đề với VL-0054, VL-0055).

### Mĩ thuật — 13 bản ghi, gán `section`

- Văn bản: `ct-mithuat-official.pdf`, trang 12–56.
- MT-0001, MT-0002 (hai mảnh của cùng một nội dung Tạo hình lớp 1:
  MT-0001 dừng ở thể loại Đồ hoạ, MT-0002 tiếp nối bằng Điêu khắc
  rồi tới thực hành và định hướng chủ đề) → Mĩ Thuật Tạo Hình.
- MT-0004 (Thể loại: Thủ công), MT-0008 (mảnh thực hành thủ công
  3D), MT-0013 (mảnh định hướng chủ đề đồ chơi, đồ dùng học tập),
  MT-0017 (Thể loại: Thủ công), MT-0021 (thực hành thủ công 2D/3D),
  MT-0025 (định hướng chủ đề văn hoá, xã hội; YCCĐ về tính ứng dụng
  của sản phẩm thiết kế), MT-0029 (thể loại Thiết kế công nghiệp,
  Thiết kế đồ hoạ, Thiết kế thời trang; thực hành sản phẩm thiết kế)
  → Mĩ Thuật Ứng Dụng (thủ công và thiết kế thuộc mạch ứng dụng,
  theo MT-0007 và MT-0011/MT-0012 đã mang nhóm này với cùng nội dung
  thủ công).
- MT-0035 (mảnh định hướng chủ đề `Mĩ thuật tạo hình và ngành nghề`)
  → Mĩ Thuật Tạo Hình. Ghi nhận mức tin cậy trung bình: bản ghi đứng
  ngay sau MT-0034 (Chủ Đề: Hướng Nghiệp) nên cũng có thể đọc là
  mảnh đuôi của bản ghi hướng nghiệp; căn cứ chọn Tạo hình là tiêu
  đề định hướng chủ đề ghi rõ `Mĩ thuật tạo hình`.
- MT-0040 (định hướng chủ đề `Mĩ thuật ứng dụng và ngành nghề`;
  YCCĐ về các ngành nghề liên quan đến mĩ thuật ứng dụng) → Mĩ
  Thuật Ứng Dụng.
- MT-0059 (mảnh `Sản phẩm thực hành của học sinh`, đứng giữa hai bản
  ghi Chuyên đề 10.2, không có YCCĐ) → Chuyên đề 10.2: THỰC HÀNH VẼ
  TRANG TRÍ 1.
- MT-0079 (Thực hành vẽ tranh bố cục nhân vật; thảo luận tranh bố
  cục nhân vật; định hướng chủ đề Tự chọn) → Chuyên đề 11.3: THỰC
  HÀNH VẼ TRANH BỐ CỤC 2 (tiếp nối MT-0078 cùng chuyên đề).

### Địa lí — 12 bản ghi, gán `section`

- Văn bản: `ct-diali-official.pdf`, trang 9–29.
- DL-0001 (không có YCCĐ; tiêu đề mở đầu) và DL-0002 (YCCĐ về vai trò
  của môn Địa lí và các ngành nghề liên quan; đầu đề `Sử dụng bản
  đồ` ở cuối nội dung không có YCCĐ) → Môn Địa Lí Với Định Hướng
  Nghề Nghiệp.
- DL-0003 (YCCĐ về các phương pháp biểu hiện trên bản đồ, sử dụng
  bản đồ, GPS và bản đồ số; đầu đề `Trái Đất` ở cuối nội dung không
  có YCCĐ) → Sử Dụng Bản Đồ.
- DL-0019–DL-0023 (Sự khác biệt về trình độ phát triển kinh tế – xã
  hội của các nhóm nước; Toàn cầu hoá, khu vực hoá kinh tế và an
  ninh toàn cầu; Nền kinh tế tri thức) → Địa Lí Kinh Tế – Xã Hội
  (phần địa lí kinh tế – xã hội thế giới mở đầu lớp 11, trước phần
  Địa lí khu vực và quốc gia từ DL-0024).
- DL-0038–DL-0041 (Vị trí địa lí, phạm vi lãnh thổ; Thiên nhiên nhiệt
  đới ẩm gió mùa; Sự phân hoá đa dạng của thiên nhiên; Sử dụng hợp
  lí tài nguyên thiên nhiên và bảo vệ môi trường) → Địa Lí Tự Nhiên
  (phần địa lí tự nhiên Việt Nam mở đầu lớp 12, trước phần Địa lí
  dân cư từ DL-0042).

### Hoá học — 5 bản ghi, gán `section`

- Văn bản: `ct-hoahoc-official.pdf`, trang 11–36.
- HH-0001 (đối tượng nghiên cứu, phương pháp học tập và nghiên cứu,
  vai trò của hoá học) → Nhập Môn Hoá Học (chủ đề mở đầu lớp 10).
- HH-0028 (Vẽ cấu trúc phân tử; Thực hành thí nghiệm hoá học ảo;
  Tính tham số cấu trúc và năng lượng; YCCĐ về công thức Lewis, thí
  nghiệm ảo và tính toán bán kinh nghiệm) → Chuyên đề 10.1: CƠ SỞ
  HOÁ HỌC. Ghi nhận mức tin cậy trung bình: bản ghi đứng sau các
  bản ghi Chuyên đề 10.2 nên vị trí gợi ý 10.2, nhưng toàn bộ nội dung
  và YCCĐ đều thuộc khối cơ sở hoá học (cấu trúc phân tử, tính toán
  tham số) chứ không liên quan tới phòng chống cháy nổ; gán theo nội
  dung, không theo vị trí.
- HH-0062 → Amine (Amin); HH-0063 → Amino Acid (Amino Axit), Peptide
  (Peptit) Và Protein; HH-0064 (Protein và enzyme; YCCĐ về protein
  và vai trò của enzyme) → cùng nhóm với HH-0063 (enzyme xét trong
  phần protein của chủ đề amino acid, peptide và protein).

### Lịch sử — 5 bản ghi, gán `section`

- Văn bản: `ct-lichsu-official.pdf`, trang 11–50.
- LS-0001 (Lịch sử hiện thực và nhận thức lịch sử; Sử học: khái
  niệm, đối tượng, chức năng, nguyên tắc, nguồn sử liệu, phương pháp)
  → Lịch Sử Hiện Thực Và Nhận Thức Lịch Sử.
- LS-0002 (Vai trò, ý nghĩa của tri thức lịch sử; Học tập và khám phá
  lịch sử suốt đời) → Tri Thức Lịch Sử Và Cuộc Sống.
- LS-0031 (Kết quả, ý nghĩa của các cuộc cách mạng tư sản; YCCĐ duy
  nhất về kết quả và ý nghĩa) → Các Cuộc Cách Mạng Tư Sản. Ghi nhận
  mức tin cậy trung bình: bản ghi chỉ bao phủ phần kết quả/ý nghĩa,
  không bao phủ toàn bộ chủ đề cách mạng tư sản; tên nhóm lấy theo
  chủ thể của nội dung bản ghi.
- LS-0032 (Sự xác lập chủ nghĩa tư bản ở châu Âu và Bắc Mỹ; Chủ nghĩa
  đế quốc và xâm lược thuộc địa; Chủ nghĩa tư bản từ tự do cạnh
  tranh sang độc quyền; Chủ nghĩa tư bản hiện đại) → Sự Phát Triển
  Của Chủ Nghĩa Tư Bản.
- LS-0063 (Danh sách gợi ý lựa chọn danh nhân khoa học – công nghệ
  và giáo dục – đào tạo: Chu Văn An, Lê Quý Đôn, Tuệ Tĩnh, Trần Đại
  Nghĩa, Tôn Thất Tùng, Đào Duy Anh, …; YCCĐ về sưu tầm tư liệu và
  nhận xét đóng góp của danh nhân) → Chuyên đề 11.3: DANH NHÂN
  TRONG LỊCH SỬ VIỆT NAM (cùng chuyên đề với LS-0059–LS-0062; bản
  ghi mang lớp 12 nhưng nội dung thuộc chuyên đề lớp 11 — ghi nhận
  lệch lớp, không sửa trường lớp trong đợt này).

### Sinh học — 1 bản ghi, gán `section`

- Văn bản: `ct-sinhhoc-official.pdf`, trang 40.
- SH-0102 (Khái niệm vệ sinh an toàn thực phẩm; Các nguyên nhân gây
  ngộ độc thực phẩm; Tác hại của mất vệ sinh an toàn thực phẩm;
  Biện pháp phòng và điều trị ngộ độc thực phẩm; đầu đề
  `Di truyền phân tử` ở cuối nội dung không có YCCĐ) → Sinh Học Cơ
  Thể (phần sinh học cơ thể của chương trình môn Sinh học; các phần
  còn lại đã có trong dataset là Sinh học tế bào, Sinh học vi sinh
  vật và virus, Di truyền học, Tiến hoá, Sinh thái học và môi
  trường). `topic` để trống vì nhãn chủ đề của hàng này không khôi
  phục được từ bản ghi (các bản ghi SH-0098–SH-0101 cùng vùng mang
  `topic` Sinh sản ở động vật – nhưng đó là mảnh đuôi của nhóm kề
  trước, không phải nhãn chủ đề của hàng này — xem ghi nhận cuối
  mục).

### Giáo dục thể chất — 22 bản ghi, GIỮ NGUYÊN kèm kết luận riêng

- Văn bản: `ct-gdtc-official.pdf`, trang 8–23.
- Kết luận chung: mỗi bản ghi Giáo dục thể chất là một đoạn trích
  theo trang của bảng cả lớp, chứa nội dung thuộc nhiều nhóm cùng
  lúc (Kiến thức chung, Vận động cơ bản, Thể thao tự chọn / Môn thể
  thao tự chọn) hoặc là phần tiếp nối của một khối như vậy; không
  bản ghi nào nằm trọn trong đúng một nhóm duy nhất. Gán một nhóm
  duy nhất cho bất kỳ bản ghi nào cũng đều bóp méo nội dung của nó,
  nên cả 22 bản ghi giữ nguyên rỗng cả ba trường theo điều khoản kết
  luận riêng của issue #335. Việc tách các bản ghi này về đúng hạt
  nhóm thuộc đợt tách bản ghi riêng, ngoài phạm vi đợt này (đợt này
  không đổi định danh và không tách/gộp bản ghi).
- Kết luận từng bản ghi (nhóm xuất hiện trong nội dung; `tiếp nối`
  nghĩa là bản ghi không chứa tiêu đề nhóm nhưng toàn bộ nội dung là
  phần tiếp theo của khối đó):
  - GDTC-0001 (lớp 1, trang 8): Kiến thức chung, Vận động cơ bản.
  - GDTC-0002 (lớp 2, trang 9): tiếp nối Thể thao tự chọn (nội dung
    lựa chọn môn thể thao phù hợp với lứa tuổi).
  - GDTC-0003 (lớp 2, trang 9): Kiến thức chung, Vận động cơ bản.
  - GDTC-0004 (lớp 3, trang 10): tiếp nối Thể thao tự chọn.
  - GDTC-0005 (lớp 3, trang 10): Kiến thức chung, Vận động cơ bản.
  - GDTC-0006 (lớp 4, trang 11): tiếp nối Thể thao tự chọn.
  - GDTC-0007 (lớp 4, trang 11–12): Kiến thức chung, Vận động cơ bản.
  - GDTC-0008 (lớp 5, trang 12): tiếp nối Thể thao tự chọn.
  - GDTC-0009 (lớp 5, trang 12): Kiến thức chung, Vận động cơ bản.
  - GDTC-0010 (lớp 6, trang 13): tiếp nối Thể thao tự chọn.
  - GDTC-0011 (lớp 6, trang 13–14): Kiến thức chung, Vận động cơ bản.
  - GDTC-0012 (lớp 6, trang 14): tiếp nối Thể thao tự chọn.
  - GDTC-0013 (lớp 7, trang 15–16): Kiến thức chung, Vận động cơ bản,
    Thể thao tự chọn.
  - GDTC-0014 (lớp 8, trang 16): tiếp nối Thể thao tự chọn (định
    hướng lựa chọn môn thể thao theo điều kiện địa phương, nhà
    trường).
  - GDTC-0015 (lớp 8, trang 16–17): Kiến thức chung, Vận động cơ bản.
  - GDTC-0016 (lớp 8, trang 17): tiếp nối Thể thao tự chọn.
  - GDTC-0017 (lớp 9, trang 18–19): Kiến thức chung, Vận động cơ bản.
  - GDTC-0018 (lớp 10, trang 19): Kiến thức chung, Thể thao tự chọn,
    Môn thể thao tự chọn.
  - GDTC-0019 (lớp 11, trang 20): tiếp nối Môn thể thao tự chọn
    (danh sách các môn thể thao truyền thống của địa phương).
  - GDTC-0020 (lớp 11, trang 20): Kiến thức chung, Thể thao tự chọn,
    Môn thể thao tự chọn.
  - GDTC-0021 (lớp 11, trang 21): tiếp nối Môn thể thao tự chọn
    (định hướng lựa chọn môn thể thao trong Hội khoẻ Phù đổng và
    các giải quốc gia, quốc tế).
  - GDTC-0022 (lớp 12, trang 22–23): Kiến thức chung, Thể thao tự
    chọn, Môn thể thao tự chọn.

### Số liệu sau đợt bổ sung ngày 28/10/2026

- Tổng số bản ghi: 2.115 (không đổi).
- Tổng số dòng YCCĐ hiện hành: 7.389 (không đổi).
- Bản ghi đã gán nhóm: 255; bản ghi còn rỗng cả ba trường: 22 (toàn
  bộ thuộc Giáo dục thể chất, đã có kết luận riêng ở trên).
- Cây chương trình và dump đông cứng: xem thân PR của đợt này (số
  node mạch/chủ đề mới sinh được đếm lại từ DB chuẩn sau khi nạp
  bằng importer; dump version mới `2026-10-28.1`).
- Cổng toàn vẹn đạt trên toàn bộ 21 file sau bổ sung (kiểm chứng
  bằng importer khi nạp và bằng spec kiểm kê dataset).

### Ghi nhận ngoài phạm vi đợt này (không sửa)

- Một số bản ghi đã có mạch mang giá trị `topic`/`section` trông như
  bị rò từ nhóm kề trước (ví dụ: KHTN-0021 `Các phép đo` và KHTN-0022
  `Lực` mang `topic` Đa dạng thế giới sống; các bản ghi chuyên đề
  11.3 của Vật lí VL-0054, VL-0055 mang `topic` Dòng điện, mạch điện;
  các bản ghi Âm nhạc lớp 5, 10, 12 mang mảnh nội dung ở `topic`;
  các bản ghi SH-0098–SH-0101 (vùng sinh học cơ thể) mang `topic`
  Sinh sản ở động vật – trong khi `section` trống). Các giá trị này
  thuộc về bản ghi đã có mạch nên đợt này không đụng tới; việc rà
  soát và sửa chúng (nếu xác nhận là rò) thuộc đợt riêng.
- Một số bản ghi mang trường lớp lệch so với khối nội dung kề trước
  (ví dụ HDTN-0007, LS-0063, MT-0059, MT-0079, CN-0012): đợt này chỉ
  gán nhóm theo nội dung và YCCĐ, không sửa trường lớp.
