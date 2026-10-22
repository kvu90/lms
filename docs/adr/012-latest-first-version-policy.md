# ADR-012: Chính sách phiên bản latest-first

## Trạng thái
Accepted (22/10/2026).

## Quyết định
- **Luôn lấy phiên bản mới nhất** của mọi dependency khi cài/cập nhật.
- Chỉ lùi hoặc ghim phiên bản khi có **block rõ ràng**, và block đó phải
  được ghi vào ADR liên quan (lý do, điều kiện gỡ, ngày kiểm chứng).
- Các pin/block hiện hành:
  - TypeScript **6.0.3** cho riêng các app NestJS (api, worker) — block:
    `nest build`/toolchain Nest chưa hỗ trợ TypeScript 7; phần còn lại
    của monorepo dùng TypeScript 7.x. Chi tiết: ADR-003.
  - `@nestjs/i18n` ghim **exact 0.0.1** (pre-1.0) — chi tiết: ADR-008.
  - Drizzle theo line `rc` của chương chính thức @nestjs/drizzle —
    chi tiết: ADR-002.
- Block hiện hành duy nhất về mặt *lùi phiên bản so với latest* là
  TypeScript 6 cho các app NestJS (trỏ tới ADR-003); các mục còn lại là
  ghim theo line phát hành mà tài liệu chính thức chỉ định.
- Khi công cụ gây block ra bản mới, phải kiểm chứng lại block và gỡ pin
  nếu block đã hết; việc kiểm chứng ghi vào ADR tương ứng.
