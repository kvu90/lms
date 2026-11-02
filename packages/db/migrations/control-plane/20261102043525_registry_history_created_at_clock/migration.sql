-- Đổi mặc định của cột thời gian ghi lịch sử sổ đăng ký: now() là mốc bắt đầu
-- transaction (đóng dấu trước khi thao tác ghi chiếm khoá dòng) nên thứ tự
-- created_at lệch với thứ tự ghi thật khi ghi đồng thời; clock_timestamp() là
-- mốc thực tại thời điểm câu INSERT thực thi, khớp thứ tự chiếm khoá mà chuỗi
-- ảnh before/after của lịch sử nối theo.
ALTER TABLE "space_registry_history" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
