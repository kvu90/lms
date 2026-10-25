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
