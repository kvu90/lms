import { z } from 'zod';
import {
  createUserSchema,
  listUsersQuerySchema,
  setUserPreferenceSchema,
  updateUserSchema,
  type CreateUser,
  type SetUserPreference,
  type UpdateUser,
} from '@lms/contracts';

/**
 * Validation của Users dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { createUserSchema, setUserPreferenceSchema, updateUserSchema };
export type CreateUserDto = CreateUser;
export type UpdateUserDto = UpdateUser;
export type SetPreferenceDto = SetUserPreference;

/**
 * Schema phía server cho query danh sách người dùng — EXTEND từ schema nền ở
 * contracts: phân trang đến từ query string (chuỗi) nên ép kiểu bằng
 * `z.coerce` ở tầng server. Trần `pageSize` 100 lặp lại trần ở schema nền để
 * phía server cũng chặn tại chỗ giá trị vượt trần. Các tham số lọc trạng
 * thái và sắp xếp là enum chuỗi nên đi thẳng từ schema nền, không ép kiểu.
 */
export const listUsersQueryServerSchema = listUsersQuerySchema.extend({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export type ListUsersQueryDto = z.infer<typeof listUsersQueryServerSchema>;
