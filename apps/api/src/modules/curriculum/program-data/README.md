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
- Cây chương trình sau khi nạp bằng importer (đếm trên DB chuẩn):
  3.637 node (trước đợt: 3.506; tăng 131 node mạch mới, toàn bộ kind
  `strand`); mạch `strand` 689 (trước đợt: 558); chủ đề `topic` 833
  (không đổi — mỗi bản ghi đợt này chỉ gán đúng một trường nên bậc
  đầu tiên có chữ thành node `strand` theo
  `programRecordAncestors()`); node bài học ở gốc cây còn 22 (trước
  đợt: 277; toàn bộ thuộc Giáo dục thể chất). Dump đông cứng version
  mới `2026-10-28.1` (trước đợt: `2026-10-27.1`); tổng số dòng trong
  dump là 7.392 dòng YCCĐ (gồm 3 dòng đã rút), khớp số dòng hiện hành
  7.389 sau khi trừ dòng rút.
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

## Đợt đính chính ngày 28/10/2026 — tách hai bản ghi Lịch sử đóng gói nhiều ý (issue #391)

Đợt này thi hành luật hạt của YCCĐ: **mỗi dấu gạch ngang trong văn
bản nguồn là một ý = một YCCĐ riêng**; dấu "+" là ý con nằm trong
YCCĐ cha; không gộp nhiều ý thành một YCCĐ (mỗi YCCĐ phải tách rời
để gắn vào câu hỏi). Đối chiếu trực tiếp văn bản chính chủ
`ct-lichsu-official.pdf` xác nhận hai bản ghi Lịch sử dưới đây mỗi
bản ghi đang đóng gói 4 ý gạch ngang riêng vào đúng một YCCĐ — trái
luật hạt — nên tách ngay ở đợt này.

Kèm theo là xử lý hai mảnh chữ lạ ở đầu hai tài liệu đóng gói. Kiểm
chứng văn bản nguồn bằng ba lớp độc lập (lớp chữ giữ bố cục, toạ độ
từng từ trên trang, ảnh chụp trang 26/27 và 41/42) cho thấy: ý cuối
của bản ghi đứng trước mỗi ca (LS-0023, LS-0047) đều là câu trọn
đóng kín trong trang trước, còn hai mảnh chữ lạ là phần tiếp nối
của các ý bị cắt tại chân trang trước, thuộc về **hai khối nội dung
vắng mặt hoàn toàn khỏi dataset** (ghi dấu vết đầy đủ ở mục riêng
cuối đợt này). Ghép hai mảnh này vào bản ghi đứng trước sẽ tạo ra
câu không tồn tại trong văn bản nguồn — vi phạm quy tắc chép nguyên
văn của chính nhật ký này — nên đợt này **loại hai mảnh khỏi hai
bản ghi khi tách và ghi dấu vết chờ khôi phục**, không sửa
LS-0023/LS-0047, không khôi phục khối thiếu.

### LS-0024 — SỬA: tách YCCĐ đóng gói 4 ý thành 4 YCCĐ riêng, loại mảnh chữ thuộc khối đang thiếu

- Bản ghi: LS-0024 (file nguồn tr. 27, lớp 10, Chuyên đề 10.2: Bảo
  tồn và phát huy giá trị di sản văn hoá ở Việt Nam).
- Hiện trạng trước sửa: toàn bộ phần yêu cầu cần đạt nằm trong đúng
  một tài liệu YCCĐ duy nhất: một mảnh chữ lạ ở đầu ("văn hoá trong
  quá trình phát triển bền vững của đất nước.") rồi tới 4 ý hoàn
  chỉnh ngăn bằng " – ".
- Đính chính: đối chiếu tr. 27 — cột "Yêu cầu cần đạt" in 4 ý thành
  4 mục riêng, mỗi mục mở đầu bằng một ký tự "–". Tách thành 4 tài
  liệu YCCĐ riêng, nguyên văn theo thứ tự nguồn: (1) "Nêu được các
  giải pháp bảo tồn và phát huy giá trị di sản văn hoá: tuyên truyền
  giáo dục ý thức bảo tồn di sản, đầu tư cơ sở vật chất, tăng cường
  biện pháp bảo vệ di sản,..."; (2) "Giải thích được vai trò của hệ
  thống chính trị, doanh nghiệp, cộng đồng dân cư và của mỗi cá
  nhân trong công tác bảo tồn và phát huy giá trị di sản văn hoá.";
  (3) "Trình bày được trách nhiệm của Nhà nước, tổ chức xã hội, nhà
  trường, cộng đồng, công dân trong việc bảo tồn và phát huy giá
  trị di sản thông qua ví dụ cụ thể."; (4) "Có ý thức trách nhiệm
  và sẵn sàng đóng góp và vận động người khác cùng tham gia vào
  việc bảo tồn và phát huy giá trị các di sản văn hoá ở địa phương
  và đất nước.". Mảnh chữ lạ ở đầu bị loại (dấu vết ở mục riêng
  dưới đây). Trường `outcome_text` cập nhật khớp 4 ý đã tách.
- Khi nạp bằng importer: ý đầu khớp theo vị trí với dòng đóng gói
  hiện tại nên sửa chữ tại chỗ, giữ ID `01a17873-383e-7755-9570-fdfde0d720d7`;
  3 ý còn lại là dòng mới nhận ID uuidv7 do cơ sở dữ liệu cấp.
- Kết quả: bản ghi có 4 YCCĐ hiện hành riêng rẽ.

### LS-0048 — SỬA: tách YCCĐ đóng gói 4 ý thành 4 YCCĐ riêng, loại mảnh chữ thuộc khối đang thiếu

- Bản ghi: LS-0048 (file nguồn tr. 42, lớp 11, chủ đề Một số cuộc
  cải cách lớn trong lịch sử Việt Nam (trước năm 1858)).
- Hiện trạng trước sửa: cùng khuôn với LS-0024 — một tài liệu YCCĐ
  duy nhất gồm mảnh chữ lạ ở đầu ("trong sự nghiệp cải cách và
  kháng chiến bảo vệ Tổ quốc.") rồi tới 4 ý hoàn chỉnh ngăn bằng
  " – ".
- Đính chính: đối chiếu tr. 42 — 4 ý là 4 mục gạch ngang riêng.
  Tách thành 4 tài liệu YCCĐ riêng, nguyên văn theo thứ tự nguồn:
  (1) "Phân tích được bối cảnh lịch sử, nội dung và ý nghĩa của
  cuộc cải cách thời Lê Thánh Tông."; (2) "Phân tích được bối cảnh
  lịch sử, nội dung và ý nghĩa của cuộc cải cách thời Minh Mạng.";
  (3) "Đánh giá kết quả và nêu được bài học kinh nghiệm của cuộc
  cải cách Minh Mạng."; (4) "Có ý thức trân trọng giá trị của các
  cuộc cải cách trong lịch sử dân tộc.". Mảnh chữ lạ ở đầu bị loại
  (dấu vết ở mục riêng dưới đây). Trường `outcome_text` cập nhật
  khớp 4 ý đã tách.
- Khi nạp bằng importer: ý đầu sửa chữ tại chỗ, giữ ID dòng đóng
  gói `01a17873-38ae-74f9-a672-c4ac7ff60159`; 3 ý còn lại là dòng
  mới nhận ID uuidv7 do cơ sở dữ liệu cấp.
- Kết quả: bản ghi có 4 YCCĐ hiện hành riêng rẽ.

### Dấu vết hai mảnh chữ bị loại và hai khối dữ kiện đang thiếu (chờ khôi phục riêng)

Hai mảnh dưới đây đã bị loại khỏi dataset ở đợt này. Chúng không
thuộc về bản ghi đứng trước và không thuộc về các ý được tách;
chúng là phần đuôi của các ý nằm trong hai khối nội dung của văn
bản nguồn đang vắng mặt hoàn toàn khỏi dataset Lịch sử. Việc khôi
phục cả hai khối là một đợt riêng (dựng bản ghi mới cho các YCCĐ
dưới đây theo đúng thứ tự nguồn, đặt giữa hai bản ghi kề như ghi ở
từng khối); tới khi đợt đó thi hành, ghi ở đây để không ai mất dấu
và không ai ghép nhầm hai mảnh này vào LS-0023/LS-0047.

- **Mảnh ở LS-0024**: "văn hoá trong quá trình phát triển bền vững
  của đất nước." — phần tiếp nối của ý "Phân tích được cơ sở khoa
  học của công tác bảo tồn di sản văn hoá trong quá trình phát
  triển bền vững của đất nước." (ý bị cắt tại chân tr. 26, phần đầu
  ý nằm ở tr. 26 nhưng không thuộc về bất kỳ bản ghi nào hiện có).
  Khối thiếu thứ nhất — "Bảo tồn và phát huy giá trị di sản văn
  hoá", nằm giữa LS-0023 và LS-0024 trong văn bản nguồn, gồm 3
  YCCĐ: (1) "Giải thích được khái niệm bảo tồn di sản văn hoá.";
  (2) "Phân tích được mối quan hệ giữa bảo tồn và phát huy giá trị
  di sản văn hoá: bảo tồn phải đặt trong bối cảnh phát triển bền
  vững để bảo tồn không trở thành gánh nặng và rào cản của phát
  triển."; (3) ý chứa mảnh ở trên.
- **Mảnh ở LS-0048**: "trong sự nghiệp cải cách và kháng chiến bảo
  vệ Tổ quốc." — phần tiếp nối của ý "Nêu được nhận xét về nguyên
  nhân thất bại của triều Hồ trong sự nghiệp cải cách và kháng
  chiến bảo vệ Tổ quốc." (ý bị cắt tại chân tr. 41). Khối thiếu thứ
  hai — nội dung về cuộc cải cách của triều Hồ, nằm giữa LS-0047
  và LS-0048 trong văn bản nguồn, gồm 2 YCCĐ: (1) "Tóm tắt được bối
  cảnh lịch sử, nội dung và đánh giá ý nghĩa cuộc cải cách của nhà
  Hồ."; (2) ý chứa mảnh ở trên.

Báo cáo thay đổi của importer khi nạp vào cơ sở dữ liệu chuẩn
(dựng từ trống, restore nguyên văn dump `2026-10-28.2`): duy nhất
dataset lichsu thay đổi — created=0, updated=2, skipped=96;
changeCounts: textChanged=2, added=6, removed=0, moved=0,
revived=0, shiftSuspected=0; 20 dataset còn lại updated=0, mọi
changeCounts bằng 0. Số gắn kết câu hỏi và ánh xạ sách vào các
dòng bị ảnh hưởng bằng 0. Đối chiếu phần khác biệt của dump mới so
với dump `2026-10-28.2`: ngoài 3 dòng header (version, thời điểm
sinh, dòng số liệu), chỉ có 2 dòng YCCĐ đóng gói đổi nội dung thành
ý đầu của từng ca (giữ nguyên ID), 6 dòng YCCĐ mới, và dấu vết tất
yếu của chính lượt patch trên 2 bản ghi bị sửa (trường
`content_hash` của dòng sổ đăng ký và `updated_at` của dòng sổ và
của node chứa bản ghi) — không dòng nào khác thay đổi.

## Số liệu sau đợt đính chính ngày 28/10/2026 (issue #391)

| Dataset | File | Bản ghi | Dòng YCCĐ hiện hành trong DB |
|---|---|---:|---:|
| Lịch sử | program-lichsu.json | 98 | 347 |
| **Tổng** | — | **2.115** | **7.395** |

Phiên bản dump đông cứng sau đợt: `2026-10-28.3` (header dump ghi
subjects=19, curricula=146, curriculum_nodes=3637,
learning_outcomes=7398, curriculum_program_records=2115; tổng số
dòng YCCĐ trong dump là 7.398, gồm 3 dòng đã rút của các đợt trước
giữ nguyên).

## Đợt khôi phục ngày 29/10/2026 — đợt 1: khôi phục ý thiếu và tách đóng gói các môn mức A (issue #480)

Đợt này là đợt 1 của đợt đối chiếu nguồn toàn bộ 21 dataset: khôi
phục các ý gạch ngang còn thiếu và tách các YCCĐ đóng gói ở 10
dataset có văn bản nguồn chính chủ mức A (Lịch sử, Lịch sử và Địa
lí THCS, Công nghệ, Địa lí, Sinh học, Toán, Khoa học tự nhiên,
Lịch sử và Địa lí tiểu học, Khoa học, Tin học). Luật hạt giữ
nguyên như đợt #391: mỗi dấu gạch ngang trong văn bản nguồn là một
YCCĐ riêng; dấu "+" là ý con nằm trong YCCĐ cha; không gộp, không
tách một ý thành nhiều YCCĐ. Mọi ý khôi phục chép nguyên văn từ văn
bản nguồn chính chủ (kèm số trang ở từng mục), không diễn giải lại.

Bốn yêu cầu kỹ thuật áp dụng cho đợt này:

1. Phần chuyên đề THPT của môn Công nghệ thuộc phạm vi dataset:
   khôi phục toàn bộ 18 chuyên đề (74 ý) như các môn khác.
2. 14 hàng "Thực hành trong phòng máy tính với phần mềm toán học"
   của Toán: mỗi hàng dựng một bản ghi riêng, không gắn vào bản
   ghi kề.
3. Khối mất hẳn (không có bản ghi nào): dựng bản ghi mới; mã bản
   ghi nối tiếp sau mã lớn nhất hiện có của chính môn đó; vị trí
   của bản ghi trong thứ tự chương trình đặt đúng vị trí của khối
   trong văn bản nguồn. Nguyên tắc này áp dụng thống nhất mọi môn.
4. Thứ tự các đợt là 1 → 2 → 3; đợt này chỉ làm đợt 1. Các ca sửa
   nguyên văn/nhãn thuộc đợt 2 và các môn mức B thuộc đợt 3 không
   nằm trong đợt này.

Cơ chế định danh khi nạp bằng importer giữ nguyên các đợt trước:
ý trùng nguyên văn một dòng đã rút thì hồi sinh giữ ID; ý mới nhận
ID uuidv7 do cơ sở dữ liệu cấp; ý đầu của một YCCĐ đóng gói được
tách giữ ID của dòng đóng gói.

Số liệu xuất phát (đếm lại tại main trước khi sửa): tổng 2.115 bản
ghi, 7.395 dòng YCCĐ hiện hành. Số liệu đích và kết quả từng môn ở
các mục dưới đây; tổng sau đợt ở bảng cuối mục.

### Lịch sử — 98 bản ghi / 347 ý → 110 bản ghi / 403 ý (+12 bản ghi, +56 ý)

- Hiện trạng: thiếu 56 ý ở Lớp 10, 11, 12; trong đó 12 khối nội
  dung vắng mặt hoàn toàn khỏi dataset (không có bản ghi nào chứa
  ý của khối), phần còn lại là các ý đầu khối bị rơi khi trích xuất
  ở các bản ghi hiện có.
- Đính chính: dựng 12 bản ghi mới LS-0099 đến LS-0110 (mã nối tiếp
  sau mã lớn nhất LS-0098 theo yêu cầu 3), mỗi bản ghi đặt đúng vị
  trí khối trong thứ tự nguồn:
  - LS-0099 (sau LS-0003, Lớp 10, tr. 13): khối đầu chuyên đề về sử
    học với công tác bảo tồn di sản, 2 ý.
  - LS-0100 (sau LS-0015, Lớp 10, tr. 21): chủ đề con Văn minh Đại
    Việt, 5 ý.
  - LS-0101 (sau LS-0023, tr. 26–27): khối "Bảo tồn và phát huy giá
    trị di sản văn hoá", 3 ý — chính là khối mang dấu vết đã ghi ở
    đợt #391; ý thứ ba của khối chứa trọn mảnh chữ từng bị loại
    khỏi LS-0024 ("…văn hoá trong quá trình phát triển bền vững
    của đất nước."), nay trở về đúng vị trí nguồn.
  - LS-0102 (sau LS-0024, tr. 27): khối di sản văn hoá phi vật thể,
    2 ý.
  - LS-0103 (sau LS-0047, Lớp 11, tr. 41–42): hàng cải cách nhà Hồ,
    2 ý — khối mang dấu vết đã ghi ở đợt #391; ý thứ hai chứa trọn
    mảnh chữ từng bị loại khỏi LS-0048.
  - LS-0104 (trước LS-0031, Lớp 11, tr. 32): 4 ý. LS-0105 (trước
    LS-0046, Lớp 11, tr. 40): 6 ý. LS-0106 (sau LS-0049, Lớp 11,
    tr. 43): 4 ý. LS-0107 (sau LS-0053, Lớp 11, tr. 45): 2 ý.
    LS-0108 (sau LS-0067, Lớp 12, tr. 53): 4 ý. LS-0109 (sau
    LS-0081, Lớp 12, tr. 61): 1 ý. LS-0110 (sau LS-0084, Lớp 12,
    tr. 64): 1 ý.
  - Bổ sung ý đầu khối vào 10 bản ghi hiện có: LS-0030 (+1), LS-0034
    (+2), LS-0036 (+3), LS-0049 (+3, khối khái quát Biển Đông — nội
    dung của LS-0049 bắt đầu từ phần đuôi của tiểu mục này nên các
    ý thuộc về đầu bản ghi), LS-0064 (+2), LS-0065 (+1), LS-0074
    (+3), LS-0075 (+2), LS-0077 (+1), LS-0083 (+2).
- Importer: created=12, updated=10, retiredOutcomes=0;
  changeCounts: added=56, moved=46, còn lại 0.
- Kết quả: 110 bản ghi, 403 dòng YCCĐ hiện hành.

### Lịch sử và Địa lí THCS — 63 bản ghi / 328 ý → 64 bản ghi / 398 ý (+1 bản ghi, +70 ý)

- Hiện trạng: thiếu 66 ý đầu khối rải ở 19 bản ghi (ý đầu của các
  khối bị rơi khi trích xuất); LSDL-0026 đóng gói hai ý gạch ngang
  thành một YCCĐ; toàn bộ khối cuối chương trình Lớp 9 "Bảo vệ chủ
  quyền, các quyền và lợi ích hợp pháp của Việt Nam ở Biển Đông"
  vắng mặt.
- Đính chính: bổ sung ý đầu khối vào 19 bản ghi (LSDL-0001 +2,
  0006 +2, 0009 +4, 0011 +8, 0013 +1, 0015 +2, 0021 +6, 0030 +2,
  0033 +2, 0036 +7, 0037 +5, 0039 +5, 0044 +2, 0048 +4, 0050 +2,
  0052 +1, 0055 +2, 0056 +4, 0057 +5). Tách LSDL-0026: YCCĐ vị trí
  4 đang chứa hai ý nối nhau — "Giới thiệu được sự phát triển văn
  hoá, giáo dục và một số danh nhân văn hoá tiêu biểu thời Lê sơ."
  và "Nêu được những diễn biến cơ bản về chính trị, kinh tế văn hoá
  ở vùng đất phía nam từ đầu thế kỉ X đến đầu thế kỉ XVI." — tách
  thành hai YCCĐ riêng theo đúng thứ tự nguồn; ý đầu giữ ID dòng
  đóng gói. Dựng bản ghi mới LSDL-0064 đặt cuối chương trình (sau
  LSDL-0063) cho khối Biển Đông Lớp 9 (văn bản nguồn tr. 51–52),
  gồm 3 ý, `kind` là requirement theo khuôn các bản ghi cùng khối.
- Importer: created=1, updated=20, retiredOutcomes=0;
  changeCounts: added=70, textChanged=1 (ý đầu của ca tách sửa chữ
  tại chỗ), moved=77, còn lại 0.
- Kết quả: 64 bản ghi, 398 dòng YCCĐ hiện hành.

### Công nghệ — 103 bản ghi / 456 ý → 121 bản ghi / 530 ý (+18 bản ghi, +74 ý)

- Hiện trạng: toàn bộ phần chuyên đề THPT (6 hướng: Công nghệ lớp
  10, Cơ khí lớp 11, Điện lớp 12, Trồng trọt lớp 10, Chăn nuôi lớp
  11, Lâm nghiệp – Thuỷ sản lớp 12; mỗi hướng 3 chuyên đề) vắng mặt
  khỏi dataset.
- Đính chính: theo yêu cầu 1, dựng 18 bản ghi mới CN-0104 đến
  CN-0121, mỗi chuyên đề một bản ghi, đặt sau bản ghi cuối của
  hướng tương ứng (sau CN-0063, CN-0070, CN-0079, CN-0087, CN-0093,
  CN-0103). Bảng chuyên đề trong văn bản nguồn chỉ có hai cột (tên
  chuyên đề, yêu cầu cần đạt) nên trường `section` của bản ghi
  mang chính tên chuyên đề nguyên văn; `topic` để trống, `kind` là
  content như các bản ghi nội dung khác. 74 ý chép nguyên văn
  (kể cả lỗi chính tả có sẵn trong nguồn ở chuyên đề STEM lớp 10:
  "Tóm tắt một được một số vấn đề cơ bản về STEM, nghề nghiệp
  STEM." — giữ nguyên văn theo quy tắc chép nguyên văn).
- Importer: created=18, updated=0, retiredOutcomes=0;
  changeCounts: added=74, còn lại 0.
- Kết quả: 121 bản ghi, 530 dòng YCCĐ hiện hành.

### Địa lí — 62 bản ghi / 266 ý → 63 bản ghi / 308 ý (+1 bản ghi, +42 ý)

- Hiện trạng: thiếu 36 ý đầu khối ở 10 bản ghi và 2 ý giữa khối ở
  DL-0051 (của khối Trung du và miền núi Bắc Bộ); khối thực hành
  cuối chương trình Lớp 12 vắng mặt (văn bản của khối đang bị giữ
  nhầm trong trường nội dung của DL-0059).
- Đính chính: bổ sung ý đầu khối vào DL-0002 (+1 — DL-0001 là bản
  ghi tiêu đề 0 ý, các ý của khối nằm ở DL-0002), DL-0007 (+4),
  DL-0011 (+1), DL-0014 (+12: 8 ý Nông nghiệp và 4 ý Công nghiệp
  đầu khối; ý duy nhất của DL-0013 thuộc khối cơ cấu đứng trước,
  giữ nguyên), DL-0017 (+4), DL-0027 (+2), DL-0040 (+2), DL-0042
  (+1), DL-0047 (+5), DL-0059 (+4). Chèn 2 ý Trung du và miền núi
  Bắc Bộ vào DL-0051 tại vị trí 2 (ngay sau ý khái quát của bản
  ghi, đúng thứ tự nguồn). Dựng bản ghi mới DL-0064 đặt sau DL-0059
  cho khối "Thực hành tìm hiểu Địa lí địa phương" (tr. 38), 4 ý.
  Mã DL-0064 là mã nối tiếp sau mã lớn nhất hiện có (DL-0063) theo
  yêu cầu 3; dãy mã của môn đang khuyết DL-0061 — đợt này không
  lấp mã khuyết, chỉ ghi nhận tại đây.
- Importer: created=1, updated=11, retiredOutcomes=0;
  changeCounts: added=42, moved=55, còn lại 0.
- Kết quả: 63 bản ghi, 308 dòng YCCĐ hiện hành.

### Sinh học — 133 bản ghi / 407 ý → 133 bản ghi / 433 ý (+26 ý, +2 ý con)

- Hiện trạng: thiếu 26 ý đầu khối ở 6 bản ghi; hai YCCĐ cha thiếu
  ý con trong danh sách "+" của chúng (SH-0126 thiếu ý con đầu
  danh sách, SH-0127 thiếu ý con cuối danh sách và một câu thực
  hành in nối tiếp không mang dấu "+" trong văn bản nguồn).
- Đính chính: bổ sung ý đầu khối vào SH-0008 (+12), SH-0108 (+1),
  SH-0116 (+4), SH-0124 (+2), SH-0125 (+1), SH-0129 (+6). SH-0126:
  chèn ý con "Trình bày được khái niệm chuỗi thức ăn, các loại
  chuỗi thức ăn, lưới thức ăn, bậc dinh dưỡng. Vẽ được sơ đồ chuỗi
  và lưới thức ăn trong quần xã." vào đầu danh sách ý con của YCCĐ
  vị trí 2. SH-0127: thêm ý con "Nêu được một số hiện tượng ảnh
  hưởng đến hệ sinh thái như: sự ấm lên toàn cầu; sự phì dưỡng; sa
  mạc hoá. Giải thích được vì sao các hiện tượng đó vừa tác động
  đến hệ sinh thái, vừa là nguyên nhân của sự mất cân bằng của hệ
  sinh thái." vào cuối danh sách ý con của YCCĐ vị trí 2, và thêm
  đoạn tiếp nối "Thực hành: Thiết kế được một bể nuôi cá cảnh vận
  dụng hiểu biết hệ sinh thái hoặc thiết kế được hệ sinh thái thuỷ
  sinh, hệ sinh thái trên cạn." thành một đoạn văn bản riêng trong
  cùng YCCĐ (văn bản nguồn in câu này nối tiếp không mang dấu "+"
  nên không đặt vào danh sách ý con). Khai bổ sung trang nguồn:
  SH-0116 tr. 46–47, SH-0129 tr. 53–54.
- Importer: created=0, updated=8, retiredOutcomes=0;
  changeCounts: added=26, textChanged=2 (hai YCCĐ cha nhận thêm ý
  con sửa tại chỗ), moved=38, còn lại 0.
- Kết quả: 133 bản ghi, 433 dòng YCCĐ hiện hành.

### Toán — 300 bản ghi / 852 ý → 314 bản ghi / 900 ý (+14 bản ghi, +48 ý, 4 ca bổ đuôi)

- Hiện trạng: 17 hàng "Thực hành trong phòng máy tính với phần mềm
  toán học" (tr. 52, 54, 60, 62, 68, 69, 76, 77, 81, 84, 86, 96,
  101, 102, 107, 109, 111 của văn bản nguồn) — 3 hàng đã có bản ghi
  nhưng bản ghi mang ý trong trường nội dung và có 0 YCCĐ
  (TOAN-0171 tr. 69–70, TOAN-0197 tr. 77–78, TOAN-0289 tr. 111),
  14 hàng chưa có bản ghi; 5 ý rơi tại ranh trang thuộc ba bản ghi
  hiện có; 4 ý bị cắt mất phần đuôi tại ranh trang.
- Đính chính: theo yêu cầu 2, dựng 14 bản ghi mới TOAN-0301 đến
  TOAN-0314 cho 14 hàng chưa có bản ghi, mỗi bản ghi đặt ngay sau
  bản ghi đứng trước hàng trong thứ tự nguồn (lần lượt sau
  TOAN-0116, 0122, 0142, 0148, 0166, 0192, 0209, 0217, 0224,
  0250, 0261, 0264, 0280, 0284), mang nguyên văn tiêu đề hàng làm
  nội dung và chép nguyên văn 36 ý của 14 hàng. Ba bản ghi đã có
  được bổ sung YCCĐ nguyên văn từ văn bản nguồn (đối chiếu lại
  trang nguồn, không chép từ trường nội dung): TOAN-0171 nhận 3 ý,
  TOAN-0197 nhận 2 ý, TOAN-0289 nhận 2 ý (bản ghi TOAN-0288 mang
  tiêu đề hàng giữ nguyên). Bổ sung 5 ý ranh trang: TOAN-0273 (+3,
  khối vẽ kĩ thuật), TOAN-0296 (+1), TOAN-0299 (+1). Bổ đuôi 4 ý bị
  cắt, thay chữ tại chỗ giữ nguyên vị trí và ID dòng: TOAN-0085 ý 3
  thành "Nhận biết được tỉ lệ bản đồ. Vận dụng được tỉ lệ bản đồ
  để giải quyết một số tình huống thực tiễn."; TOAN-0208 ý 3 thành
  "Vận dụng được bất phương trình bậc hai một ẩn vào giải quyết
  bài toán thực tiễn (ví dụ: xác định chiều cao tối đa để xe có
  thể qua hầm có hình dạng Parabola,...)."; TOAN-0233 ý 2 thành
  "Vận dụng cách giải hệ phương trình bậc nhất ba ẩn để giải quyết
  một số vấn đề thực tiễn cuộc sống (ví dụ: bài toán lập kế hoạch
  sản xuất, mô hình cân bằng thị trường, phân bố vốn đầu tư,...).";
  TOAN-0299 ý 6 thành "Nhận biết được kết quả của việc trả các
  khoản tiền nợ đúng thời hạn, bao gồm hồ sơ tín dụng và giá trị
  tín dụng.". Khai bổ sung trang nguồn: TOAN-0085 tr. 42–43,
  TOAN-0208 tr. 80–81, TOAN-0233 tr. 88–89, TOAN-0273 tr. 104–105,
  TOAN-0296 tr. 112–113, TOAN-0299 tr. 113–114.
- Importer: created=14, updated=9, retiredOutcomes=3 (là 3 dòng
  TOAN-0006 đã rút từ đợt 27/10/2026 được importer kiểm lại, không
  phải dòng rút mới của đợt này); changeCounts: added=48,
  textChanged=4 (bốn ca bổ đuôi), removed=0, moved=0, revived=0,
  shiftSuspected=0.
- Kết quả: 314 bản ghi, 900 dòng YCCĐ hiện hành.

### Khoa học tự nhiên — 130 bản ghi / 589 ý → 131 bản ghi / 596 ý (+1 bản ghi, +7 ý, +8 ý con)

- Hiện trạng: khối mở đầu đầu tiên của Lớp 6 (phần Giới thiệu về
  Khoa học tự nhiên, tr. 22) vắng mặt — bản ghi đầu hiện có
  (KHTN-0001) bắt đầu từ nội dung tiếp theo; bản ghi KHTN-0039
  thiếu toàn bộ khối Trao đổi nước (3 ý, ý thứ ba mang 8 ý con)
  nằm giữa ý vị trí 3 và ý vị trí 4 của bản ghi.
- Đính chính: dựng bản ghi mới KHTN-0131 đặt trước KHTN-0001, 4 ý
  nguyên văn tr. 22. Chèn vào KHTN-0039 tại vị trí 4: ý "Nêu được
  vai trò của nước và các chất dinh dưỡng đối với cơ thể sinh
  vật.", ý "Dựa vào sơ đồ (hoặc mô hình) nêu được thành phần hoá
  học và cấu trúc, tính chất của nước.", và YCCĐ cha "Mô tả được
  quá trình trao đổi nước và các chất dinh dưỡng, lấy được ví dụ ở
  thực vật và động vật, cụ thể:" mang đủ 8 ý con nguyên văn.
- Importer: created=1, updated=1, retiredOutcomes=0;
  changeCounts: added=7, moved=2, còn lại 0.
- Kết quả: 131 bản ghi, 596 dòng YCCĐ hiện hành.

### Lịch sử và Địa lí tiểu học — 47 bản ghi / 162 ý → 49 bản ghi / 171 ý (+2 bản ghi, +9 ý)

- Hiện trạng: bản ghi LSDL-0047 (văn minh Hy Lạp) thiếu 2 ý đuôi
  khối tại tr. 24; toàn bộ chủ đề cuối chương trình Lớp 5 "Chung
  Tay Xây Dựng Thế Giới" (hai chủ đề con, tr. 24) vắng mặt.
- Đính chính: bổ sung 2 ý đuôi vào LSDL-0047 và khai bổ sung trang
  nguồn tr. 23–24. Dựng hai bản ghi mới đặt sau LSDL-0047:
  LSDL-0048 (chủ đề con "Xây dựng thế giới xanh - sạch - đẹp",
  4 ý) và LSDL-0049 (chủ đề con "Xây dựng thế giới hoà bình", 3 ý),
  mã nối tiếp theo yêu cầu 3.
- Importer: created=2, updated=1, retiredOutcomes=0;
  changeCounts: added=9, còn lại 0.
- Kết quả: 49 bản ghi, 171 dòng YCCĐ hiện hành.

### Khoa học — 32 bản ghi / 107 ý → 32 bản ghi / 115 ý (+9 ý, ròng +8 dòng)

- Hiện trạng: thiếu ý đầu khối ở KH-0001 (1 ý), KH-0003 (4 ý),
  KH-0005 (2 ý); bản ghi KH-0002 thiếu ý "thành phần chính của
  không khí" đứng đầu khối và YCCĐ "Quan sát và (hoặc) làm thí
  nghiệm để:" đang mất phần cha — chỉ còn một tài liệu chứa 3 ý
  con cuối của danh sách, thiếu hai ý con đầu ("Nhận biết được sự
  có mặt của không khí." và "Xác định được một số tính chất của
  không khí.").
- Đính chính: bổ sung ý đầu khối vào KH-0001, KH-0003, KH-0005
  nguyên văn (đối chiếu văn bản nguồn tr. 8–9). KH-0002: thêm ý
  "Kể được tên thành phần chính của không khí: nitơ (nitrogen),
  oxi (oxygen), khí cacbonic (carbon dioxide)." vào đầu bản ghi và
  dựng lại YCCĐ cha "Quan sát và (hoặc) làm thí nghiệm để:" chứa
  đủ 5 ý con theo thứ tự nguồn (hai ý con khôi phục đứng trước, ba
  ý con đang có giữ nguyên văn theo sau), thay cho tài liệu chỉ
  chứa 3 ý con. Khi nạp, importer ghép cặp theo vị trí: dòng tài
  liệu mồ côi được sửa chữ tại chỗ thành ý thành phần (giữ ID),
  YCCĐ cha là dòng mới; tổng dòng hiện hành của môn tăng ròng 8.
- Importer: created=0, updated=4, retiredOutcomes=0;
  changeCounts: added=8, textChanged=1, moved=18, removed=0,
  revived=0, shiftSuspected=0.
- Kết quả: 32 bản ghi, 115 dòng YCCĐ hiện hành.

### Tin học — 115 bản ghi / 395 ý → 115 bản ghi / 396 ý (tách 1 ca đóng gói)

- Hiện trạng: YCCĐ vị trí 2 của TH-0111 đóng gói hai ý gạch ngang:
  ý về hàm tổ hợp tính xác suất và ý "Mô tả được dữ liệu thống kê
  của một bài toán thực tế với sử dụng phần mềm bảng tính:" (ý này
  mang 5 ý con đã nằm sẵn trong tài liệu đóng gói); hai ý đang bị
  nối liền nhau trong cùng một đoạn, kèm vết trích xuất ở chỗ nối.
- Đính chính: tách thành hai YCCĐ riêng theo thứ tự nguồn — ý đầu
  giữ ID dòng đóng gói; ý thứ hai mang nguyên văn đoạn cha và cả 5
  ý con giữ nguyên văn. Trường `outcome_text` viết lại khớp hai ý
  đã tách (vết trích xuất ở chỗ nối biến mất theo đúng nguyên văn).
- Importer: created=0, updated=1, retiredOutcomes=0;
  changeCounts: added=1, textChanged=1, moved=1, còn lại 0.
- Kết quả: 115 bản ghi, 396 dòng YCCĐ hiện hành.

### Số liệu sau đợt khôi phục ngày 29/10/2026 (issue #480)

| Dataset | Bản ghi trước → sau | Dòng YCCĐ hiện hành trước → sau |
|---|---|---|
| Lịch sử | 98 → 110 | 347 → 403 |
| Lịch sử và Địa lí THCS | 63 → 64 | 328 → 398 |
| Công nghệ | 103 → 121 | 456 → 530 |
| Địa lí | 62 → 63 | 266 → 308 |
| Sinh học | 133 → 133 | 407 → 433 |
| Toán | 300 → 314 | 852 → 900 |
| Khoa học tự nhiên | 130 → 131 | 589 → 596 |
| Lịch sử và Địa lí tiểu học | 47 → 49 | 162 → 171 |
| Khoa học | 32 → 32 | 107 → 115 |
| Tin học | 115 → 115 | 395 → 396 |
| 11 dataset còn lại | không đổi | không đổi |
| **Tổng** | **2.115 → 2.164** | **7.395 → 7.736** |

Phiên bản dump đông cứng sau đợt: `2026-10-29.1` (header dump ghi
subjects=19, curricula=146, curriculum_nodes=3708,
learning_outcomes=7739, curriculum_program_records=2164; tổng số
dòng YCCĐ trong dump là 7.739, gồm 3 dòng đã rút của các đợt trước
giữ nguyên; số dòng hiện hành 7.736). Cổng toàn vẹn nguyên văn đạt
trên toàn bộ 21 file sau sửa; bảng số bản ghi của spec kiểm kê
dataset đã cập nhật theo số liệu sau đợt trong cùng thay đổi này.
