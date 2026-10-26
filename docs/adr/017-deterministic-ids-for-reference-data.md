# ADR-017: Định danh xác định UUIDv5 cho dữ liệu chuẩn nạp từ dataset

## Trạng thái
Accepted (25/10/2026). Nguồn thiết kế: hồ sơ nghiên cứu nội bộ
`gdpt-reference-data-loading-research-2026-10-25.md` (mục 5, phương án
D) cho issue #161 (GDPT-SEED). Ngoại lệ có chủ đích của ADR-013. (Hồ
sơ nghiên cứu gọi đây là "ADR-014" nhưng số 014 đã thuộc về
http-edge-hardening; ADR này lấy số 017.)

## Bối cảnh
Dữ liệu chuẩn của hệ thống — hiện tại là chương trình GDPT 2018
(2.126 bản ghi, 21 dataset vendor trong repo, đã kiểm chứng nguyên
văn với TT 32/2018) — được nạp vào cây chương trình bằng
`ProgramImportService` và nay cũng là một phần của seed. Trước chuẩn
này, mọi dòng nạp đều nhận UUIDv7 ngẫu nhiên tại thời điểm insert:
cùng một dataset cho ra các tập id khác nhau ở các môi trường khác
nhau, và nhánh nạp lại "xoá node tạo lại" phá vỡ mọi tham chiếu đã
trỏ vào node/YCCĐ cũ (ánh xạ sách, ô ma trận, gắn câu hỏi, slot quiz)
khi dataset được đính chính.

## Quyết định

### Id xác định theo khoá tự nhiên (UUIDv5)
Mọi dòng DO DATASET sinh ra ở tầng chương trình mang id UUIDv5 tính
từ khoá tự nhiên trong một namespace dự án đóng băng
(`PROGRAM_ID_NAMESPACE` trong `program-datasets.ts` — hằng số sinh
một lần, không bao giờ thay đổi):

- môn: `subject|<slug>`
- chương trình: `curriculum|<slug>|<khối>`
- node tổ tiên: `node|<slug>|<khối>|<JSON đường [kind,title] từ gốc>`
- node nội dung: `record|<dataset>|<mã bản ghi>`
- YCCĐ: `outcome|<dataset>|<mã bản ghi>|<sha256(nội dung dòng)>`
  (neo nội dung, không dùng số thứ tự; dòng trùng nội dung trong cùng
  bản ghi phân biệt bằng hậu tố `#2`, `#3`…)

### Ngoại lệ so với ADR-013
Cột `id` của các bảng liên quan VẪN giữ `DEFAULT uuidv7()` phía
PostgreSQL như ADR-013 quy định — baseline không đổi về default
(kiểm chứng: số cột `DEFAULT uuidv7()` trong baseline không đổi).
Chỉ các dòng do dataset sinh ra mới mang id v5 do tầng nạp truyền
tường minh khi insert; mọi dòng do người dùng tạo tay (kể cả trong
cùng các bảng đó) vẫn nhận uuidv7 như trước. Kiểm chứng uuidv7 của
hệ thống (raw-insert không truyền id) không bị ảnh hưởng.

### Hội tụ
Khi nạp gặp một dòng đã tồn tại theo khoá tự nhiên nhưng mang id
khác (dữ liệu tạo tay, hoặc nạp từ trước chuẩn này), tầng nạp GIỮ id
hiện hữu và sổ đăng ký ghi id đó — không ép đổi id của dữ liệu đang
sống, không tạo bản sao.

### Luật không-xoá khi nạp lại
Nhánh cập nhật của tầng nạp là một phép diff theo khoá tự nhiên và
KHÔNG BAO GIỜ xoá node/YCCĐ:
- node giữ id kể cả khi bản ghi đổi khối lớp (cập nhật
  `curriculum_id` tại chỗ);
- YCCĐ không còn trong dataset (Bộ rút, hoặc sửa chữ — sửa chữ cho
  hash mới nên là YCCĐ mới) được giữ nguyên trong DB và đếm vào
  `orphanedOutcomes` trong kết quả nạp; bản ghi biến mất khỏi
  dataset đếm vào `orphanedNodes`;
- YCCĐ `source_kind='derived'` (tổ chuyên môn suy ra) không thuộc
  dataset và không bao giờ bị phép diff đụng tới.

### FK restrict bảo vệ dữ liệu chuẩn
Bốn FK trỏ vào cây chương trình từ các bề mặt khác đổi từ cascade
sang restrict: `book_mappings.curriculum_node_id`,
`book_mappings.learning_outcome_id`,
`exam_matrix_cells.learning_outcome_id`,
`question_learning_outcomes.learning_outcome_id`. Bề mặt quản trị
xoá (môn/chương trình/node/YCCĐ) đếm tham chiếu trước và từ chối
bằng lỗi nghiệp vụ `curriculum.delete_referenced` thay vì lỗi FK
thô. Các cascade NỘI BỘ cây (môn → chương trình → node → YCCĐ) và
các FK set-null giữ nguyên.

## Hệ quả
- Seed trên hai cơ sở dữ liệu độc lập cho tập id của dữ liệu chuẩn
  khớp nhau 100%; tham chiếu dựng ở môi trường này (ánh xạ sách, ma
  trận, slot) có nghĩa ở mọi môi trường.
- Đính chính dataset không bao giờ làm mất tham chiếu âm thầm; phần
  dữ liệu bị Bộ rút hiện ra dưới dạng đếm orphaned tường minh.
- Cái giá: tầng nạp phức tạp hơn (diff thay vì xoá-tạo-lại) và
  namespace là một hằng số phải bảo toàn vĩnh viễn — đổi namespace
  tương đương đổi chuẩn định danh.

## Đính chính ngày 26/10/2026 — YCCĐ: id uuidv7 mờ + phân phối bằng DUMP ĐÔNG CỨNG (issue #161)

Lệnh của Lão gia 19:41 ngày 26/10/2026 ("Research lại công văn đi
rồi dựng lại cho đúng"), research ở hồ sơ
`yccd-identity-reanchor-research-2026-10-26.md` (mục Q1: văn bản
chương trình TT 32/2018 tổ chức YCCĐ thành các dòng gạch đầu dòng
theo thứ tự cố định trong ô của một đơn vị nội dung — Bộ không ban
hành mã YCCĐ; mục Q2: giaokhoa mô hình YCCĐ là dòng tại vị trí với
sửa tại chỗ và id mờ), và CHỐT CUỐI của Lão gia 20:09 cùng ngày (sổ
quyết định mục E — bản này THAY bản chốt 19:57 dùng UUIDv5 theo vị
trí, vốn không còn hiệu lực). Các điểm đổi:

- **Định danh YCCĐ program: BỎ HẲN UUIDv5** (cả khoá hash nội dung
  lẫn khoá vị trí). Id là **uuidv7 mờ, DB cấp MỘT LẦN khi tạo dòng,
  không tính từ bất kỳ thuộc tính nào, không bao giờ đổi**. Sửa chữ
  = sửa text tại chỗ, id và mọi liên kết giữ nguyên; thêm dòng =
  chèn dòng mới (id mới) rồi set lại `position`.
- **Phân phối bằng DUMP ĐÔNG CỨNG thay cơ chế hội tụ v5**: nạp
  dataset một lần vào DB chuẩn → dump các bảng chương trình thành
  artifact SQL có version trong repo
  (`program-data-dump/program-dump.sql`, version ở
  `PROGRAM_DUMP_VERSION`) → mọi môi trường RESTORE dump khi seed,
  KHÔNG chạy importer. ID trong dump là hằng số literal nên khớp
  100% giữa các môi trường bất kể lịch sử nạp.
- **Importer giữ vai công cụ sản xuất dump ở trung tâm**: patch DB
  chuẩn tại chỗ theo ngữ nghĩa trên — ghép dòng theo (bản ghi + vị
  trí + nguyên văn) trên chính DB đó (không theo id tính), thuật
  toán ghép cặp 6 bước (khớp vị trí+nguyên văn → khớp nguyên văn/xô
  lệch chỉ sửa position → sửa chữ tại chỗ → hồi sinh → thêm mới →
  rút không xoá, ca mơ hồ gắn cờ `shiftSuspected` /
  `identicalTextAmbiguous`) — sinh **báo cáo thay đổi** cho người
  duyệt (`retiredOutcomes` + `changeCounts` / `changes` trần 500 /
  `changesOmitted` trong kết quả nạp; trường `orphanedOutcomes` cũ
  bị bỏ), rồi dump lại bản mới.
- **Trạng thái rút lưu ở cột `learning_outcomes.retired_at`** +
  partial unique index cho ô (node, vị trí) hiện hành của diện
  dataset quản. Mọi đường đọc "chương trình hiện hành" lọc
  `retired_at IS NULL` tại repository `listOutcomes`; bản đặc tả
  trả `position`/`code` và bản xuất in mã YCCĐ tiền tố (backend là
  nguồn sự thật duy nhất cho vị trí).
- Phần subject/curriculum/node, ledger và FK restrict của ADR này
  giữ nguyên hiệu lực. Triển khai của đợt này = reset + restore
  dump.
