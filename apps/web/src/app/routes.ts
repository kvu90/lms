import { type RouteConfig, layout, route } from '@react-router/dev/routes';
import adminRoutes, { siteConfigRoutes } from '../features/admin/routes';
import adminCurriculumRoutes from '../features/admin-curriculum/routes';
import assignmentsRoutes from '../features/assignments/routes';
import authRoutes, { standaloneRoutes as authStandaloneRoutes } from '../features/auth/routes';
import badgesRoutes from '../features/badges/routes';
import calendarRoutes from '../features/calendar/routes';
import classesRoutes from '../features/classes/routes';
import contentBankRoutes from '../features/content-bank/routes';
import courseBuilderRoutes from '../features/course-builder/routes';
import coursesRoutes from '../features/courses/routes';
import curriculumRoutes from '../features/curriculum/routes';
import dashboardRoutes from '../features/dashboard/routes';
import examsRoutes from '../features/exams/routes';
import gradesRoutes from '../features/grades/routes';
import guardiansRoutes, { adminGuardianLinksRoutes } from '../features/guardians/routes';
import learningPlanRoutes from '../features/learning-plan/routes';
import matricesRoutes from '../features/matrices/routes';
import messagingRoutes from '../features/messaging/routes';
import notificationsRoutes from '../features/notifications/routes';
import platformRoutes from '../features/platform/routes';
import playerRoutes from '../features/player/routes';
import profileRoutes from '../features/profile/routes';
import progressReportRoutes from '../features/progress-report/routes';
import questionEditorRoutes from '../features/question-editor/routes';
import questionsRoutes from '../features/questions/routes';
import quizzesRoutes from '../features/quizzes/routes';
import settingsRoutes from '../features/settings/routes';

/**
 * Bản đồ route của app (React Router framework mode): file này chỉ
 * còn vai trò GỘP — mọi trang đều nằm dưới một layout không đường
 * dẫn (`shell.tsx`) tự chọn khung công khai hay khung đã đăng nhập
 * theo phiên, giữ đúng hành vi của router cũ; từng khu route do
 * feature sở hữu khai ở config riêng `features/<feature>/routes.ts`
 * (dùng `relative()`/`prefix()` của framework) và được trải vào
 * layout tại đây theo đúng thứ tự khai báo gốc. Mỗi trang là một
 * route module riêng thuộc về feature của nó để framework tự chia
 * chunk theo route. Hai trang uỷ quyền MCP của feature auth nằm
 * ngoài shell (khối `standaloneRoutes`).
 */
export default [
  layout('shell.tsx', [
    ...dashboardRoutes,
    route('health', 'health.tsx'),
    ...authRoutes,
    ...profileRoutes,
    ...settingsRoutes,
    ...adminRoutes,
    ...adminGuardianLinksRoutes,
    ...siteConfigRoutes,
    ...adminCurriculumRoutes,
    ...curriculumRoutes,
    ...coursesRoutes,
    ...classesRoutes,
    ...courseBuilderRoutes,
    ...playerRoutes,
    ...progressReportRoutes,
    ...gradesRoutes,
    ...quizzesRoutes,
    ...assignmentsRoutes,
    ...questionsRoutes,
    ...questionEditorRoutes,
    ...matricesRoutes,
    ...examsRoutes,
    ...messagingRoutes,
    ...notificationsRoutes,
    ...guardiansRoutes,
    ...calendarRoutes,
    ...badgesRoutes,
    ...learningPlanRoutes,
    ...platformRoutes,
    ...contentBankRoutes,
  ]),
  ...authStandaloneRoutes,
] satisfies RouteConfig;
