# @lms/enrol — README nghiệp vụ

> File này ghi các **quyết định nghiệp vụ quan trọng và còn đang hiệu lực** của package.
> Nguồn sự thật về quyết định của package là chính file này, `AGENTS.md` của package và `AGENTS.md` ở thư mục gốc; quyết định liên quan tới một việc cụ thể được viết trọn vẹn trong issue đặc tả của việc đó trên GitHub.

## Package phụ trách nghiệp vụ gì

`@lms/enrol` là **bề mặt vật chất hoá cohort dùng chung** của hệ thống: nó biến quan hệ thành viên cohort thành ghi danh cấp khoá (thêm thành viên → ghi danh vào mọi khoá có instance cohort tương ứng; rời cohort → rút hoặc đình chỉ ghi danh theo chế độ rời của instance), cùng các lõi tầng dữ liệu mà đường vật chất hoá đó đi qua — gán/gỡ vai tại context, kiểm tra tách vai giáo viên/học viên, giới hạn slot của gói, đảm bảo membership tenant, và truy vấn dữ liệu liên quan quyết định giữ/xoá dòng ghi danh khi gỡ.

Trước đây toàn bộ logic này sống trong `apps/api`, và đường đồng bộ cohort phụ thuộc hai cơ chế chỉ tồn tại trong tiến trình API: các probe dữ liệu liên quan và hook sau-gỡ-ghi-danh mà module nghiệp vụ đăng ký vào lúc khởi tạo tiến trình. Hệ quả là không tiến trình nào khác vật chất hoá cohort được. Package này trích đúng các định nghĩa đó xuống tầng dữ liệu (trên schema dùng chung `@lms/db`) để API và worker cùng áp một định nghĩa duy nhất; phần thuộc về tiến trình (HTTP, capability của người thao tác, tin nhắn chào mừng, consumer quét outbox) ở lại phía app.

## Quyết định nghiệp vụ còn hiệu lực

| Quyết định | Nguồn |
|---|---|
| Ghi danh ≠ gán role ≠ xác thực: ghi danh cấp một role tại context khoá học qua lõi gán vai; trạng thái ghi danh 0 = đang hiệu lực, 1 = tạm đình chỉ, 2 = đã rút. Người bị đình chỉ không truy cập được khoá dù gán vai vẫn còn. | `cohort-materialization.ts` |
| Tách vai theo ngữ cảnh: trong một khoá, tài khoản hoặc là giáo viên hoặc là học viên, không bao giờ cả hai; dạy ở khoá này và học ở khoá khác là hợp lệ. Hai kiểm nền (a) cấp quyền giảng dạy bao phủ khoá (loại trừ gán do ghi danh cấp và cấp ở context hệ thống) và (b) ghi danh học viên đang hoạt động là định nghĩa duy nhất — mọi chốt chặn (funnel ghi danh, thêm thành viên cohort, khôi phục backup, chiều ngược ở đường gán vai) gọi về lõi tách vai của package này. | `role-separation.ts` |
| Điểm chặn slot: gói trung tâm đếm theo tài khoản giảng dạy của trung tâm, gói giáo viên đếm theo khoá học giáo viên làm chủ; hạn mức là cấu hình hệ thống, có mức nền và thời gian ân hạn sau khi gói hết hạn. Hành động làm tăng slot khi đã chạm hạn mức bị chặn, không thay đổi thực thể đang có nào. | `plan-limits.ts` |
| Gỡ ghi danh giữ dữ liệu đóng góp: người dùng còn dữ liệu liên quan trong khoá (dòng hoàn thành module hoặc dòng điểm — truy vấn tồn tại thuần dữ liệu ở tầng dữ liệu, thay cho cơ chế probe đăng ký lúc khởi tạo tiến trình trước đây) thì dòng ghi danh được giữ dạng đã rút (status 2); không còn dữ liệu thì xoá cứng. Chỉ gỡ đúng dòng gán vai do chính instance ghi danh đó cấp. | `related-data.ts`, `cohort-materialization.ts` |
| Tái tổng hợp hoàn thành sau gỡ ghi danh đi qua outbox: sự kiện `course_completion_reaggregation_requested` (payload gồm định danh người dùng và định danh khoá) được phát trong CÙNG transaction với thao tác gỡ ghi danh, phía API tiêu thụ qua consumer có mốc `seq` riêng của module hoàn thành — sự kiện này KHÔNG nằm trong bảng định tuyến relay của worker. Cơ chế hook đồng bộ trong tiến trình trước đây đã bỏ. | `cohort-materialization.ts` |
| Vật chất hoá neo vào trạng thái hiện tại của `cohort_members`: sự kiện thành viên phát lại muộn không ghi danh cho người đã rời cohort và không đình chỉ người đã vào lại. Thành viên vi phạm chốt tách vai khi được thêm vào cohort bị bỏ qua riêng lẻ, không làm hỏng cả vòng lặp đồng bộ. | `cohort-materialization.ts` |
| Đình chỉ do đồng bộ cohort xoá vết người thao tác (`modifierId` về null) để phân biệt với đình chỉ thủ công theo khoá, và phát sự kiện đình chỉ với lý do `cohort_removed`. | `cohort-materialization.ts` |
| Mọi thay đổi gán vai đều đánh dấu dirty cây context liên quan (bump version theo path) để cache đánh giá quyền của phía host không dùng kết quả cũ; gán do ghi danh cấp chỉ được gỡ qua đường nội bộ của enrol với cờ cho phép tường minh. | `role-assignment.ts`, `contexts.ts` |
| Các phép đọc chính sách xuyên tenant (đếm slot, kiểm tách vai) chạy trong ngữ cảnh platform do host cấp qua cổng — package không giữ bản sao hạ tầng tenant của riêng app nào, và cổng outbox cũng do host cấp (mỗi app ghi outbox bằng dịch vụ của chính app đó). Lỗi nghiệp vụ của package mang mã kỹ thuật ổn định; host dịch về bề mặt lỗi của mình (API dịch thành exception HTTP cùng mã và thông điệp như trước khi trích xuất). | `types.ts`, `errors.ts` |
