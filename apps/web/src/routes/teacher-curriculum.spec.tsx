import { describe, expect, it } from 'vitest';
import { RouteErrorBoundary } from '../components/route-error-boundary';
import i18n from '../i18n';
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
 * của route module phải là đúng component trang, `ErrorBoundary`
 * phải là component dùng chung, `meta()` phải trả đúng tiêu đề của
 * trang — để lỗi nối route không thể quay lại trong im lặng.
 */
describe('Route /curriculum — route module nối đúng component trang', () => {
  it('export mặc định của route module là đúng component TeacherCurriculumPage', () => {
    expect(teacherCurriculumRoute.default).toBe(TeacherCurriculumPage);
  });

  it('ErrorBoundary của route module là RouteErrorBoundary dùng chung', () => {
    expect(teacherCurriculumRoute.ErrorBoundary).toBe(RouteErrorBoundary);
  });

  it('meta() của route module trả tiêu đề chương trình GDPT của trang', () => {
    const expectedTitle = i18n.t('teacherProgrammeTitle', { ns: 'app' });
    expect(expectedTitle).not.toBe('teacherProgrammeTitle');
    expect(teacherCurriculumRoute.meta()).toEqual([{ title: `${expectedTitle} · LMS` }]);
  });
});
