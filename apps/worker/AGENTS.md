# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `apps/worker`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của `apps/worker`.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT;
   tài liệu mới hơn không tự thắng sổ; mâu thuẫn thì DỪNG và báo main chat.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR; việc phát sinh của cùng feat comment vào đúng issue đó.
- Worker chỉ thực thi luật đã chốt. Cần luật mới → đó là việc của API/sổ quyết định,
  không tự chế luật trong processor/scheduler.

## Điều cấm package-specific

- Cấm phát thông báo/realtime qua đường riêng không qua hàm luật phân phối chung
  (mọi hàm `distribute*`/đường phát vào room đều phải qua cổng chặn — liệt kê đủ
  mọi đường phát trước khi khẳng định "đã gác hết", bài học PR #94).
- Cấm đưa điểm số/nội dung tin nhắn vào payload kênh ngoài (email/push/Zalo) — P4
  là luật cứng.
- Cấm custom jobId BullMQ chứa dấu `:`.
- Cấm consumer giữ watermark chỉ trong bộ nhớ mà không có cơ chế tự neo khi DB
  reset (seq tối đa < watermark → neo lại).
- Cấm bản sao schema/logic riêng: schema lấy từ `packages/db-schema`; không định
  nghĩa lại bảng trong worker.
- Khi dựng cụm Postgres local để test: cụm phải gọn (giữ ở `~/workspace` hoặc
  `/dev/shm` có cap WAL), tắt postmaster + xoá pgdata ngay khi xong.

## Kiểm chứng bắt buộc

- **Typecheck trước khi push**: `pnpm --filter @lms/worker typecheck`; build lại
  dist của `packages/db-schema`/`packages/contracts` trước khi kết luận lỗi type.
- CI là cổng chính (suite worker có DB riêng `lms_test_worker` — không chạy đồng
  thời với suite api trên cùng DB); kết luận CI chỉ từ LOG THẬT.
- Local chỉ test targeted; suite nặng giữ khoá
  `flock ~/workspace/lms-nest-ops/heavy-suite.lock` suốt lượt chạy.

## Kỷ luật test theo nghiệp vụ

- Test worker phải thể hiện hệ quả nghiệp vụ quan sát được (thông báo bị chặn thì
  KHÔNG tới người nhận kể cả qua đường nền; đối soát không ghi danh lại người bị
  đình chỉ tay; digest không chứa điểm), không test chi tiết triển khai (thứ tự
  gọi nội bộ, tên job). Đổi luật nghiệp vụ thì test tương ứng phải fail.
- Job định kỳ phải có test về tính idempotent/chạy lại an toàn (chạy trùng không
  phát trùng, không cấp trùng quyền lợi).
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.

## Chuẩn comment TSDoc (sổ quyết định mục F — chốt 13:14 ngày 26/10/2026)

Mọi code TypeScript viết mới hoặc sửa trong `apps/worker` phải có comment
**tiếng Việt theo chuẩn TSDoc**, chi tiết nhất có thể — flow kỹ thuật phải nằm
ngay trong code, để lần sửa sau dựa vào nội dung code đang có chứ không dựa
vào trí nhớ của trợ lý:

- Đầu mỗi file: khối TSDoc mô tả vai trò của file + flow tổng thể (kích hoạt
  từ đâu — lịch, hàng đợi, sự kiện → các bước xử lý → dữ liệu ra /
  side-effect).
- Mỗi scheduler/processor/service/hàm trọng yếu: TSDoc `/** ... */` tiếng
  Việt gồm mục đích, `@param`/`@returns`, các bước flow, bất biến (đặc biệt
  tính **idempotent** và cơ chế tự neo watermark sau reset DB), mã lỗi/hành vi
  khi lỗi, side-effect (ghi DB, phát kênh ngoài qua hàm luật phân phối chung,
  ghi event-log/task-log).
- Logic phức tạp (điều kiện gửi theo chính sách P2/P3, cửa sổ nhắc, đối soát
  ghi danh): comment nội tuyến tiếng Việt nói bước flow và **lý do** — không
  lặp lại điều code đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example`/`@throws` khi cần); định danh
  và tên tag giữ tiếng Anh.
- Sửa code thì căn cứ vào comment flow đang có trong code; thấy comment lệch
  code thật thì sửa comment **trong cùng lượt** với sửa code.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  flow đạt chuẩn là chưa đạt. Code cũ chưa có comment được phủ theo đợt riêng
  của issue #272, không tự trộn việc phủ vào feat đang bay.

## Bản đồ flow của package

- **Điểm vào:** `src/main.ts` khởi động tiến trình nền (không HTTP);
  `src/worker.module.ts` lắp scheduler, processor và service. Cấu hình ở
  `src/config/env.ts`, bản dịch ở `src/i18n/`.
- **Luồng việc nền tổng thể:** lịch/kích hoạt → scheduler (`*.scheduler.ts`)
  quét điều kiện (outbox chờ chuyển tiếp, hạn hoạt động/ghi danh tới, mốc
  retention, chu kỳ đối soát) → đẩy job vào hàng đợi BullMQ (custom jobId
  **không chứa dấu `:`**) → processor trong `src/processors/` thực thi luật
  đã chốt ở API/sổ quyết định → ghi DB dùng chung với API (schema lấy từ
  `packages/db-schema`, ngữ cảnh tenant qua `src/db/` — `tenant-pool`,
  `tenant-als`, `relations`, `default-tenant`) → phát ra ngoài qua
  `notification-delivery.service.ts` và hàm luật phân phối chung (kênh ngoài
  tối thiểu hoá theo P4) → ghi vết bằng `event-log-writer.service.ts` /
  `task-log.service.ts`. Consumer outbox giữ watermark và **tự neo lại** khi
  seq của DB thấp hơn watermark sau reset.
- **Scheduler hiện có:** `outbox-relay` (chuyển tiếp outbox sang realtime),
  `activity-due-reminder` (nhắc hạn hoạt động), `enrol-expiry` (nhắc/hết hạn
  ghi danh), `guardian-digest` (digest phụ huynh), `notification-retention`
  (dọn thông báo theo retention), `class-enrol-reconcile` (đối soát ghi danh
  lớp theo roster).
- **Processor hiện có:** `notification-dispatch`, `activity-due-reminder`,
  `calendar-reminder`, `calendar-import`, `badge-award`,
  `completion-recalculate`, `enrol-expiry`, `class-enrol-reconcile`,
  `file-cleanup`, `guardian-digest`, `notification-retention`,
  `platform-services`.
