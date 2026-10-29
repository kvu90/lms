# @lms/messaging — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách nghiệp vụ gì

`packages/messaging` là **nhà dùng chung của luật realtime cho tính năng nhắn tin**, hợp nhất về một package duy nhất (issue #521) để hai tiến trình không bao giờ lệch luật:

- `apps/api` — gateway Socket.IO (xác thực, gắn socket vào room lúc bắt tay, presence/typing) và repository đọc REST/sync;
- `apps/worker` — consumer phân phối realtime: nhận sự kiện outbox qua hàng đợi, đọc dữ kiện tại thời điểm phân phối và phát sự kiện vào room qua Redis emitter.

Ba phần trong package:

| Phần | Nội dung |
|---|---|
| `realtime-rooms.ts` | Luật đặt tên room: mọi room đều có đoạn namespace tenant (`t:<tenant>:conv:<id>`, `t:<tenant>:user:<id>`; tenant chưa rõ rơi về `platform`). |
| `message-wire.ts` | Ánh xạ dòng tin sang dạng wire (`toWireMessage`), luật vô hiệu nội dung tin đã thu hồi (`blankRecalledContent`) và luật dựng khối trích dẫn (`messageQuoteOf`, trần excerpt 120 code point, tin gốc đã xoá/thu hồi/xoá-phía-mình thành `unavailable` với người xem thường). |
| `distribution-store.ts` | Bề mặt ĐỌC dùng chung (hàm thuần nhận kết nối Drizzle của app gọi): đọc tin/conversation/thành viên, đếm chưa đọc theo mốc của chính người nhận, danh sách chặn hai chiều, gắn trích dẫn, cửa sổ tin. |
| `distribution-service.ts` | Luật PHÂN PHỐI: điều phối theo loại sự kiện outbox + các hàm `distribute*` phát `message.new` / `conversation.updated` / `message.read` / `message.deleted` / `conversation.invalidate` qua cổng phát `RealtimeEmitter`. |

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Phân phối realtime chạy ở **worker qua hàng đợi** (relay outbox duy nhất phát job, consumer phía worker xử lý), KHÔNG còn consumer quét outbox trong tiến trình API. `publishedAt` của outbox chỉ ghi nhận thời điểm relay đã phát sự kiện; tiến độ xử lý thuộc về consumer. | Issue #521 (issue con của #491) |
| Consumer phía worker **chống trùng theo `outboxId`**: mỗi sự kiện chỉ phân phối một lần dù job bị phát lại (dấu đã-xử-lý riêng của consumer, vì chống trùng theo `jobId` của BullMQ chỉ có hiệu lực trong cửa sổ lưu giữ của hàng đợi). Phân phối là at-least-once ở biên sự cố: tiến trình chết giữa lượt phân phối thì job được xử lý lại và client chống trùng theo id/seq của tin. | Issue #521 |
| **Membership chốt tại thời điểm phân phối**, đọc thẳng từ DB — không dùng ảnh chụp lúc gửi trong payload. Trước mỗi lần phát vào room của conversation, socket của người không còn là thành viên bị đẩy khỏi room (rà soát room). | Issue #33 (kỷ luật F1) |
| **Cổng chặn cặp 1–1 fail-closed ở mọi đường phát**: hội thoại 1–1 đang có quan hệ chặn ở bất kỳ chiều nào thì toàn bộ lượt phân phối bị nén (kể cả `conversation.updated` kèm xem trước tin cuối và biên đã-đọc ghi trước lúc chặn). Không tra được danh sách chặn (lỗi DB) cũng nén — không xác minh được thì không phát. Chỉ chặn PHÁT, không đẩy socket khỏi room (socket bị đẩy ra không tự nối lại khi bỏ chặn). | Issue #33, PR #94 |
| Xoá-phía-mình chỉ phát vào room riêng của chính người xoá; phía kia không nhận bất kỳ tín hiệu nào. Thu hồi và xoá cứng luôn kèm `conversation.invalidate` tới từng thành viên. Xem trước tin cuối sau xoá/thu hồi lấy tin mới nhất CÒN HIỂN THỊ được, nội dung đã qua vô hiệu hoá nếu là tin thu hồi. | Issue #33 |
| Sự kiện `message_sent` có **hai consumer phía worker** (phân phối realtime ở package này và notification-events của issue #520): định tuyến outbox là một-sự-kiện-nhiều-handler — một dòng outbox phát một job vào từng hàng đợi đích, và chỉ được đóng dấu đã-phát khi MỌI đích đều nhận thành công. | Issue #520, #521 |

## Ranh giới — package này KHÔNG làm gì

- Không giữ kết nối DB/Redis và không phụ thuộc Nest hay Socket.IO: bề mặt đọc nhận kết nối Drizzle của app gọi; việc phát đi qua cổng `RealtimeEmitter` do app cài đặt (worker: `@socket.io/redis-emitter` trên Redis; test: bản giả lập).
- Không lo presence/typing và không gắn socket vào room: đó là việc phía kết nối của gateway trong `apps/api`.
- Không ghi dữ kiện nghiệp vụ: package chỉ đọc DB và phát sự kiện; mọi ghi chép (tin nhắn, outbox, mốc đã đọc) thuộc về `apps/api`.
