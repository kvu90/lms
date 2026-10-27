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
