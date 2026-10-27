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
- Cấm gộp hai dòng TypeScript (Nest/React) thành một khi chưa có quyết định
  thay thế quyết định tách hai dòng hiện hành.

## Kiểm chứng bắt buộc

- Đổi tsconfig ở đây = đổi điều kiện biên dịch của MỌI package: trước khi push
  phải chạy typecheck của ít nhất một app mỗi dòng (`@lms/api` cho dòng Nest,
  `@lms/web` cho dòng React) và ghi kết quả vào bàn giao.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT.

## Kỷ luật test theo nghiệp vụ

- Package không có test nghiệp vụ (và không được bịa test cho có): kiểm chứng của
  package này là typecheck của các app tiêu thụ, ghi ở mục trên.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.

## Chuẩn comment TSDoc (sổ quyết định mục F — chốt 13:14 ngày 26/10/2026)

Chuẩn comment tiếng Việt theo TSDoc của sổ mục F **không có đối tượng áp dụng
trực tiếp trong package này**: `packages/config` chỉ chứa các file JSON cấu
hình TypeScript (`tsconfig/*.json`) — không có file mã nguồn `.ts`/`.tsx` nào,
và JSON không mang comment TSDoc. Ghi rõ để tránh hiểu nhầm khi rà soát đợt
phủ comment (issue #272): package này không thuộc diện phủ comment.

Nếu sau này có bất kỳ file `.ts` nào xuất hiện trong package (đồng nghĩa phá
điều cấm "không thêm code runtime" ở trên — phải có quyết định riêng trước),
thì chuẩn mục F áp **toàn bộ** cho file đó: TSDoc tiếng Việt ở đầu file mô tả
vai trò + flow tổng thể, TSDoc cho mọi hàm/class trọng yếu (mục đích,
`@param`/`@returns`, bước flow, bất biến, side-effect), comment nội tuyến cho
logic phức tạp; đội đánh giá độc lập soi như tiêu chí đạt.

## Bản đồ của package

- `tsconfig/base.json` — nền dùng chung cho mọi package (target ES2023,
  `strict: true` và các kỷ luật kiểu nền).
- `tsconfig/nest.json` — kế thừa `base.json`, dòng backend (module CommonJS,
  moduleResolution Node10): `apps/api`, `apps/worker`, `packages/db-schema`
  dùng qua `extends: "@lms/config/tsconfig/nest.json"`.
- `tsconfig/react.json` — kế thừa `base.json`, dòng frontend (module ESNext,
  moduleResolution bundler): `apps/web`, `packages/editor`, `packages/ui`
  dùng qua `extends: "@lms/config/tsconfig/react.json"`.
- `packages/contracts` dùng thẳng `base.json`. Hai dòng Nest/React tách nhau
  theo quyết định tách hai dòng (xem điều cấm ở trên: không gộp hai dòng
  khi chưa có quyết định thay thế).
- Luồng tác động: đổi một dòng ở đây → điều kiện biên dịch của **mọi** package
  tiêu thụ thay đổi → bắt buộc kiểm chứng typecheck ở cả hai dòng như mục
  "Kiểm chứng bắt buộc" đã ghi.
