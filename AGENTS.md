# AGENTS.md — Quy định chung cho AI làm việc trong repo này

Tài liệu này chứa các quy định chung áp dụng cho mọi app/package trong
repo. Luật riêng của từng package nằm trong `AGENTS.md` của chính package
đó (`apps/api`, `apps/web`, `apps/worker` và các thư mục trong
`packages/`) và vẫn phải được đọc trước khi sửa package tương ứng.

## Nguồn sự thật

Mọi thông tin cần để hiểu và thi công một việc đều nằm trong repo này
hoặc trong issue đặc tả của chính việc đó trên GitHub:

1. `README.md` ở thư mục gốc — cấu trúc repo, cách chạy, quy ước chung và
   định nghĩa kiểm chứng.
2. `README.md` của package — quyết định nghiệp vụ còn hiệu lực của
   package đó.
3. `AGENTS.md` của package — luật làm việc riêng của package đó.
4. Tài liệu còn giữ trong thư mục `docs/` của repo — gồm các quyết định
   kiến trúc đã được ghi thành văn bản trong repo.
5. Issue đặc tả của việc đang làm — bối cảnh, phạm vi, quyết định liên
   quan (viết trọn vẹn trong issue) và tiêu chí nghiệm thu.

## Chuẩn ngôn ngữ

- **Code viết bằng tiếng Anh:** định danh, tên hàm/biến/lớp và các
  chuỗi kỹ thuật (log key, mã lỗi, khoá cấu hình, thông điệp do máy
  đọc) viết bằng tiếng Anh.
- **Comment trong code viết bằng tiếng Việt:** toàn bộ comment trong
  code — gồm comment mô tả luồng nghiệp vụ — viết bằng tiếng Việt.
- **Tài liệu và văn bản GitHub viết bằng tiếng Việt:** mọi tài liệu
  trong repo (README, các file AGENTS, tài liệu của package) và mọi
  văn bản trên GitHub (issue, PR, comment) viết bằng tiếng Việt, văn
  phong kỹ thuật trung tính.
- **Sửa code phải cập nhật comment khớp code:** khi sửa code, comment
  tiếng Việt liên quan phải được cập nhật khớp với code trong cùng
  lượt thay đổi; comment lệch code thật là lỗi phải sửa trong cùng
  lượt, không để tồn đọng.

## Chuẩn Issue và PR — văn bản tự chứa

1. **Issue là bản đặc tả tự chứa.** Mọi issue phải chứa đủ: bối cảnh và
   vấn đề, mục tiêu, phạm vi (làm / không làm), chi tiết việc cần làm,
   quyết định liên quan và mục `## Nghiệm thu` gồm các tiêu chí kiểm
   chứng được. Người đọc chỉ có repo này phải hiểu, thi công và kiểm
   chứng được toàn bộ việc chỉ từ nội dung issue. Tương tự, mọi PR
   phải sao chép từng tiêu chí trong mục Nghiệm thu của issue liên
   kết, ghi cách đáp ứng kèm bằng chứng cụ thể, và ghi rõ kiểm chứng
   đã chạy (lệnh, kết quả, trạng thái CI lấy từ log thật).
2. **Quyết định viết trọn vẹn tại nơi sử dụng.** Khi một issue hoặc PR
   dựa trên một quyết định đã có, nội dung đầy đủ của quyết định đó phải
   được viết lại ngay trong văn bản đang dùng nó, trình bày dưới dạng yêu
   cầu/sự kiện kỹ thuật.
3. **Cấm trích dẫn quyết định mơ hồ.** Không viết các câu dạng "theo
   quyết định đã chốt", "như đã thống nhất", "theo chỉ đạo trước đó"
   hoặc trích kèm mốc thời gian của một cuộc trao đổi/sổ ghi nằm ngoài
   repo thay cho nội dung quyết định.
4. **Cấm dẫn file ngoài repo làm căn cứ.** Không viện dẫn sổ quyết
   định, hồ sơ nghiên cứu, ghi chú hay bất kỳ tệp nào nằm ngoài repo
   này — kể cả khi tệp đó tồn tại trên máy của người viết — làm căn cứ
   cho đặc tả, phạm vi hay tiêu chí nghiệm thu. Tài liệu trong repo
   (README, AGENTS.md, tài liệu trong `docs/`) được dẫn theo đường dẫn
   trong repo như bình thường.
5. **Ngôn ngữ và văn phong.** Code, comment và tài liệu tuân theo
   mục "Chuẩn ngôn ngữ" của tài liệu này: code bằng tiếng Anh;
   comment trong code và mọi tài liệu bằng tiếng Việt. Mọi văn bản
   thuộc codebase — issue, PR, commit, comment, tài liệu — dùng văn
   phong kỹ thuật trung tính. Tuyệt đối không dùng danh xưng hay cách
   xưng hô nội bộ trong văn bản của codebase, và không ghi quyết định
   thuộc về cá nhân nào — quyết định luôn được trình bày là yêu cầu
   kỹ thuật.
6. **Mẫu là cơ chế thực thi chuẩn.** Issue mở qua một mẫu trong
   `.github/ISSUE_TEMPLATE/`; PR mở theo
   `.github/pull_request_template.md`. Issue trống (không theo mẫu) bị
   tắt có chủ đích trong `.github/ISSUE_TEMPLATE/config.yml` để mọi
   issue đều đi qua một mẫu có đủ các mục bắt buộc.

## Kỷ luật PR liên quan

- Một issue = một feat. Việc phát sinh thuộc cùng feat thì ghi vào đúng
  issue của feat đó (mở lại nếu đã đóng), không xé issue/PR mới.
- Việc lớn chia lát: mỗi lát một PR riêng; lát giữa ghi `Refs #<issue>`,
  lát cuối ghi `Closes #<issue>`.
- Thân PR mở đầu bằng dòng `**[ĐỘI MUSE — <vai trò>]**`, có mục "Bản
  đồ thay đổi theo phạm vi" và mục "Kỷ luật đã giữ".
- Đội thi công không tự merge PR; việc merge chờ đánh giá độc lập.
- CI của repo là job `verify` trong `.github/workflows/ci.yml`; kết luận
  về CI chỉ lấy từ log thật của job.
