# ADR-011: Nghiệm thu tính năng bằng business flow test đối chiếu oracle Moodle

## Trạng thái
Accepted (22/10/2026).

## Quyết định
- Một tính năng CHỈ được coi là hoàn thành khi **flow nghiệp vụ của nó ở
  backend được test ở mức luồng** (qua API/use-case, khẳng định kết quả
  nghiệp vụ đầu-cuối bằng Vitest + Supertest). Code chạy được hoặc unit
  test xanh là chưa đủ.
- **Oracle hành vi**: chính bộ test PHPUnit của Moodle 5.3 trong cây mã
  nguồn Moodle — dịch kịch bản và assertion của chúng thành flow test của
  hệ mới, thay vì suy diễn hành vi chỉ từ implementation. Case nào của
  Moodle gắn với chi tiết cài đặt PHP (không phải hành vi nghiệp vụ) thì
  bỏ qua và ghi lý do.
- Mọi ánh xạ nguồn (file test/case của Moodle → test của hệ mới, gồm cả
  các path 404 đã gặp và file thay thế đã dùng) phải ghi vào
  `docs/business-traceability.md`.
- Runner duy nhất toàn repo: Vitest (unit + e2e backend, Testing Library
  cho React) — xem ADR-005.

## Hệ quả
- Thiếu flow test = tính năng chưa xong, chặn merge theo quy ước này.
- Traceability là tài liệu sống bắt buộc cập nhật cùng mỗi tính năng.
