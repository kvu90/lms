import { defineRelations } from 'drizzle-orm';
import * as schema from './schema';

/**
 * Relations cho toàn bộ schema (theo chương Drizzle chính thức của NestJS):
 * `schema` là barrel tổng hợp các schema theo bounded context. Các bảng hiện
 * cố ý chưa khai quan hệ ở tầng relations; module nào cần thì bổ sung tại đây.
 */
export const relations = defineRelations(schema, () => ({}));
