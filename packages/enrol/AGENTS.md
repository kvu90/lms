# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/enrol`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực; phần ngữ nghĩa chi tiết nằm ở comment đầu các file trong `src/`.
2. Issue đặc tả của việc đang làm trên GitHub — nguồn sự thật cho việc đó: bối cảnh, phạm vi, các quyết định liên quan (viết trọn vẹn ngay trong issue) và tiêu chí nghiệm thu đều nằm trong chính issue. Không viện dẫn sổ quyết định, hồ sơ hay tệp ngoài repo làm căn cứ. Tài liệu trong repo mâu thuẫn với issue thì DỪNG, báo main chat.
3. `AGENTS.md` ở thư mục gốc của repo — quy định chung cho AI toàn repo, gồm chuẩn văn bản tự chứa cho issue và PR.

## Chuẩn ngôn ngữ

Code (định danh, tên hàm/biến/lớp, chuỗi kỹ thuật) viết bằng tiếng Anh.
Toàn bộ comment trong code — gồm comment mô tả luồng nghiệp vụ — viết
bằng tiếng Việt. Mọi tài liệu trong repo (README, các file AGENTS,
tài liệu của package) và mọi văn bản trên GitHub (issue, PR, comment)
viết bằng tiếng Việt. Khi sửa code, comment tiếng Việt liên quan phải
được cập nhật khớp với code trong cùng lượt thay đổi. Nội dung đầy đủ
của chuẩn này nằm ở mục "Chuẩn ngôn ngữ" trong `AGENTS.md` ở thư mục
gốc của repo.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Package thuần tầng dữ liệu: không thêm phụ thuộc Nest/HTTP/framework ứng dụng vào package này dưới bất kỳ lý do nào — hạ tầng riêng của từng app (ghi outbox, ngữ cảnh tenant/platform) đi qua các cổng trong `src/types.ts` do app cấp vào.
- Nghiệp vụ thuộc về tiến trình (kiểm capability của người thao tác, tin nhắn chào mừng, consumer quét outbox, DTO/API) thuộc `apps/api` / `apps/worker` — không kéo vào đây.

## Điều cấm package-specific

- Cấm định nghĩa lại các kiểm đã có lõi dùng chung trong package (tách vai, đếm slot, toàn vẹn gán do ghi danh cấp) ở bất kỳ file nào khác — mọi chốt chặn phải gọi về đúng các lõi ở đây.
- Cấm đổi ngữ nghĩa đã chốt trong `README.md` của package (giữ/xoá dòng ghi danh theo dữ liệu liên quan, neo vật chất hoá vào trạng thái hiện tại của `cohort_members`, sự kiện tái tổng hợp hoàn thành phát trong cùng transaction với gỡ ghi danh) kể cả khi "thấy lạ": muốn đổi phải có quyết định mới viết trọn vẹn trong issue của việc đó và cập nhật README này cùng lượt.
- Cấm đưa sự kiện `course_completion_reaggregation_requested` vào bảng định tuyến relay của worker: phía API tiêu thụ nó qua mốc `seq` riêng của module hoàn thành.
