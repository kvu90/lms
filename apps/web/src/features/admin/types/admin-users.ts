/**
 * Kiểu dữ liệu của cụm quản trị người dùng thuộc feature admin.
 * Tách từ module dữ liệu phẳng `src/lib/admin-users-data.ts` khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): định danh và
 * thân dữ liệu nằm ở tầng types/, lời gọi API thuần ở tầng api/, tuỳ
 * chọn truy vấn và hook ở tầng queries/.
 */

/** Thân tạo người dùng mới (POST /users). */
export interface NewUserDraft {
  username: string;
  email: string;
  password: string;
}

/** Thân sửa người dùng (PATCH /users/:id — mật khẩu chỉ gửi khi có nhập, để trống nghĩa là không đổi). */
export interface UpdateUserDraft {
  email: string;
  firstName: string;
  lastName: string;
  password?: string;
}
