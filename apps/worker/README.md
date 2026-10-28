# @lms/worker — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách nghiệp vụ gì

`apps/worker` là tiến trình nền (không HTTP): chạy mọi việc **không đồng bộ và theo
lịch** của sản phẩm — chuyển tiếp outbox sang realtime, phát thông báo qua kênh ngoài,
nhắc hạn hoạt động/ghi danh, digest cho phụ huynh, dọn dẹp theo retention, đối soát
ghi danh lớp, cấp huy hiệu, tính lại completion. Worker **không tự định nghĩa nghiệp
vụ**: nó thực thi các luật nghiệp vụ đã chốt ở `apps/api`/sổ quyết định, qua cùng một
hàm luật dùng chung khi luật đó áp cho cả hai phía.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Kênh ngoài tối thiểu hoá (P4 — luật CỨNG): email/push/Zalo **không mang điểm, không mang nội dung tin nhắn** — chỉ nhắc + link sâu. Digest phụ huynh là seam log-only cho tới khi có tài khoản Zalo OA/SMTP được cấp qua cấu hình hệ thống. | Sổ mục C (P1/P4), chốt 25/10/2026 15:02; issue #174/#159 |
| Luật thông báo áp giống hệt ở phía worker như phía API: loại bắt buộc P2 không tắt được; tắt tiếng theo khoá chừa điểm mới + hết hạn ghi danh (P3); chính sách admin cấp site tôn trọng trước tuỳ chọn cá nhân. Đường phát nền phải đi qua **hàm luật phân phối chung** — cấm có đường phát riêng vòng qua cổng chặn (bài học PR #94: đường read-receipt vòng qua cổng làm rò trạng thái). | Sổ mục C; issue #174 (NB-4/NB-6) |
| Retention thông báo: giữ 90/180 ngày theo loại (NB-6). Dọn dẹp file/ảnh phiếu theo mốc hết hạn giữ ảnh `paperscanretentionmonths` (mặc định 18 tháng) qua port ObjectStorage. | Issue #174; issue #112, chỉ đạo 25/10/2026 16:51 |
| Sau mỗi lần reset DB, consumer giữ watermark trong bộ nhớ phải **tự neo lại** khi seq DB thấp hơn watermark (không được im lặng no-op). Mọi consumer outbox mới phải theo nguyên lý tự neo này. | Issue #125; áp cho consumer thông báo + cohort |
| Đối soát ghi danh lớp (`class-enrol-reconcile`): roster lớp là nguồn sự thật, vật chất hoá xuống khoá có trần lệch 1 chu kỳ (15 phút); đối soát phải **tôn trọng đình chỉ thủ công theo khoá** — không tự ghi danh lại người đã bị đình chỉ tay. | Issue #184, research chốt 25/10/2026 15:59 |
| Nhắc hết hạn ghi danh và nhắc hạn hoạt động là việc của worker theo lịch; cửa sổ nhắc là cấu hình nghiệp vụ (site-config), không hard-code rải rác. | Issue #174; module enrol/assignments |
| Custom jobId BullMQ **không chứa dấu `:`** (dedupe key nối bằng `-`) — vi phạm làm job bị dedupe sai/im lặng mất. | Phát hiện ở TENANT-1, 25/10/2026 |

## Ranh giới — package này KHÔNG làm gì

- Không có HTTP, không phục vụ request người dùng, không tự mở bề mặt API mới.
- Không chứa bản sao riêng của luật nghiệp vụ: luật đã có ở API thì worker dùng
  chung/seam đã chốt, không viết bản song song thứ hai (hai bản luật lệch nhau là
  lỗi đã gặp — "bản chiếu tay" phải được ghi nhận và tiến tới dùng chung).
- Schema DB không định nghĩa ở worker: dùng chung `packages/db-schema`.

## Kỹ thuật tối thiểu

- NestJS 12, BullMQ + Redis, dùng chung DB với API. Build/start: `pnpm build &&
  pnpm start`. Sau reset DB production phải khởi động lại các tiến trình worker/web rồi mới probe
  realtime (watermark — xem quyết định tự neo ở trên).
