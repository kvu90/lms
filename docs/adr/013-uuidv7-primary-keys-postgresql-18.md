# ADR-013: Khóa chính UUIDv7 trên PostgreSQL 18

## Trạng thái
Accepted (22/10/2026). Nguồn thiết kế: báo cáo nghiên cứu nội bộ
`research_notes/postgresql-18-uuidv7-primary-keys-20261022-1134/report.md`
(Mục 4). Bổ sung cho ADR-002 (Drizzle) và ADR-009 (Zod-only).

## Quyết định

### Quy ước khóa chính
- Mọi bảng nghiệp vụ dùng PK `uuid` với `DEFAULT uuidv7()` **sinh phía
  PostgreSQL 18** (hàm native của PG 18). Tuyệt đối không dùng
  `defaultRandom()` (đó là UUIDv4).
- Mọi cột FK tương ứng đổi sang `uuid` và có **index tường minh** (PG
  không tự index phía referencing của FK).
- Bảng nối thuần túy (không thuộc tính/vòng đời riêng, không được tham
  chiếu như thực thể) dùng **PK phức hợp** và bỏ cột `id` thừa:
  `groupings_groups` (groupingid, groupid), `cohort_members` (cohortid,
  userid), `message_conversation_members` (conversationid, userid),
  `message_users_blocked` (userid, blockeduserid). Bảng nối có thuộc
  tính riêng (sortorder, ruleoutcome, thời điểm...) giữ `id` uuid như
  thực thể.
- Hai bảng mà PK đồng thời là FK duy nhất giữ nguyên dạng đó:
  `course_completion_settings.course`, `tag_correlation.tagid`.

### Cột số phụ cho thứ tự tuyệt đối
Tính đơn điệu của UUIDv7 chỉ đảm bảo **trong cùng một phiên kết nối**,
nên `event_log` và `outbox_events` có thêm cột phụ
`seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE` (không phải PK) làm
thứ tự replay toàn cục tuyệt đối.

### Sinh id phía app — có chọn lọc
Mặc định id do DB sinh. Chỉ hai ca cần id **trước khi insert** mới gắn
`$defaultFn(() => uuidv7())` (thư viện `uuid`, bản latest) và vẫn giữ
DB default trên cột: `outbox_events.id` và `event_log.id` (transactional
outbox cần id để ghi payload/tham chiếu trong cùng transaction). Kiểm
chứng không trùng khi trộn hai nguồn sinh nằm trong bộ test nền tảng.

### Ngoại lệ có chủ đích
- `rating.scaleid` **giữ `integer`**: đây là mã hoá signed kiểu Moodle
  (dương/âm = điểm tối đa của thang), không phải khóa ngoại — module
  `social` tính `Math.abs(scaleid)`.
- Sentinel số `0` của các cột tham chiếu thực thể (parent, instanceid,
  customint1/2...) chuyển thành **`NULL`** ở cả DB, contracts và
  service.
- `payments.userid` là cột `NOT NULL`: khi ẩn danh hoá (privacy erase),
  userid được ghi **nil UUID** `00000000-0000-0000-0000-000000000000`
  làm tombstone vì không thể ghi NULL. Nil UUID không bao giờ là id
  của một bản ghi thật và không được dùng làm sentinel ở nơi khác.

### Validate id ở biên — Zod-only
- Id trên đường dẫn/body được validate bằng `uuidIdSchema` trong
  `@lms/contracts` (`z.uuid()`), qua cơ chế Standard Schema của Nest
  (`@Param('x', { schema: uuidIdSchema })`), nhất quán ADR-009.
- **Kết quả kiểm chứng ParseUUIDPipe**: đọc trực tiếp mã nguồn bản đã
  cài `@nestjs/common@12.2.0` — `ParseUUIDPipe` **có** hỗ trợ
  version `'7'` (`uuidRegExps` có khoá 7 và 8; type `UUIDVersion` gồm
  `'7'`). Dù vậy cơ chế chốt vẫn là Zod-only như trên, để một chuẩn
  validate duy nhất cho toàn hệ (class-validator/pipe rời rạc không
  được dùng cho id).

## Đánh đổi (trade-off)
- PK 16 byte thay vì 8 byte: theo benchmark trong báo cáo nghiên cứu,
  index khóa chính lớn hơn ~40%, nhưng tốc độ insert của UUIDv7 gần
  ngang bigint (bulk insert 5M dòng: bigint 23,2s / v7 27,0s / v4
  46,3s) nhờ tính time-ordered — chấp nhận được ở quy mô hiện tại.
- UUIDv7 **lộ thời điểm tạo bản ghi tới mili-giây** cho bất kỳ ai thấy
  id: khóa khó đoán không thay thế kiểm quyền theo context (tài nguyên
  ngoài phạm vi vẫn 404/403), và **không bao giờ dùng UUIDv7 làm token
  bí mật** — token giữ cơ chế ngẫu nhiên riêng như trước.
- Phân trang keyset dùng cặp `(created_at, id)` làm con trỏ, không dựa
  vào tính đơn điệu liên phiên của id.

## Hệ quả
- Migration yêu cầu **PostgreSQL >= 18**: `uuidv7()` không tồn tại ở
  bản thấp hơn, baseline migration sẽ fail trên PG cũ — đây là hành vi
  cố ý. Môi trường local, CI (service `postgres:18.6`) và tài liệu đều
  chốt PostgreSQL 18.6; image PG 18 đổi đường thư mục dữ liệu nên nơi
  nào mount volume phải trỏ `/var/lib/postgresql` (CI hiện không mount
  volume cho service postgres nên chỉ cần đúng tag image).
- Toàn bộ tầng app dùng `string` cho id (contracts, service,
  repository, worker, web); fixtures test cần id ổn định dùng hằng
  UUIDv7 cố định.

## Điều kiện xem lại
- Khi `event_log`/bảng log lớn cho thấy số đo lưu trữ hoặc kích thước
  index PK gây vấn đề vận hành đo được (không phải suy đoán), đánh giá
  lại quy ước riêng cho các bảng đó (ví dụ khoá tổng hợp theo thời
  gian) bằng một ADR mới.
- Khi `@nestjs/common` hoặc chuẩn Standard Schema của Nest thay đổi
  cách validate tham số, rà lại cơ chế validate id ở biên.
