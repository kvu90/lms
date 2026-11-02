import type { CentreDb, CentreTx } from '@lms/db';

/**
 * Kiểu handle cơ sở dữ liệu của package `@lms/payments`.
 *
 * Package dùng chung không sở hữu kết nối: handle thật do tiến trình
 * chủ (apps/api hôm nay; apps/worker) khởi tạo qua factory của
 * `@lms/db` trên chính schema dùng chung và tiêm vào các service của
 * package qua provider `useFactory` của module chủ (handle định tuyến
 * `routedKysely` của khung định tuyến theo không gian).
 *
 * Kiểu này neo vào handle kho trung tâm của `@lms/db` thay vì một
 * khai báo quan hệ riêng của từng tiến trình chủ như trước, vì hai
 * lý do: (1) mọi bảng của package đều nằm trong kho trung tâm và
 * kiểu sinh codegen của kho đó là nguồn sự thật duy nhất cho hình
 * dạng dòng; (2) ở biên với facade của tiến trình chủ, một
 * transaction mở bằng handle của tiến trình đó phải truyền được cho
 * cả repository của package lẫn các service của chính tiến trình đó
 * trong cùng một transaction — handle Kysely của kho trung tâm là
 * dạng cho phép chiều truyền đó khớp kiểu không cần ép kiểu tại
 * điểm gọi (facade thanh toán phía apps/api mở transaction từ
 * handle này vì lý do này).
 */
export type Database = CentreDb;

/**
 * Handle của một transaction Kysely đang mở — chính là kiểu của tham
 * số `tx` mà `Database['transaction']` truyền cho callback. Đây là
 * định nghĩa duy nhất của kiểu này trong package: repository nhận
 * handle qua tham số `tx?: DbTx`, service truyền thẳng `tx` lấy từ
 * `repo.transaction(...)` — không ép kiểu tại điểm gọi.
 */
export type DbTx = CentreTx;
