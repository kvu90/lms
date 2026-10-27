import { z } from 'zod';

/**
 * Schema cho mọi định danh thực thể của hệ: khoá chính UUIDv7 dạng chuỗi
 * (PostgreSQL 18 `uuidv7()`). Mọi id ra/vào API đều qua schema
 * này — id sai định dạng bị từ chối 400 ở biên, id đúng định dạng nhưng
 * không tồn tại trả 404 ở tầng nghiệp vụ.
 */
export const uuidIdSchema = z.uuid();
