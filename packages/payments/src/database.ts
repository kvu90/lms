import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AnyRelations } from 'drizzle-orm';

/**
 * Kiểu handle cơ sở dữ liệu của package `@lms/payments`.
 *
 * Package dùng chung không sở hữu kết nối: handle thật do tiến trình
 * chủ (apps/api hôm nay; apps/worker ở issue con tiếp theo của #522)
 * khởi tạo qua `DrizzleModule` của `@nestjs/drizzle` trên chính
 * schema dùng chung `@lms/db` và tiêm vào các service của package
 * qua `@InjectDrizzle()`.
 *
 * Kiểu này neo vào cấu hình quan hệ MỞ (`AnyRelations`) thay vì một
 * khai báo relations cụ thể, vì hai lý do: (1) relations là khai báo
 * riêng của từng tiến trình chủ (apps/api và apps/worker mỗi phía
 * giữ một bản khai trên cùng schema `@lms/db`), package không sở
 * hữu bản nào và tầng dữ liệu của package chỉ dùng query builder
 * lõi (select/insert/update/execute/transaction) — không dùng lớp
 * relational query (`db.query.*`) — nên kiểu của từng truy vấn suy
 * từ chính định nghĩa bảng của `@lms/db` được truyền vào; (2) ở
 * biên với facade của tiến trình chủ, một transaction mở bằng
 * handle của tiến trình đó phải truyền được cho cả repository của
 * package lẫn các service của chính tiến trình đó trong cùng một
 * transaction — cấu hình mở là dạng cho phép chiều truyền đó khớp
 * kiểu không cần ép kiểu tại điểm gọi (facade thanh toán phía
 * apps/api mở transaction từ handle của API vì lý do này).
 */
export type Database = NodePgDatabase<AnyRelations>;

/**
 * Handle của một transaction Drizzle đang mở — chính là kiểu của
 * tham số `tx` mà `Database['transaction']` truyền cho callback.
 * Đây là định nghĩa duy nhất của kiểu này trong package: repository
 * nhận handle qua tham số `tx?: DbTx`, service truyền thẳng `tx`
 * lấy từ `dbHandle.transaction(...)` — không ép kiểu tại điểm gọi.
 */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];
