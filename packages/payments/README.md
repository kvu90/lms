# @lms/payments — Bề mặt thanh toán dùng chung

Package dùng chung cho các luồng thanh toán phải chạy được ở nhiều
tiến trình (apps/api và apps/worker), theo cùng khuôn package dùng
chung của repo (tiền lệ `packages/grades` được cả API lẫn worker
dùng). Package được tạo ở issue #538 (issue con của #522) bằng cách
trích xuất bảo toàn hành vi từ module payments của apps/api.

## Package này chứa gì

- `SepayMatchingService` — luồng matching bất đồng bộ cho IPN
  SePay: quét sự kiện `payment_provider_events` đang chờ, áp luật
  khớp 3 điều kiện cộng phép đối chiếu đích phía server, kích hoạt
  quyền lợi TRƯỚC nhịp lật payment sang `succeeded`, phát outbox
  `payment_succeeded`, và uỷ thác sự kiện `debit` cho cổng xác nhận
  chi hoàn. Đặc tả hành vi đầy đủ nằm trong docblock đầu file
  `src/sepay-matching.service.ts` và được ghim bằng test đặc trưng
  hoá `src/sepay-matching.service.spec.ts`.
- `PaymentsRepository` — tầng truy cập dữ liệu thanh toán (tài
  khoản, payment, dòng hoàn, sự kiện provider, quyền lợi gói,
  coupon) trên schema dùng chung `@lms/db`. Chỉ thao tác dữ liệu,
  không chứa luật nghiệp vụ.
- `PlanEntitlementsService` — kích hoạt và đình chỉ quyền lợi gói
  (`tenant_plan`/`teacher_plan`) từ ảnh chụp gói trong
  `payments.data`; cửa sổ hiệu lực nối tiếp khi mua tiếp; idempotent
  theo payment.
- `OutboxWriterService` — bề mặt phát outbox của package: ghi dòng
  `outbox_events` đúng khuôn của `OutboxService` phía apps/api,
  nhưng tenant chỉ lấy từ tham số tường minh (không phụ thuộc ngữ
  cảnh ALS của tiến trình API — xem docblock trong file).
- Các cổng xuyên module ở `src/sepay-matching-ports.ts` — xem mục
  dưới đây.

## Các cổng xuyên module (quyết định của issue #538)

Ba hiệu ứng của luồng matching nằm ở các module nghiệp vụ khác và
không đưa thẳng vào package được (phễu ghi danh, phễu cohort, facade
thanh toán). Package chỉ định nghĩa cổng (port/interface) và gọi
qua cổng; cài đặt cổng thuộc về tiến trình chủ:

- `PaidEnrolActivationPort` — kích hoạt ghi danh có phí. Cài đặt
  phía apps/api: `EnrolService`.
- `PaidClassEnrolActivationPort` — kích hoạt ghi danh cấp lớp. Cài
  đặt phía apps/api: `ClassesService`.
- `PaymentSettlementPort` — đối chiếu đích phía server và xác nhận
  chi hoàn cho sự kiện `debit`. Cài đặt phía apps/api:
  `PaymentsService`.

Việc nối cài đặt phía apps/api nằm trong `PaymentsModule`
(`useExisting` trỏ vào chính các service hiện hành). Luật nghiệp vụ
của cả matching lẫn ba hiệu ứng chỉ tồn tại đúng một bản trong
repo: cấm chép logic matching hoặc logic của ba hiệu ứng sang bất
kỳ nơi thứ hai nào.

## Điều gì KHÔNG nằm ở package này

- Phía tiếp nhận IPN (controller, xác thực, ghi sự kiện provider)
  và facade thanh toán `PaymentsService`, điểm kích hoạt theo nhịp
  `SepayIpnConsumer` — ở nguyên phía apps/api.
- Điểm quét matching ở worker và việc gỡ consumer phía API thuộc
  issue con tiếp theo của #522 (chỉ thi công sau khi issue #538 và
  issue #527 đã merge); issue này chỉ trích xuất bề mặt dùng chung
  và nối phía API dùng bề mặt đó, hành vi quan sát được không đổi.
