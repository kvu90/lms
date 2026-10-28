# @lms/api — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật cao nhất về quyết định: sổ quyết định `~/workspace/lms-nest-ops/decisions.md`.
> Quyết định nào trong sổ đã bị đánh dấu "ĐÃ THAY THẾ" thì không được ghi ở đây như còn hiệu lực.

## Package phụ trách nghiệp vụ gì

`apps/api` là backend duy nhất của sản phẩm: toàn bộ nghiệp vụ của một LMS cho **lớp học
online** tương thích nghiệp vụ sư phạm Việt Nam (Moodle là sàn tối thiểu) chạy qua API này —
khoá học, lớp học, ghi danh, ngân hàng câu hỏi/đề/ma trận, quiz, bài tập, điểm theo bài, nhắn tin,
thông báo, thanh toán học phí, chấm bài giấy bằng camera, MCP cho AI nhập câu hỏi, quản trị
tenant (trung tâm) và nền tảng. Mọi quy tắc nghiệp vụ bất biến phải được thực thi **ở đây,
phía server** — client không bao giờ là nơi gác nghiệp vụ duy nhất.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Ngoài phạm vi: nghiệp vụ hành chính trường học (điểm danh hành chính, sổ đầu bài, thời khoá biểu trường, đơn xin nghỉ) — đất của vnEdu/SMAS. Cầu nối duy nhất là XUẤT dữ liệu đúng mẫu. | Sổ quyết định mục A, chốt 24/10/2026 |
| Multi-tenant: tenant = **TRUNG TÂM** (không phải trường học). Trang chính là tenant nền tảng: quản ngân hàng CHUNG + phục vụ GV/HS tự do. Tenant tách biệt nhau; lấy nội dung từ kho chung bằng **copy + ghim phiên bản**, không đồng bộ sống. Nền kỹ thuật: shared DB + `tenant_id` + PostgreSQL RLS fail-closed; platform không có quyền ngầm trong tenant — hỗ trợ chỉ qua `loginas` có lý do + audit. | Sổ mục A, chốt 25/10/2026 (12:23, đính chính 15:29); issue #166, TENANT-0 đã merge |
| Lớp học là thực thể cha hạng nhất: tạo lớp TRƯỚC, khoá học nằm trong lớp; GV tự do cũng bắt buộc có lớp trước. Ghi danh chủ yếu là ghi danh VÀO LỚP (roster của lớp vật chất hoá xuống từng khoá). | Sổ mục A, chốt 25/10/2026 15:51; issue #184 |
| Định danh capability: dạng duy nhất `<area>:<name>`, **bỏ hẳn mọi tiền tố** (`moodle/`, `mod/`, `lms/`, `report/`). | Sổ mục B, chốt 24/10/2026; issue #35 |
| Phân quyền/đọc ngân hàng câu hỏi theo **cây CONTEXT + capability tại context** (kiểu Moodle), KHÔNG theo nhãn scope. Admin có khu ngân hàng riêng đúng như giáo viên. | Sổ mục B, chốt 25/10/2026 08:08 + 08:45 |
| Đề thi: đúng MỘT thực thể `exam_papers` (hai dạng snapshot/recipe). Ma trận theo CV 7991 (hàng = chủ đề × đơn vị kiến thức; cột = dạng câu × 3 mức Biết/Hiểu/Vận dụng); cấu trúc đề tốt nghiệp theo QĐ 764. | Sổ mục B, chốt 24/10/2026 |
| `books` là thực thể độc lập (`book_nodes`, `book_mappings`). **Không hiển thị nguồn sách trên câu hỏi ở bề mặt học sinh làm bài**; cờ ghi công khai trên sách mặc định TẮT; API phía học viên không trả trường nguồn sách. | Sổ mục B, chốt 24–25/10/2026 |
| Mô hình điểm — điểm CHỈ theo từng bài kiểm tra/bài tập: **BỎ Sổ điểm Việt Nam (vn-books TT 22/27) và BỎ gradebook tổng hợp theo khoá**. Nguồn sự thật duy nhất của điểm = điểm của từng hoạt động (quiz attempt, bài tập đã chấm); **công bố ở cấp bài** — HS/PH chỉ thấy điểm của bài đã công bố. Được phép đúng MỘT lớp xem CHỈ-ĐỌC dạng lưới học sinh × các bài của khoá (GV nhìn nhanh, HS xem các điểm của mình cạnh nhau) — lớp này KHÔNG lưu điểm tổng, KHÔNG trọng số, KHÔNG chốt kỳ. **Xuất vnEdu đổi nguồn**: xuất từ điểm ĐÃ CÔNG BỐ của các bài GV chọn xuất (quy tắc cũ "xuất chính thức từ bản chốt của sổ điểm VN" đã bị thay thế). | Sổ mục B, quyết định ngày 25/10/2026 23:49 theo research thị trường VN; issue #224 |
| Thông báo: P2 — hai loại bắt buộc không tắt được ở kênh trong-app (hết hạn ghi danh; quản trị/an toàn). P3 — tắt tiếng theo khoá vẫn chừa điểm mới + hết hạn ghi danh. P4 — kênh ngoài tối thiểu hoá (không điểm, không nội dung tin trong email/push) là luật CỨNG. P5 — thông báo nộp bài cho GV gộp theo bài tập. Phân tầng cài đặt: loại sự kiện nào được gửi do **ADMIN cài ở cấp site**; học sinh chỉ có tuỳ chọn tối thiểu (tắt tiếng theo khoá), chặn ở API. | Sổ mục C, chốt 25/10/2026 15:02 + 23:09; issue #174 |
| Nhắn tin: KHÔNG đính kèm file; KHÔNG tìm người theo tên; nhắn riêng chỉ giữa liên hệ đã kết bạn — NGOẠI LỆ: GV nhắn thẳng HS thuộc khoá/lớp của mình không cần kết bạn (chặn vẫn thắng; hết quan hệ thì gửi bị chặn, đọc cũ còn được). HS không tự lập nhóm ngoài cấu trúc lớp/khoá. Trần một tin 10.000 ký tự qua site-config, vượt trần trả 400. Emoji phản ứng cố định 6 (👍 ❤️ 😂 😮 😢 👏). | Sổ mục D; issue #33 + bổ sung 25/10/2026 |
| Thanh toán: **VietQR/SePay của Việt Nam — không gắn cổng quốc tế**. QR động NAPAS247; chỉ `succeeded` khi khớp đủ 3 điều kiện (mã đã chuẩn hoá + số tiền đúng + tài khoản nhận trùng), thiếu bất kỳ điều kiện nào → `needs_review`, KHÔNG kích hoạt quyền lợi. Hai dòng tiền tách bạch tuyệt đối: tiền platform về tài khoản platform; học phí trung tâm về tài khoản của CHÍNH trung tâm — **platform không thu hộ**. | Sổ mục E, chốt 25/10/2026 15:21; issue #189 |
| Chấm bằng camera (CAM): phiếu DÙNG CHUNG in hàng loạt, HS tự ghi + tô mã (SBD 8 số đúng SBD Bộ + mã đề 4 số). Ảnh phiếu (gốc + đã nắn) phải lưu vào **kho bền vững** (adapter S3 sau port ObjectStorage) để đối chiếu ngược và cho MCP kiểm tra chấm về sau. Tự luận là tính năng THU TIỀN sau này: AI đọc viết tay → GV duyệt cuối. | Sổ mục E; issue #112 |
| MCP nhập câu hỏi bằng AI: đích ghi = ngân hàng cá nhân của GV, câu vào trạng thái `draft`, `source_kind='ai'`. Ghi vào ngân hàng chung CHỈ qua duyệt contribution bởi con người — không có scope nào cho ghi thẳng vào bank chung. | Sổ mục E; issue #163 |
| Dữ liệu chuẩn GDPT: nạp bằng phương án D (UUIDv5 theo khoá tự nhiên + import diff KHÔNG xoá). Môn GDQP&AN tạm thời KHÔNG làm. | Sổ mục E; issue #74 (đã đóng) |
| Đăng nhập chính hiện tại vẫn là JWT tự viết; Better Auth chạy song song (MCP authorization server + nền phiên cookie). GĐ2 thi công trọn theo lệnh 26/10/2026 — email qua Resend thay SMTP, OAuth Google + Facebook; các chặng 2.1–2.6 và chuẩn bị 2.7 (cờ `AUTH_CUTOVER_STAGE`, cửa sổ bake, diễn tập rollback) làm trước, KHÔNG chờ bí mật. Cutover thật (bước B: bật cờ production + gỡ legacy) là cổng riêng, chỉ chờ bí mật cấp qua cấu hình Heroku (Resend key/domain, OAuth client id/secret). | Sổ mục F (dòng 26/10 thay thế điều kiện chờ SMTP cũ); issue #7 |
| Dự án đang xây từ đầu: **reset dữ liệu thoải mái cho tới khi chốt version** — không thiết kế migration giữ dữ liệu live. | Sổ mục F, chốt 23/10/2026 |

## Ranh giới — package này KHÔNG làm gì

- Không làm nghiệp vụ hành chính trường học (xem quyết định ở trên) — kể cả khi có sẵn dữ
  liệu gần giống (chuyên cần học tập không phải điểm danh hành chính, cũng không phải
  điểm của bất kỳ bài kiểm tra/bài tập nào).
- Không chứa giao diện: API chỉ trả dữ liệu + gác quyền; trình bày thuộc `apps/web`.
- Không tự quyết định nghiệp vụ mới: quyết định chưa có trong sổ quyết định thì dừng và
  báo main chat để quyết, không tự chế theo tài liệu audit/research mới hơn.
- Không giữ job nền dài hạn: processor/định kỳ thuộc `apps/worker` (API chỉ ghi outbox/job).

## Kỹ thuật tối thiểu

- NestJS 12, prefix `/api/v1`. Schema route chỉ dùng kiểu biểu diễn được trong JSON
  Schema (ngày giờ = `z.iso.datetime(...)`) — `z.date()` làm app chết lúc boot
  production qua Swagger (đã có test hồi quy `openapi-document`).
- Boot local, migrate, seed: xem `package.json` (`db:migrate`, `seed:review`) và
  README gốc của repo. Tài khoản demo ghi công khai trong README gốc của repo.
