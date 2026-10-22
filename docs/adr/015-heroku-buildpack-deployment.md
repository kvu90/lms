# ADR-015: Triển khai review trên Heroku bằng buildpack thuần và addon

## Trạng thái
Accepted (22/10/2026). Một vấn đề hạ tầng còn mở được ghi ở cuối.

## Bối cảnh
Bản review cần một địa chỉ cố định để Lão gia vào xem trực tiếp thay cho
đường hầm tạm tới localhost. Tài khoản Heroku của Lão gia đã kết nối qua
connector `custom.heroku` (Platform API). Heroku Postgres 18 là bản mặc
định GA nên `uuidv7()` native của ADR-013 chạy nguyên vẹn. Phương án
Docker (container stack, build image tại máy triển khai) đã bị loại vì
môi trường máy triển khai không tạo được container một cách tin cậy, và
phương án git push thẳng tới `git.heroku.com` bị Heroku từ chối xác thực
(xem mục Quyết định).

## Quyết định
- **Một app Heroku duy nhất** (`kvu-lms`, stack `heroku-24`), Node
  buildpack chính thức. Địa chỉ app thực tế do Heroku cấp có dạng
  `https://kvu-lms-573c864b6f10.herokuapp.com/` — tên miền dạng
  `kvu-lms.herokuapp.com` không được cấp và trả về trang "No such app".
- **Procfile ở gốc repo**: `web: node apps/api/dist/main.js`,
  `worker: node apps/worker/dist/main.js`. API phục vụ luôn giao diện
  web tĩnh qua `WEB_DIST_DIR=/app/apps/web/dist` (express static cộng
  SPA fallback), nên một dyno web là đủ cho cả API lẫn frontend.
- **Build trên Heroku** bằng script gốc `heroku-postbuild`:
  `turbo run build --filter=@lms/api --filter=@lms/worker --filter=@lms/web`,
  `engines.node` là `24.x`, `packageManager` ghim `pnpm@12.14.0`.
- **Addon**: Heroku Postgres `essential-0` và Heroku Key-Value Store
  (Redis) `mini`. Formation `web=1, worker=1` cỡ Eco.
- **Đường đưa source lên**: git push qua cơ chế credential surrogate bị
  Heroku chặn vì git transport đòi Basic auth bằng mật khẩu thô (probe
  tới `git.heroku.com/<app>.git/info/refs` trả 401
  `WWW-Authenticate: Basic realm="Heroku"`). Do đó dùng luồng Sources
  của chính Heroku: `POST /apps/<app>/sources`, tải tarball
  `git archive HEAD` lên URL Heroku cấp (PUT phải qua curl với header
  `Content-Type` trống, tránh chữ ký S3 lệch), rồi
  `POST /apps/<app>/builds` và chờ build xong. Source không đi qua bất
  kỳ dịch vụ lưu trữ hay trung gian nào ngoài Heroku.
- **Migration và seed** chạy bằng one-off dyno sau khi release:
  `pnpm --filter @lms/api db:migrate && pnpm --filter @lms/api seed:review`.
- **TLS cho Postgres**: cờ `DATABASE_SSL=true` bật
  `ssl: { rejectUnauthorized: false }` cho pg Pool của Drizzle ở cả api
  và worker, và drizzle-kit phải dùng `sslmode=no-verify` trong URL —
  `pg-connection-string` đối xử `sslmode=require` như `verify-full` ở
  nhánh mặc định nên chứng chỉ của Heroku Postgres bị từ chối nếu chỉ
  đặt `require`.
- **TLS cho Redis**: URL `rediss://` phải bật TLS ở mọi client — helper
  dùng chung cho ioredis (probe health, khoá phân tán), options của
  BullMQ, và `@keyv/redis`. Lưu ý `@keyv/redis` 6.x dựng trên
  `@redis/client` chứ không phải ioredis, nên TLS của nó đi qua
  `socket: { tls: true, rejectUnauthorized: false }`.

## Hệ quả và bài học vận hành
- Buildpack prune devDependencies khỏi slug, nên mọi thứ đường chạy
  cần phải nằm trong `dependencies`: `drizzle-kit` (chạy migration) và
  `@lms/config` (tsconfig extends lúc drizzle-kit nạp cấu hình) đã được
  chuyển sang `dependencies` của `@lms/api` vì lý do này.
- Dyno Eco có giới hạn đúng một one-off dyno chạy đồng thời
  (`cannot_run_above_limit`). Tiến trình seed boot trọn API nên không
  tự thoát khi gặp lỗi kết nối nền — phải xoá dyno one-off thủ công nếu
  nó treo, nếu không mọi one-off dyno sau đều bị 422.
- Dyno Eco ngủ sau 30 phút không dùng. Hệ thống file của Heroku là tạm
  thời nên file người dùng tải lên sẽ mất khi dyno khởi động lại — lưu
  trữ file bền vững cần một object storage riêng, ngoài phạm vi đợt này.
- Giới hạn tốc độ của ADR-014 đếm trong bộ nhớ của từng instance nên
  mưa dyno sẽ nới lỏng giới hạn tương ứng.

## Vấn đề còn mở: tầng dữ liệu Key-Value Store mini không bắt tay được TLS
Tại thời điểm chốt ADR này, `GET /api/v1/health` trả database `up`
nhưng redis `down`, dù code đã theo đúng công thức kết nối Node.js
trong tài liệu chính thức "Connecting to Heroku Key-Value Store"
(`tls: { rejectUnauthorized: false }` cho ioredis). Bằng chứng thu
trong one-off dyno: TCP connect tới endpoint thành công, nhưng bắt tay
TLS bị phía server đóng ngay sau ClientHello — OpenSSL báo
`SSL handshake has read 0 bytes` và `unexpected eof while reading`,
không nhận được chứng chỉ nào. Hiện tượng lặp lại y hệt trên hai
instance mini tạo độc lập, trong khi Postgres (cũng TLS trên AWS) kết
nối bình thường từ cùng dyno. Kết luận tạm thời: lỗi nằm ở tầng dữ
liệu của gói mini phía Heroku, không phải cấu hình client. Hướng xử lý
để Lão gia quyết: mở ticket hỗ trợ Heroku kèm bằng chứng trên, hoặc
thử gói Key-Value Store cao hơn (tầng dữ liệu khác, chi phí cao hơn).
Các chức năng không phụ thuộc Redis (đăng nhập, dữ liệu khoá học, giao
diện) hoạt động bình thường; cache, hàng đợi BullMQ và khoá phân tán
chưa dùng được trên bản review này.
