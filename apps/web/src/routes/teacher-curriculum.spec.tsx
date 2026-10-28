import { describe, expect, it } from 'vitest';
import { TeacherCurriculumPage } from '../pages/teacher-curriculum';
import * as teacherCurriculumRoute from './teacher-curriculum';

/**
 * Spec gác nối route cho trang `/curriculum` (issue #233, mở lại sau
 * kiểm chứng D-3): route module PHẢI cấp component render được qua
 * export mặc định. Trước bản sửa này, route trỏ thẳng vào file trang
 * `pages/teacher-curriculum.tsx` — file này chỉ xuất component dưới
 * tên riêng `TeacherCurriculumPage`, không có export mặc định — nên
 * trình duyệt thật render outlet trống hoàn toàn (tiêu đề vẫn hiện
 * nhờ `meta()`, khung shell vẫn hiện, vùng nội dung trống, không
 * thông báo lỗi), trong khi spec gắn component trực tiếp vẫn xanh
 * nên lỗi không lộ. Spec này ghim đúng mối nối đó: export mặc định
 * của route module phải là đúng component trang — để lỗi nối route
 * không thể quay lại trong im lặng. Hai mối nối còn lại của route
 * module (ErrorBoundary dùng chung và `meta()` theo trang) được ghim
 * trong bảng 10 module của `pages/shell-pages-routes.spec.tsx`, có
 * điểm teacher-curriculum với cùng các khẳng định.
 */
describe('Route /curriculum — route module nối đúng component trang', () => {
  it('export mặc định của route module là đúng component TeacherCurriculumPage', () => {
    expect(teacherCurriculumRoute.default).toBe(TeacherCurriculumPage);
  });
});
