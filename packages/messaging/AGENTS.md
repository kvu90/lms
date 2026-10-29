# AGENTS.md — Yêu cầu dành cho AI khi làm việc trong `packages/messaging`

## Nguồn sự thật (đọc trước khi sửa)

1. `README.md` của package này — quyết định nghiệp vụ còn hiệu lực; ngữ nghĩa chi tiết nằm ở comment đầu từng file nguồn.
2. Issue đặc tả của việc đang làm trên GitHub — nguồn sự thật cho việc đó: bối cảnh, phạm vi, các quyết định liên quan (viết trọn vẹn ngay trong issue) và tiêu chí nghiệm thu đều nằm trong chính issue. Không viện dẫn sổ quyết định, hồ sơ hay tệp ngoài repo làm căn cứ. Tài liệu trong repo mâu thuẫn với issue thì DỪNG, báo main chat.
3. `AGENTS.md` ở thư mục gốc của repo — quy định chung cho AI toàn repo, gồm chuẩn văn bản tự chứa cho issue và PR.

## Chuẩn ngôn ngữ

Code (định danh, tên hàm/biến/lớp, chuỗi kỹ thuật) viết bằng tiếng Anh.
Toàn bộ comment trong code — gồm comment mô tả luồng nghiệp vụ — viết bằng tiếng Việt. Mọi tài liệu trong repo (README, các file AGENTS, tài liệu của package) và mọi văn bản trên GitHub (issue, PR, comment) viết bằng tiếng Việt. Khi sửa code, comment tiếng Việt liên quan phải được cập nhật khớp với code trong cùng lượt thay đổi. Nội dung đầy đủ của chuẩn này nằm ở mục "Chuẩn ngôn ngữ" trong `AGENTS.md` ở thư mục gốc của repo.

## Ranh giới phạm vi

- 1 issue = 1 feat = 1 PR. Package thuần TypeScript: không thêm phụ thuộc Nest, Socket.IO hay client Redis vào package này — việc phát đi qua cổng `RealtimeEmitter`, việc đọc đi qua kết nối Drizzle do app gọi truyền vào.
- Schema bảng lấy từ `@lms/db`, hợp đồng sự kiện lấy từ `@lms/contracts` — cấm sao chép định nghĩa bảng hay tên sự kiện vào package.

## Điều cấm package-specific

- Cấm phát realtime vòng qua tầng phân phối (`distribution-service.ts`): mọi lần phát vào room của một conversation đều phải qua cổng chặn cặp 1–1 fail-closed và rà soát membership tại thời điểm phân phối đã cài ở đó.
- Cấm nới kỷ luật fail-closed của cổng chặn (nuốt lỗi tra danh sách chặn thành danh sách rỗng) — không xác minh được quan hệ chặn thì nén toàn bộ lượt phân phối.
- Cấm dựng bản cài đặt truy vấn đọc thứ hai cho cùng một luật (đếm chưa đọc, lọc tin đã xoá, dựng trích dẫn): bề mặt đọc ở `distribution-store.ts` là bản cài đặt duy nhất cho cả đường REST phía API lẫn đường phân phối phía worker.
