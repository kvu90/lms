# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/grades`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ (ngữ nghĩa tính điểm) còn
   hiệu lực; phần ngữ nghĩa chi tiết nằm ở comment đầu `grade-formula.ts`.
2. Issue đặc tả của việc đang làm trên GitHub — nguồn sự thật cho việc đó: bối cảnh,
   phạm vi, các quyết định liên quan (viết trọn vẹn ngay trong issue) và tiêu chí
   nghiệm thu đều nằm trong chính issue. Không viện dẫn sổ quyết định, hồ sơ hay tệp
   ngoài repo làm căn cứ. Tài liệu trong repo mâu thuẫn với issue thì DỪNG, báo
   main chat.
3. `AGENTS.md` ở thư mục gốc của repo — quy định chung cho AI toàn repo, gồm chuẩn
   văn bản tự chứa cho issue và PR.

## Chuẩn ngôn ngữ

Code (định danh, tên hàm/biến/lớp, chuỗi kỹ thuật) viết bằng tiếng Anh.
Toàn bộ comment trong code — gồm comment mô tả luồng nghiệp vụ — viết
bằng tiếng Việt. Mọi tài liệu trong repo (README, các file AGENTS, tài
liệu của package) và mọi văn bản trên GitHub (issue, PR, comment) viết
bằng tiếng Việt. Khi sửa code, comment tiếng Việt liên quan phải được
cập nhật khớp với code trong cùng lượt thay đổi. Nội dung đầy đủ của
chuẩn này nằm ở mục "Chuẩn ngôn ngữ" trong `AGENTS.md` ở thư mục gốc
của repo.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Engine thuần: không thêm phụ thuộc DB/Nest/HTTP vào
  package này dưới bất kỳ lý do nào.
- Nghiệp vụ điểm theo hoạt động (công thức điểm của từng bài kiểm tra/bài tập, công
  bố điểm của bài) thuộc `apps/api` — không kéo vào đây.

## Điều cấm package-specific

- Cấm dùng `eval`/`Function` để đánh giá công thức — chỉ parser an toàn hiện có.
- Cấm tự đổi ngữ nghĩa đã chốt (chia 0 → null, bỏ qua điểm trống trong hàm tổng
  hợp, round nửa ra xa số 0, if lười…) kể cả khi "thấy lạ": ngữ nghĩa là quyết
  định nghiệp vụ có oracle Moodle; muốn đổi phải có quyết định mới trong sổ +
  cập nhật parity corpus cùng lượt.
- Cấm làm cho hàm ngoài tập lõi "chạy được một cách gần đúng" — phải từ chối rõ
  ràng lúc phân tích cú pháp.
- Cấm hard-code công thức của một chế độ điểm cụ thể (TT 22…) vào engine.

## Kiểm chứng bắt buộc

- **Typecheck + test của package trước khi push**: `pnpm --filter @lms/grades
  typecheck` và `pnpm --filter @lms/grades test` (suite của package này nhẹ,
  chạy targeted là đủ; không cần khoá flock trừ khi chạy kèm suite nặng khác).
- Build lại `dist` trước khi typecheck apps/api trong cùng feat.
- CI là cổng chính; kết luận CI chỉ từ LOG THẬT.

## Kỷ luật test theo nghiệp vụ

- Mọi thay đổi ngữ nghĩa phải đi kèm ca trong **parity corpus** thể hiện kết quả
  đúng theo quyết định/oracle — test ở đây chính là đặc tả nghiệp vụ tính điểm:
  đổi quyết định tính điểm thì ca tương ứng phải fail trước khi sửa engine.
- Test kiểm KẾT QUẢ SỐ của các tình huống nghiệp vụ thật (điểm trống, chia 0, làm
  tròn biên 2.5/-2.5…), không test chi tiết cây phân tích cú pháp nội bộ.
- Mọi comment của đội trên GitHub bắt đầu bằng `**[ĐỘI MUSE — <vai trò>]**`.

## Chuẩn comment TSDoc

Mọi code TypeScript viết mới hoặc sửa trong `packages/grades` phải có comment
**tiếng Việt theo chuẩn TSDoc**, chi tiết nhất có thể — ngữ nghĩa tính điểm
phải nằm ngay trong code, để lần sửa sau dựa vào nội dung code đang có chứ
không dựa vào trí nhớ của trợ lý. Chuẩn ngôn ngữ chung của repo: code bằng
tiếng Anh (định danh, tên hàm/biến, chuỗi kỹ thuật); **comment — gồm cả
comment luồng nghiệp vụ — bằng tiếng Việt**; mọi tài liệu bằng tiếng Việt:

- Đầu mỗi file: khối TSDoc mô tả vai trò của file + luồng xử lý tổng thể
  (dữ liệu vào → các bước phân tích/tính toán → kết quả trả về).
- Mỗi hàm trọng yếu (phân tích công thức, tính điểm, làm tròn…): TSDoc
  `/** ... */` tiếng Việt gồm mục đích, `@param`/`@returns`, các bước xử lý,
  ngữ nghĩa biên đã chốt (chia 0 → null, bỏ qua điểm trống trong hàm tổng
  hợp, round nửa ra xa số 0, if lười…) và ca parity corpus tương ứng nếu có.
- Logic phức tạp/nhánh rẽ quan trọng: comment nội tuyến tiếng Việt nói bước
  xử lý và **lý do** — không lặp lại điều code đã hiển nhiên.
- Cú pháp/tag theo TSDoc (`@remarks`/`@example` khi cần); định danh và tên tag
  giữ tiếng Anh.
- Sửa code thì căn cứ vào comment đang có trong code; thấy comment lệch code
  thật — đặc biệt là lệch ngữ nghĩa tính điểm đã chốt — thì sửa comment
  **trong cùng lượt** với sửa code.
- Đội đánh giá độc lập soi chuẩn này như một tiêu chí đạt — code thiếu comment
  đạt chuẩn là chưa đạt. Comment tiếng Anh còn tồn đọng trong package được
  dịch theo đợt riêng của chương trình sửa chuẩn ngôn ngữ toàn repo, không tự
  trộn việc dịch vào feat đang bay.
