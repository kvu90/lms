# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/config`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — phạm vi và quyết định còn hiệu lực của config.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT
   về quyết định; tài liệu mới hơn không tự thắng sổ.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Package chỉ chứa tsconfig dùng chung.

## Điều cấm package-specific

- Cấm thêm code runtime, hằng số, hay bất kỳ logic/nghiệp vụ nào vào package này.
- Cấm nới lỏng kỷ luật kiểu dùng chung (vd tắt `strict`, nới `noUncheckedIndexedAccess`
  nếu đang bật) để "cho qua" lỗi type ở một app — sửa lỗi ở app đó; đổi kỷ luật
  chung phải là quyết định riêng, áp có kiểm chứng trên toàn monorepo.
- Cấm gộp hai dòng TypeScript (Nest/React) thành một khi chưa có ADR thay thế
  ADR-003.

## Kiểm chứng bắt buộc

- Đổi tsconfig ở đây = đổi điều kiện biên dịch của MỌI package: trước khi push
  phải chạy typecheck của ít nhất một app mỗi dòng (`@lms/api` cho dòng Nest,
  `@lms/web` cho dòng React) và ghi kết quả vào bàn giao.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT.

## Kỷ luật test theo nghiệp vụ

- Package không có test nghiệp vụ (và không được bịa test cho có): kiểm chứng của
  package này là typecheck của các app tiêu thụ, ghi ở mục trên.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
