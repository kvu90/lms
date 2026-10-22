import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Course, Gradebook, GradeReport } from '@lms/contracts';
import { apiJson } from './api';
import { useAuth } from './auth';

/** Ghi danh của chính người dùng trong một khoá học (GET /courses/:id/enrolments/me). */
export interface MyEnrolment {
  courseId: string;
  userId: string;
  enrolled: boolean;
  active: boolean;
}

/**
 * Quyền hiệu lực của người dùng trong MỘT khoá học cụ thể — quyền trong hệ
 * này là theo ngữ cảnh (context), nên trạng thái được giữ riêng theo từng
 * khoá: cùng một người có thể dạy khoá A nhưng chỉ là học viên ở khoá B.
 */
export interface CourseAccess {
  course: Course;
  /** Ghi danh của chính người dùng trong khoá (null nếu API không trả về). */
  enrolment: MyEnrolment | null;
  /**
   * Báo cáo điểm toàn lớp: chỉ tải được khi người dùng có capability
   * moodle/grade:viewall tại context của khoá — đây là dấu hiệu "đội ngũ
   * giảng dạy" trong khoá đó. null nghĩa là không có quyền này (API trả 403).
   */
  report: GradeReport | null;
  /** Sổ điểm của chính người dùng trong khoá (null nếu không truy cập được). */
  gradebook: Gradebook | null;
}

/**
 * Ảnh chụp quyền hiệu lực của người đang đăng nhập, suy ra hoàn toàn từ dữ
 * liệu API hiện có.
 *
 * Vì sao phải "dò" endpoint thay vì đọc một trường role: API hiện không có
 * endpoint tự phục vụ nào trả về role/capability của chính người gọi —
 * /users/me chỉ có hồ sơ, còn mọi endpoint /access/* đều bị khoá bằng
 * capability quản trị (moodle/role:manage, moodle/role:assign). Nguồn sự
 * thật khả thi duy nhất là hành vi của chính các endpoint đọc đã được API
 * khoá quyền: gọi được (200) tức là có quyền, bị 403 tức là không. Site
 * admin (danh sách siteadmins phía server, bỏ qua mọi capability check) tự
 * động qua mọi điểm dò — đúng semantics của PermissionEvaluator.
 */
export interface PermissionsState {
  /** false trong lúc đang dò quyền lần đầu. */
  ready: boolean;
  /** Gọi được GET /users (moodle/user:viewdetails tại context hệ thống). */
  canViewUsers: boolean;
  /** Gọi được GET /access/roles (moodle/role:manage). */
  canManageRoles: boolean;
  /** Có ít nhất một quyền quản trị cấp hệ thống — điều kiện hiện khối quản trị. */
  canAdminister: boolean;
  /** Gọi được GET /questions/categories — điều kiện hiện mục ngân hàng câu hỏi. */
  canUseQuestionBank: boolean;
  /** Mọi khoá học kèm quyền của người dùng trong từng khoá. */
  courses: CourseAccess[];
  /** Các khoá người dùng đang ghi danh VÀ thuộc đội giảng dạy (có grade:viewall). */
  teaching: CourseAccess[];
  /** Các khoá người dùng đang ghi danh còn hiệu lực với tư cách học viên. */
  learning: CourseAccess[];
}

const EMPTY: PermissionsState = {
  ready: false,
  canViewUsers: false,
  canManageRoles: false,
  canAdminister: false,
  canUseQuestionBank: false,
  courses: [],
  teaching: [],
  learning: [],
};

const PermissionsContext = createContext<PermissionsState | null>(null);

/** Dò một endpoint đọc: trả dữ liệu khi gọi được, null khi bị từ chối/lỗi. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Nạp ảnh chụp quyền cho người đang đăng nhập: ba điểm dò cấp hệ thống,
 * sau đó với mỗi khoá học là ba điểm dò theo ngữ cảnh khoá (ghi danh của
 * tôi, báo cáo điểm toàn lớp, sổ điểm của tôi). Mọi điểm dò chạy song song
 * và thất bại độc lập — một endpoint 403 chỉ tắt đúng khối tương ứng.
 */
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<PermissionsState>(EMPTY);

  useEffect(() => {
    if (!user) {
      setState({ ...EMPTY, ready: true });
      return;
    }
    let cancelled = false;
    setState(EMPTY);
    void (async () => {
      const [users, roles, questionCategories, courseList] = await Promise.all([
        probe('/api/v1/users?pageSize=1'),
        probe('/api/v1/access/roles'),
        probe('/api/v1/questions/categories'),
        probe<Course[]>('/api/v1/courses'),
      ]);
      const courses = await Promise.all(
        (courseList ?? []).map(async (course): Promise<CourseAccess> => {
          const [enrolment, report, gradebook] = await Promise.all([
            probe<MyEnrolment>(`/api/v1/courses/${course.id}/enrolments/me`),
            probe<GradeReport>(`/api/v1/courses/${course.id}/grades/report`),
            probe<Gradebook>(`/api/v1/courses/${course.id}/gradebook`),
          ]);
          return { course, enrolment, report, gradebook };
        }),
      );
      if (cancelled) return;
      const teaching = courses.filter((c) => c.enrolment?.enrolled && c.report !== null);
      const learning = courses.filter(
        (c) => c.enrolment?.enrolled && c.enrolment.active && c.report === null,
      );
      setState({
        ready: true,
        canViewUsers: users !== null,
        canManageRoles: roles !== null,
        canAdminister: users !== null || roles !== null,
        canUseQuestionBank: questionCategories !== null,
        courses,
        teaching,
        learning,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const value = useMemo(() => state, [state]);
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

/** Đọc ảnh chụp quyền hiện tại; phải dùng bên trong PermissionsProvider. */
export function usePermissions(): PermissionsState {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used inside PermissionsProvider');
  return ctx;
}
