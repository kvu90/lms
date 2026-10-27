# LMS — TypeScript (NestJS + React)

Một LMS TypeScript viết từ đầu, có phạm vi nghiệp vụ tương đương các phân
hệ lõi của Moodle (chỉ backend; không tương thích ngược với cơ sở dữ
liệu, định dạng file hay giao thức của Moodle — xem báo cáo nghiên cứu).

## Cấu trúc thư mục

```
apps/
  api/      REST API NestJS 12 (TypeScript 6), Drizzle ORM, BullMQ, cache Redis
  worker/   Tiến trình nền NestJS 12: các processor BullMQ, outbox relay, các job chạy theo lịch
  web/      SPA React + Vite + React Router (TypeScript 7), shadcn/ui + Tailwind
packages/
  contracts/  Các schema zod dùng chung (Problem Details, health, …) — hợp đồng duy nhất giữa api và web
  config/     Các tsconfig cơ sở dùng chung
```

Luật phụ thuộc: `web` chỉ phụ thuộc vào `contracts`; `api`/`worker` dùng
chung cơ sở dữ liệu và Redis nhưng chạy ở các tiến trình riêng. Frontend
không bao giờ import code backend hay schema cơ sở dữ liệu.

## Điều kiện tiên quyết

- Node 24 (`.nvmrc`), pnpm 12.14
- PostgreSQL 18.6 tại `localhost:5432` (người dùng `postgres`/`postgres`, các DB `lms` và `lms_test`) — bắt buộc bản 18.x: khoá chính mặc định dùng hàm `uuidv7()` native
- Redis tại `localhost:6379`

## Phát triển trong Dev Container

Không cần cài gì trên máy ngoài Docker và VS Code: repo có sẵn định
nghĩa Dev Container ở `.devcontainer/` tái tạo đúng các điều kiện
tiên quyết ở trên — một service `app` (Node 24; pnpm 12.14 cấp qua
corepack, đúng phiên bản ghim ở trường `packageManager` của
`package.json` gốc) cùng hai service `db` (PostgreSQL 18.6) và `redis`
(Redis 7), dùng đúng các image mà CI đang dùng. Ba service dùng chung
một network namespace nên mọi mặc định localhost của repo
(`localhost:5432`, `localhost:6379`) chạy nguyên trạng trong
container — cùng cách bố trí như môi trường local ở mục dưới. Ở lần
khởi động đầu tiên, service cơ sở dữ liệu tạo sẵn các DB `lms`,
`lms_test`, `lms_test_api` và `lms_test_worker` (người dùng và mật
khẩu đều là `postgres`). Khi tạo container, dependencies được cài sẵn
(`pnpm install --frozen-lockfile`) và `apps/api/.env` /
`apps/worker/.env` được chép từ các file `.env.example` tương ứng.

Mở thư mục repo trong VS Code và chạy "Dev Containers: Reopen in
Container", rồi thực hiện đúng các bước như môi trường review local ở
mục dưới (migrate, seed, `pnpm dev`) trong terminal của container.
Cổng 3000 (API) và 5173 (web) được chuyển tiếp ra máy host.

Container này CHỈ phục vụ phát triển — không còn đường triển khai
bằng Docker. `Dockerfile` ở gốc repo (image triển khai đa target cho
Heroku Container Registry) đã bị XOÁ ngày 27/10/2026 theo quyết định
về đường Docker của repo; triển khai chạy theo đường buildpack Heroku
như mô tả ở mục [Môi trường review](#môi-trường-review), và hướng triển khai tương lai sẽ
được quyết định riêng.

## Chạy ứng dụng

```bash
pnpm install
cp apps/api/.env.example apps/api/.env       # các giá trị mặc định đã khớp hạ tầng local
pnpm --filter @lms/api db:migrate            # tạo các bảng hạ tầng
pnpm --filter @lms/api build && pnpm --filter @lms/api start   # API ở cổng :3000
pnpm --filter @lms/worker build && pnpm --filter @lms/worker start
pnpm --filter @lms/web dev                   # web ở cổng :5173 (proxy /api → :3000)
```

- Health: `GET http://localhost:3000/api/v1/health`
- OpenAPI: `http://localhost:3000/api/docs`

## Môi trường review

### Bản review đã triển khai (chính)

Toàn bộ stack chạy trên Heroku dưới dạng app `kvu-lms` (triển khai bằng buildpack):

- App: https://kvu-lms-573c864b6f10.herokuapp.com/ (đăng nhập tại `/login`)
- Health: `GET https://kvu-lms-573c864b6f10.herokuapp.com/api/v1/health`
- Hostname do Heroku cấp ở trên mới là hostname thật — tên
  `kvu-lms.herokuapp.com` không được cấp và trả về "No such app".
- Dyno Eco ngủ sau 30 phút không hoạt động, nên request đầu tiên có thể
  mất vài giây để đánh thức app.
- Vấn đề đã biết: data plane mini của Key-Value Store (Redis) hiện từ
  chối bắt tay TLS từ các dyno của app, nên health báo
  `redis: down` trong khi `database: up`. Đăng nhập, dữ liệu khoá học và giao diện
  vẫn hoạt động; các tính năng dựa trên cache/queue bị suy giảm.

Dùng các tài khoản mẫu trong bảng dưới đây để đăng nhập.

### Môi trường review local (dự phòng)

Mọi nội dung dưới đây CHỈ dành cho **môi trường phát triển/review
local** — các mật khẩu là thông tin đăng nhập mẫu cho các tài khoản
demo được seed, tuyệt đối không dùng cho production.

### Khởi động toàn bộ stack (theo thứ tự)

```bash
# 1) Hạ tầng (máy này)
sudo pg_ctlcluster 18 main start          # PostgreSQL 18.6 tại localhost:5432 (hoặc: sudo service postgresql start)
redis-server --daemonize yes              # Redis tại localhost:6379 (hoặc: sudo service redis-server start)

# 2) Cài đặt + schema + dữ liệu mẫu (chỉ lần chạy đầu; seed có tính idempotent)
pnpm install
cp apps/api/.env.example apps/api/.env    # các mặc định khớp hạ tầng local (bỏ qua nếu .env đã có)
pnpm --filter @lms/api db:migrate
pnpm seed                                 # build API, rồi seed dữ liệu mẫu dưới đây

# 3) Chạy mọi thứ (API :3000, worker, web :5173) bằng một lệnh
pnpm dev
```

- Trang đăng nhập: `http://localhost:5173/login`
- Health của API: `http://localhost:3000/api/v1/health` · OpenAPI: `http://localhost:3000/api/docs`

### Tài khoản mẫu (được seed bằng `pnpm seed`)

| Vai trò | Tên đăng nhập | Mật khẩu |
|------|----------|----------|
| Quản trị site | `admin` | `Admin123!` |
| Giáo viên (giáo viên biên tập của khoá học mẫu) | `teacher1` | `Teacher123!` |
| Học viên | `student1` | `Student123!` |
| Học viên | `student2` | `Student123!` |

Tài khoản admin do chính bootstrap của API tạo từ
`ADMIN_USERNAME` / `ADMIN_PASSWORD` (các giá trị mặc định ở trên; ghi đè qua
`apps/api/.env`). Seed bổ sung: khoá học **DEMO101 — "Khoá học mẫu: Làm
quen với LMS"** với 3 section và 3 module, cả hai học viên đều đã ghi
danh, điểm mẫu (student1 = 8.5, student2 = 6.5 ở "Bài kiểm tra 1"), huy
hiệu "Huy hiệu khởi đầu" đã trao cho student1, và một sự kiện lịch của
khoá học vào 09:00 ngày mai.

Seed cũng nạp **toàn bộ chương trình GDPT 2018 cấp quốc gia**: cả 21
dataset đã kiểm chứng được đóng gói sẵn trong repo (2.115 bản ghi trên 19 môn
có dữ liệu — môn thứ 20, GDQP&AN, chưa có dataset đã kiểm chứng —
đối chiếu nguyên văn với tài liệu của Bộ). Seed **không** nạp từng
dataset theo từng bản ghi: nó restore bản dump chương trình đông
cứng đóng gói sẵn trong repo
(`apps/api/src/modules/curriculum/program-data-dump/program-dump.sql`,
được `ProgramDumpService` tạo một lần từ cơ sở dữ liệu chuẩn đã
kiểm chứng), nên một cơ sở dữ liệu dựng từ baseline + `pnpm seed`
đã chứa trọn cây chương trình với đúng cùng một tập định danh bản
ghi ở mọi môi trường — **sau khi reset không cần bước "import" thủ
công nào trong giao diện quản trị** (trang quản trị chỉ giữ đồng bộ
lại qua `ProgramImportService` như một tiện ích khi đính chính
dataset). Chạy lại seed sẽ bỏ qua phần chương trình khi dữ liệu đã
có mặt (restore theo cơ chế restore-if-empty), nên định danh chương
trình không bao giờ thay đổi khi seed lại. Đính chính một dataset
nghĩa là sửa ở cơ sở dữ liệu chuẩn rồi xuất lại dump
(`apps/api/src/export-program-dump.ts`), tuyệt đối không sửa tay
file dump.

### Các luồng chính cần review

Đăng nhập → mở khoá học mẫu → sổ điểm (giáo viên thấy báo cáo của
lớp) → ngân hàng câu hỏi → tin nhắn & thông báo → lịch → huy hiệu →
kế hoạch học tập → tìm kiếm → sao lưu / quyền riêng tư (các trang
platform, admin).

### Ngôn ngữ

Giao diện mặc định là **tiếng Việt**. Chuyển sang tiếng Anh bằng bộ
chọn "Ngôn ngữ / Language" trên thanh trên cùng; API cũng trả lời bằng
tiếng Việt theo mặc định và tôn trọng `Accept-Language: en`.

## Kiểm chứng (định nghĩa "xanh")

```bash
pnpm install
turbo run build typecheck test
```

## Vận hành

Bảo vệ ở biên HTTP: các header bảo mật tiêu chuẩn trên mọi
response, CORS giới hạn trong `CORS_ORIGINS`, và giới hạn tốc độ hai lớp theo IP
bằng `@nestjs/throttler` chính thức — một giới hạn toàn cục
`RATE_LIMIT_PER_MINUTE` cộng một giới hạn chặt hơn
`RATE_LIMIT_AUTH_PER_MINUTE` cho các route auth có kiểm tra thông tin
đăng nhập. Hãy cân nhắc kỹ trước khi siết chặt: các trường học đứng
sau NAT dùng chung một IP công cộng.

## Chính sách phiên bản

Luôn dùng bản phát hành mới nhất của mọi dependency, trừ khi một trở
ngại đã ghi thành văn bản buộc phải ghim phiên bản (ghi ở dưới). Các
ghim/trở ngại hiện tại:

- Các app NestJS (`api`, `worker`): TypeScript **6.0.3** — `nest build`/toolchain của Nest
  chưa hỗ trợ TypeScript 7. Mọi thứ còn lại: 7.0.2.
- Drizzle: `drizzle-orm@rc` / `drizzle-kit@rc` (1.0.0-rc.5) qua tích
  hợp `@nestjs/drizzle` chính thức, đúng như chương Drizzle chính thức của NestJS.
- Test runner: Vitest ở mọi nơi — không dùng Jest.

## Các đơn giản hoá đã biết

- Schema cơ sở dữ liệu là DÙNG CHUNG, không nhân đôi: schema canonical
  nằm ở `packages/db-schema` (chia theo bounded context, xem mục
  Quy ước) và được cả API lẫn worker import — worker không còn giữ
  bản sao schema rút gọn của riêng mình.
- Script `dev` của API là `tsc --watch` + `node --watch` thay vì Nest
  CLI, để bản build giống hệt CI (`tsc`).

## Quy ước (chính thức)

- **I18n là bắt buộc và tập trung**: không có chuỗi hiển thị
  bị hardcode. Backend/worker dùng **@nestjs/i18n** chính thức (ghim chính xác
  `0.0.1`) với các catalog JSON ở `src/i18n/<locale>/` — locale mặc định
  là **tiếng Việt**, tiếng Anh đi kèm; lỗi mang `code` tiếng Anh ổn định
  và văn bản hiển thị của chúng được tra cứu theo code. Frontend dùng i18next +
  react-i18next với tài nguyên tập trung (`apps/web/src/i18n.ts`).
- **Validation chỉ dùng Zod**: các schema cơ sở nằm ở
  `packages/contracts` và là nguồn sự thật duy nhất cho API
  (Standard Schema pipe) và các form React; các trường chỉ dành cho server mở
  rộng từ schema cơ sở. class-validator/class-transformer đã bị loại bỏ
  hoàn toàn khỏi repo.
- **Ngôn ngữ của code và tài liệu**: code bằng tiếng Anh (định danh,
  khoá log, mã lỗi và các chuỗi kỹ thuật khác); **toàn bộ comment trong code
  bằng tiếng Việt theo phong cách TSDoc**
  (`/** */` kèm `@param`/`@returns`/`@throws` khi phù hợp) cho mọi
  API công khai và cho logic nghiệp vụ không hiển nhiên; **mọi tài liệu bằng tiếng Việt**
  — README, các tài liệu còn giữ trong repo, AGENTS.md và cả tài liệu API —
  không có ngoại lệ tiếng Anh cho bất kỳ tài liệu nào.
- **Schema cơ sở dữ liệu chia theo bounded context**: schema nằm ở
  package dùng chung `packages/db-schema` — mỗi module sở hữu các bảng
  Drizzle của mình tại `packages/db-schema/src/modules/<module>/schema.ts`,
  các bảng hạ tầng của platform nằm ở
  `packages/db-schema/src/infrastructure.schema.ts`, và index của package
  là barrel duy nhất mà cả API lẫn worker import (file
  `apps/api/src/db/schema.ts` của API chỉ re-export barrel đó cho
  `drizzle.config.ts` và Drizzle module). Tên bảng/cột không bao giờ đổi
  khi một file schema di chuyển.
- **Đặt tên & vệ sinh repo**: mọi thứ được đặt tên theo
  nghiệp vụ / bounded context — **không có nhãn giai đoạn** trong code, comment, tên ca
  test hay tiêu đề commit; **không bao giờ commit sản phẩm đã biên dịch** (`dist/`,
  các file `.js`/`.d.ts` lạc cạnh mã nguồn). Đây là kỷ luật viết,
  được giữ bằng cách viết code đúng ngay từ đầu và bằng review —
  cố ý không có cơ chế cưỡng chế tự động cho việc này.
- **Nghiệm thu tính năng**: một tính năng chỉ được coi là xong khi
  luồng nghiệp vụ backend của nó được bao phủ bởi một flow test dịch từ
  oracle PHPUnit của Moodle.
- **Phiên bản luôn ưu tiên bản mới nhất**: luôn dùng bản phát hành mới
  nhất; chỉ ghim hoặc hạ phiên bản khi có trở ngại đã ghi thành văn bản ở trên
  (trở ngại hiện tại: TypeScript 6 cho các app NestJS).
