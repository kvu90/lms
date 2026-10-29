import { describe, expect, it } from 'vitest';
import { RouteErrorBoundary } from '#components/route-error-boundary';
import i18n from '#config/i18n';
import * as classDetailRoute from '#features/classes/routes/class-detail';
import * as classEditRoute from '#features/classes/routes/class-edit';
import * as classJoinRoute from '#features/classes/routes/class-join';
import * as classNewRoute from '#features/classes/routes/class-new';
import * as classPublicRoute from '#features/classes/routes/class-public';
import * as classesRoute from '#features/classes/routes/classes';
import * as gradesRoute from '#features/grades/routes/grades';
import * as guardianRoute from '#features/guardians/routes/guardian';
import * as quizPaperRoute from '#features/quizzes/routes/quiz-paper';
import * as teacherCurriculumRoute from '#features/curriculum/routes/teacher-curriculum';

/**
 * Spec gác F-07/F-08 (rà soát #133) cho 10 page module đăng ký trực
 * tiếp làm route module trong shell — cụm lớp (classes / class-new /
 * class-join / class-detail / class-edit / class-public) và 4 trang
 * đơn (grades / guardian / quiz-paper / teacher-curriculum) — bằng
 * CHÍNH các page module thật, theo cùng khuôn với
 * `routes/platform-routes.spec.tsx` của lát #133-A: trước spec này,
 * 10 module trên chưa xuất `ErrorBoundary`/`meta()` và không spec nào
 * gọi `meta()` của module thật, nên một khoá tiêu đề gõ sai vẫn qua
 * được typecheck (các helper của `lib/route-meta.ts` nhận chuỗi tự
 * do) và chỉ lộ khi rà tay.
 *
 * Với từng page module, spec khẳng định hai điểm của nghiệm thu lát
 * hoàn tất F-07/F-08:
 *  1. Export `ErrorBoundary` là ĐÚNG component dùng chung
 *     `RouteErrorBoundary` (so sánh đồng nhất tham chiếu, không phải
 *     một component trông giống) — lỗi của trang được chứa trong
 *     vùng nội dung theo cơ chế đã gác ở `routes/ssr-frame.spec.tsx`.
 *  2. `meta()` trả tiêu đề "<Tên trang> · LMS" dựng từ ĐÚNG khoá
 *     tiêu đề mà chính trang dùng cho heading của nó: namespace
 *     `app` cho 9 trang (classesHeading cho classes và cho
 *     class-detail — heading của class-detail là tên lớp động, khoá
 *     này là heading dự phòng của chính trang khi chưa có dữ liệu
 *     lớp; classPublicTitle là khoá tiêu đề riêng bổ sung vào i18n
 *     cho class-public vì trang này chưa có khoá tiêu đề riêng —
 *     heading của nó là tên lớp động với nhãn học phí làm dự phòng),
 *     namespace `guardian` riêng cho trang guardian (khoá `title`).
 *     Khoá phải tồn tại thật trong resources: nếu khoá sai hoặc
 *     thiếu, `i18n.t` trả lại chính chuỗi khoá và ca đối chiếu
 *     khoá-suy-ra sẽ đỏ thay vì xanh giả.
 */
const CASES = [
  { name: 'classes', route: classesRoute, ns: 'app', key: 'classesHeading' },
  { name: 'class-new', route: classNewRoute, ns: 'app', key: 'classCreateTitle' },
  { name: 'class-join', route: classJoinRoute, ns: 'app', key: 'classJoinTitle' },
  { name: 'class-detail', route: classDetailRoute, ns: 'app', key: 'classesHeading' },
  { name: 'class-edit', route: classEditRoute, ns: 'app', key: 'classEditTitle' },
  { name: 'class-public', route: classPublicRoute, ns: 'app', key: 'classPublicTitle' },
  { name: 'grades', route: gradesRoute, ns: 'app', key: 'gradebook' },
  { name: 'guardian', route: guardianRoute, ns: 'guardian', key: 'title' },
  { name: 'quiz-paper', route: quizPaperRoute, ns: 'app', key: 'paperTitle' },
  { name: 'teacher-curriculum', route: teacherCurriculumRoute, ns: 'app', key: 'teacherProgrammeTitle' },
] as const;

describe('F-07/F-08 (#133): 10 page module trong shell — ErrorBoundary dùng chung + meta() theo trang', () => {
  for (const { name, route, ns, key } of CASES) {
    it(`page ${name} exports the shared RouteErrorBoundary as its ErrorBoundary`, () => {
      expect(route.ErrorBoundary).toBe(RouteErrorBoundary);
    });

    it(`page ${name} meta() returns the title built from its own ${ns} key ${key}`, () => {
      const expectedTitle = i18n.t(key, { ns });
      expect(expectedTitle).not.toBe(key);
      expect(route.meta()).toEqual([{ title: `${expectedTitle} · LMS` }]);
    });
  }
});
