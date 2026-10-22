# Runbook vận hành

Tài liệu cho người vận hành hệ LMS này (dev/review hiện tại, production
sau này). Các quy trình đã được diễn tập trên máy dev ngày 22/10/2026
trừ nơi ghi rõ là chưa diễn tập.

## 1. Kiểm tra sức khoẻ nhanh

```bash
curl http://localhost:3000/api/v1/health
# {"status":"ok",...,"checks":{"database":"up","redis":"up"}}
pg_isready -h localhost -p 5432        # PostgreSQL 18.6
redis-cli ping                          # PONG
```

Khởi động toàn hệ thống: xem mục "Review" trong `README.md` (một lệnh
`pnpm dev` sau khi đã migrate + seed).

## 2. Xoay khoá JWT (JWT_SECRET)

Access token là JWT ký bằng `JWT_SECRET`; refresh token cũng là JWT và
chỉ **hash** của nó được lưu trong bảng `refresh_token_family` (phục
vụ rotation + phát hiện dùng lại token đã xoay).

Quy trình xoay khoá (ví dụ khi nghi lộ khoá):

1. Sinh secret mới (≥ 32 ký tự ngẫu nhiên), cập nhật `JWT_SECRET`
   trong `apps/api/.env` (và của worker nếu worker ký token — worker
   hiện không ký, chỉ API ký).
2. Khởi động lại API.
3. Hệ quả tất yếu và mong muốn: **mọi access token và refresh token
   hiện hành đều mất hiệu lực ngay**; toàn bộ người dùng phải đăng
   nhập lại. Không cần xoá dữ liệu — `refresh_token_family` chỉ chứa
   hash của các token nay đã không vượt qua được bước kiểm chữ ký.

Thu hồi phiên của MỘT người dùng mà không xoay khoá: khoá tài khoản
(suspend) qua API quản trị — luồng suspend đã tự huỷ các token hiện
hành của người dùng đó; hoặc xoá các dòng `refresh_token_family` của
người dùng đó và đợi access token hết hạn (TTL mặc định 15 phút).

## 3. Phát lại sự kiện outbox (outbox replay)

Sự kiện nghiệp vụ ghi vào `outbox_events` trong cùng transaction với
thay đổi dữ liệu (ADR-004). Worker/API relay quét các dòng
`published_at IS NULL` theo cột `seq`, đẩy vào queue rồi đóng dấu
`published_at`. Processor ở worker **idempotent** (khử trùng theo
jobId/id sự kiện) nên phát lại là an toàn.

Khi một sự kiện kẹt (đã published nhưng phía nhận xử lý lỗi, hoặc cần
chạy lại sau khi sửa dữ liệu):

```sql
-- Xem các sự kiện gần nhất và trạng thái
SELECT seq, id, aggregate, type, occurred_at, published_at
FROM outbox_events ORDER BY seq DESC LIMIT 20;

-- Phát lại đúng một sự kiện: relay sẽ nhặt lại ở vòng quét kế tiếp
UPDATE outbox_events SET published_at = NULL WHERE id = '<uuid-su-kien>';
```

Kiểm chứng sau phát lại: sự kiện được đóng dấu `published_at` mới và
hiệu ứng nghiệp vụ xuất hiện đúng một lần (nhờ idempotency).

## 4. Dọn file mồ côi (orphan file cleanup)

Nội dung file lưu theo content hash (SHA-256) tại
`FILE_STORAGE_DIR/<2 ký tự đầu>/<2 ký tự tiếp>/<hash>`. Khi bản ghi
`files` cuối cùng tham chiếu một hash bị xoá, một job vào queue
`file-cleanup`; processor kiểm lại refcount **tại thời điểm chạy**
(không tin số đếm lúc enqueue) và chỉ xoá vật lý khi refcount = 0.

- Kiểm tra job tồn đọng: xem queue `file-cleanup` trong Redis
  (`redis-cli LLEN bull:file-cleanup:wait` và các key `bull:file-cleanup:*`).
- Nghi có hash mồ côi chưa có job (ví dụ sau sự cố): đối chiếu danh
  sách hash trong bảng `files` với thư mục lưu trữ, enqueue lại job
  `{ contenthash }` cho các hash không còn bản ghi nào — processor sẽ
  tự xác minh refcount trước khi xoá.

## 5. Đọc dấu vết kiểm toán (audit trail)

- `event_log`: nhật ký sự kiện miền bất biến, có cột `seq` làm thứ tự
  phát lại toàn cục (ADR-013).
- `outbox_events`: sự kiện đã/đang phát cho các hệ phụ (email, search
  index, analytics…).
- `admin_setting_audit`: thay đổi cấu hình site do quản trị viên thực
  hiện (khoá cấu hình, giá trị cũ/mới, người đổi).
- Các thao tác nhạy cảm trên người dùng (tạo/sửa/khoá/mở khoá/xoá)
  đều phát sự kiện qua outbox (`user_created`, `user_suspended`, …).

```sql
SELECT seq, event_type, user_id, created_at FROM event_log
ORDER BY seq DESC LIMIT 50;
SELECT * FROM admin_setting_audit ORDER BY created_at DESC LIMIT 20;
```

## 6. Giới hạn tốc độ và CORS — chỉnh thế nào cho đúng

- `RATE_LIMIT_PER_MINUTE` (mặc định 3000) và
  `RATE_LIMIT_AUTH_PER_MINUTE` (mặc định 300) tính **theo IP nguồn**.
  Cảnh báo NAT: một trường học có thể có hàng trăm học viên sau một
  IP công cộng; vào giờ vào lớp, số lần đăng nhập/phút từ một IP có
  thể tới hàng trăm. Chỉ siết chặt sau khi đã đo lưu lượng thật.
- Sau reverse proxy, IP nguồn mà API thấy là IP của proxy trừ khi
  proxy chuyển tiếp `X-Forwarded-For` và tầng Express được cấu hình
  tin proxy (`trust proxy`) — khi triển khai sau proxy phải xử lý
  điểm này trước, nếu không mọi hạn mức dồn vào một "IP" duy nhất và
  429 diện rộng.
- `CORS_ORIGINS`: danh sách origin của web, phân tách bằng dấu phẩy.
  Frontend dev đi qua proxy của Vite nên không cần CORS; client gọi
  API trực tiếp (mobile/web domain riêng) mới cần khai đúng origin.
- Scale nhiều instance API: bộ đếm rate limit đang ở bộ nhớ từng
  instance (ADR-014) — chuyển sang storage Redis trước khi scale.

## 7. Sao lưu và khôi phục

Định dạng backup của hệ là archive riêng có version (ADR-007), tạo và
khôi phục qua module Backup (API + worker processor). Khôi phục luôn
sinh id mới cho bản ghi đích và ghi bảng ánh xạ id — không bao giờ
ghi đè id gốc. Diễn tập khôi phục vào một DB trống theo trình tự:
tạo DB → migrate → restore archive → seed không cần thiết → kiểm tra
đăng nhập và mở khoá học đã khôi phục. (Diễn tập đầy đủ trên môi
trường production-like: chưa thực hiện, làm trước go-live.)

## 8. Nâng cấp PostgreSQL

- Hệ yêu cầu **PostgreSQL ≥ 18** (migration dùng `uuidv7()`), đang
  chốt 18.6. Nâng minor 18.x: nâng package/image, restart, chạy lại
  migration (no-op) và toàn bộ test.
- Nếu sau này dùng Docker image chính thức: từ PG 18 thư mục dữ liệu
  là `/var/lib/postgresql/18/docker` và volume phải mount vào
  `/var/lib/postgresql` — mount theo đường cũ `/var/lib/postgresql/data`
  sẽ không thấy dữ liệu (ADR-013).
- CI đã ghim `postgres:18.6` trong `.github/workflows/ci.yml`.

## 9. Mốc hiệu năng đường nóng (đo 22/10/2026)

Đo bằng `apps/api/scripts/benchmark-hot-paths.mjs` chống lại API +
PostgreSQL 18.6 + Redis trên cùng một máy dev (không phải phần cứng
production), khoá học nhân tạo 60 học viên × 3 đầu điểm, 30 request
tuần tự mỗi đường:

| Đường | p50 | p95 | max |
|---|---|---|---|
| GET /api/v1/users/me (học viên) | 4 ms | 8 ms | 10 ms |
| GET /api/v1/courses/:id/content (học viên, có kiểm capability) | 8 ms | 11 ms | 22 ms |
| GET /api/v1/courses/:id/gradebook (giáo viên, 60 học viên) | 7 ms | 11 ms | 12 ms |
| GET /api/v1/courses (quản trị) | 3 ms | 5 ms | 5 ms |

Đây là mốc tham chiếu để phát hiện suy giảm (regression) giữa các
đợt, không phải cam kết hiệu năng. PermissionEvaluator có cache Redis
theo (user, capability, context, path version) nên chi phí kiểm quyền
không tăng tuyến tính theo độ sâu cây context. Đo lại sau mỗi thay
đổi lớn ở tầng access/grades và cập nhật bảng này kèm ngày đo.
