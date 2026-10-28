import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from './relations';

export type Database = NodePgDatabase<typeof relations>;

/**
 * Handle của một transaction Drizzle đang mở — chính là kiểu của tham
 * số `tx` mà `Database['transaction']` truyền cho callback. Đây là
 * định nghĩa DUY NHẤT của kiểu này trong toàn hệ: repository nhận
 * handle qua tham số `tx?: DbTx`, service truyền thẳng `tx` lấy từ
 * `dbHandle.transaction(...)` hoặc các hàm `TenantDbService.with*` —
 * không ép kiểu tại điểm gọi.
 */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];
