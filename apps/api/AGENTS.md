# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `apps/api`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực của `apps/api`.
2. `~/workspace/lms-nest-ops/decisions.md` — sổ quyết định, nguồn sự thật DUY NHẤT về
   quyết định đang hiệu lực. Tài liệu audit/research/comment mới hơn **không tự thắng**
   sổ: thấy mâu thuẫn thì DỪNG, báo main chat quyết, không thi công theo tài liệu trái sổ.
3. Sổ owner `~/workspace/lms-nest-ops/board.md` — một đầu việc chỉ một đội giữ.

## Ranh giới phạm vi

- Chỉ sửa module thuộc phạm vi việc được giao. Việc phát sinh thuộc cùng feat thì ghi
  vào đúng issue của feat đó (mở lại nếu đã đóng), không xé issue/PR mới.
  **1 issue = 1 feat = 1 PR**; các chặng là commit đẩy vào chính PR đó.
- Nghiệp vụ phải gác ở server. Không "gác" bằng cách giấu ở client.

## Điều cấm package-specific

- Cấm capability có tiền tố (`moodle/`, `mod/`, `lms/`, `report/`) — dạng duy nhất
  `<area>:<name>`. Thêm capability phải đăng ký vào registry và cập nhật mọi spec đếm.
- Cấm schema route dùng `z.date()`/`z.coerce.date()` — chỉ `z.iso.datetime(...)`
  (Swagger `createDocument` lúc boot production sẽ crash; e2e không bắt được lớp này,
  đã có test hồi quy `openapi-document` — không được xoá/yếu hoá test đó).
- Cấm nới cổng công bố điểm: học sinh/phụ huynh chỉ thấy điểm ĐÃ CÔNG BỐ. Mọi đường
  đọc điểm mới phải qua cùng một cổng công bố.
- Cấm để API phía học viên trả trường nguồn sách (`book` attribution) của câu hỏi.
- Cấm literal múi giờ `Asia/Saigon` trong SQL — chỉ dùng IANA canonical
  `Asia/Ho_Chi_Minh` (CI không có alias, local có — lỗi "local xanh CI đỏ" kinh điển).
- Cấm tuỳ tiện regen baseline Drizzle: baseline chứa SQL RLS viết tay mà drizzle-kit
  không sinh lại được. Gộp baseline phải giữ RLS và kiểm chứng cây MERGE chứa đúng
  MỘT thư mục `*_baseline`.
- Cấm custom jobId BullMQ chứa dấu `:` — nối khoá dedupe bằng `-`.
- Cấm viết script probe chứa pattern `token=<biến>` hoặc khoá `"password":` viết
  thẳng trong thân script (bị biến tướng khi truyền qua công cụ ghi file).

## Kiểm chứng bắt buộc

- **Typecheck package trước khi push**: sửa file nào thì typecheck tối thiểu trọn
  package (`pnpm --filter @lms/api typecheck`) — tuyệt đối không đẩy code chưa qua
  typecheck để CI đổ ở bước rẻ nhất. Đụng package dùng chung thì build lại dist của
  package đó trước khi kết luận lỗi type (dist cũ = lỗi type giả kinh điển).
- CI trên PR là cổng kiểm chứng chính; kết luận về CI chỉ từ **LOG THẬT**
  (`~/workspace/lms-nest-ops/fetch-job-log.py <job_id> <prefix>`), không suy từ thời
  lượng bước hay thông báo của helper.
- Local chỉ chạy test targeted của đúng phần mình đụng. Chạy suite e2e/vitest nặng ở
  local phải giữ khoá `flock ~/workspace/lms-nest-ops/heavy-suite.lock` suốt lượt
  chạy; tối đa một vòng nặng tại một thời điểm trên máy này.
- Suite api và worker không chạy đồng thời trên cùng một DB; giữ cách ly DB như CI
  (`lms_test_api` / `lms_test_worker`).

## Kỷ luật test theo nghiệp vụ

- Test phải thể hiện **luồng nghiệp vụ thật** (GV/HS làm gì, hệ thống phải giữ quy tắc
  gì), không viết test chỉ để mô tả chi tiết triển khai (tên hàm nội bộ, cấu trúc
  trung gian). Đổi nghiệp vụ đã chốt thì test tương ứng **phải fail** — nếu đổi quyết
  định mà test vẫn xanh, test đó viết sai và phải sửa cùng lượt.
- Không yếu hoá assertion, không nới khẳng định để "cho qua" khi sửa spec đếm/cố định
  (registry capability, số bảng/uuidv7 trong baseline): đếm lại trên cây merge cuối
  và ghi con số thật.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.
