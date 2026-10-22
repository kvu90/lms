import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Course, Gradebook, GradeReport, MyAccessView } from '@lms/contracts';
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
   * Capability đã phân giải của người dùng tại context của khoá này, lấy từ
   * GET /users/me/capabilities — nguồn quyết định phân loại giảng dạy/học
   * viên và các nút thao tác theo ngữ cảnh khoá. Rỗng khi không tải được
   * ảnh chụp quyền (API vẫn là nơi thực thi quyền thật).
   */
  capabilities: string[];
  /** Báo cáo điểm toàn lớp (dữ liệu cho khối giảng dạy; null nếu không tải được). */
  report: GradeReport | null;
  /** Sổ điểm của chính người dùng trong khoá (null nếu không truy cập được). */
  gradebook: Gradebook | null;
}

/** Cấp context theo quy ước của hệ thống quyền (khớp CONTEXT_LEVELS phía API). */
const CONTEXT_LEVEL = { SYSTEM: 10, COURSECAT: 40, COURSE: 50 } as const;

/** Các capability mở quyền dùng ngân hàng câu hỏi ở ít nhất một context. */
const QUESTION_CAPABILITIES = [
  'moodle/question:useall',
  'moodle/question:add',
  'moodle/question:editall',
  'moodle/question:managecategory',
] as const;

/**
 * Ảnh chụp quyền hiệu lực của người đang đăng nhập.
 *
 * Nguồn sự thật duy nhất là GET /users/me/capabilities: endpoint tự phục vụ
 * trả cờ site admin, các gán vai trò theo context và capability mà
 * PermissionEvaluator đã phân giải tại context hệ thống, các context có gán
 * vai trò và tổ tiên của chúng. Giao diện KHÔNG còn suy quyền bằng cách gọi
 * thử các endpoint bị khoá quyền rồi đoán qua mã 200/403 nữa — cách dò cũ
 * vừa tốn request vừa dễ lệch khi endpoint đổi capability. Các endpoint dữ
 * liệu (báo cáo điểm, sổ điểm) vẫn được tải bình thường để hiển thị, nhưng
 * kết quả của chúng không còn quyết định việc phân loại quyền.
 */
export interface PermissionsState {
  /** false trong lúc đang nạp ảnh chụp quyền lần đầu. */
  ready: boolean;
  /** Toàn bộ ảnh chụp quyền từ API (null khi chưa tải được). */
  access: MyAccessView | null;
  /** Có moodle/user:viewdetails tại context hệ thống (hoặc là site admin). */
  canViewUsers: boolean;
  /** Có moodle/role:manage tại context hệ thống (hoặc là site admin). */
  canManageRoles: boolean;
  /** Có ít nhất một quyền quản trị cấp hệ thống — điều kiện hiện khối quản trị. */
  canAdminister: boolean;
  /** Có capability ngân hàng câu hỏi ở ít nhất một context — điều kiện hiện mục ngân hàng câu hỏi. */
  canUseQuestionBank: boolean;
  /** Mọi khoá học kèm quyền của người dùng trong từng khoá. */
  courses: CourseAccess[];
  /** Các khoá người dùng đang ghi danh VÀ thuộc đội giảng dạy (có grade:viewall tại context khoá). */
  teaching: CourseAccess[];
  /** Các khoá người dùng đang ghi danh còn hiệu lực với tư cách học viên. */
  learning: CourseAccess[];
}

const EMPTY: PermissionsState = {
  ready: false,
  access: null,
  canViewUsers: false,
  canManageRoles: false,
  canAdminister: false,
  canUseQuestionBank: false,
  courses: [],
  teaching: [],
  learning: [],
};

const PermissionsContext = createContext<PermissionsState | null>(null);

/** Tải một tài nguyên đọc: trả dữ liệu khi gọi được, null khi bị từ chối/lỗi. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/** Capability đã phân giải tại context hệ thống (luôn có trong ảnh chụp quyền). */
function systemCapabilities(access: MyAccessView): string[] {
  return access.contexts.find((c) => c.contextLevel === CONTEXT_LEVEL.SYSTEM)?.capabilities ?? [];
}

/**
 * Phân giải capability hiệu lực của người dùng tại context của MỘT khoá học
 * từ ảnh chụp quyền: ưu tiên gán vai trò ngay tại context khoá (sâu nhất),
 * sau đó tới gán tại context danh mục chứa khoá, cuối cùng là context hệ
 * thống — đúng thứ tự kế thừa mà PermissionEvaluator áp dụng khi kiểm quyền
 * tại context khoá. Nhiều gán cùng cấp thì hợp nhất capability.
 */
function courseCapabilities(access: MyAccessView, course: Course): string[] {
  const capsByContext = new Map(access.contexts.map((c) => [c.contextId, c.capabilities]));
  const levels = [
    { level: CONTEXT_LEVEL.COURSE, instanceId: course.id },
    { level: CONTEXT_LEVEL.COURSECAT, instanceId: course.category },
  ];
  for (const { level, instanceId } of levels) {
    const caps = new Set<string>();
    let matched = false;
    for (const assignment of access.assignments) {
      if (assignment.contextLevel === level && assignment.instanceId === instanceId) {
        matched = true;
        for (const cap of capsByContext.get(assignment.contextId) ?? []) caps.add(cap);
      }
    }
    if (matched) return [...caps];
  }
  return systemCapabilities(access);
}

/** Người dùng thuộc đội giảng dạy của khoá khi có grade:viewall tại context khoá (site admin luôn đúng). */
function isCourseStaff(access: MyAccessView | null, courseAccess: CourseAccess): boolean {
  if (!access) return false;
  return access.isSiteAdmin || courseAccess.capabilities.includes('moodle/grade:viewall');
}

/**
 * Nạp ảnh chụp quyền cho người đang đăng nhập từ GET /users/me/capabilities,
 * kèm danh sách khoá học và dữ liệu hiển thị theo từng khoá (ghi danh của
 * tôi, báo cáo điểm toàn lớp, sổ điểm của tôi). Phân loại quản trị/giảng
 * dạy/học viên suy ra hoàn toàn từ capability đã phân giải; các tải dữ liệu
 * thất bại độc lập và chỉ làm rỗng đúng phần dữ liệu đó.
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
      const [access, courseList] = await Promise.all([
        probe<MyAccessView>('/api/v1/users/me/capabilities'),
        probe<Course[]>('/api/v1/courses'),
      ]);
      const courses = await Promise.all(
        (courseList ?? []).map(async (course): Promise<CourseAccess> => {
          const [enrolment, report, gradebook] = await Promise.all([
            probe<MyEnrolment>(`/api/v1/courses/${course.id}/enrolments/me`),
            probe<GradeReport>(`/api/v1/courses/${course.id}/grades/report`),
            probe<Gradebook>(`/api/v1/courses/${course.id}/gradebook`),
          ]);
          return {
            course,
            enrolment,
            report,
            gradebook,
            capabilities: access ? courseCapabilities(access, course) : [],
          };
        }),
      );
      if (cancelled) return;
      const sysCaps = access ? systemCapabilities(access) : [];
      const canViewUsers = (access?.isSiteAdmin ?? false) || sysCaps.includes('moodle/user:viewdetails');
      const canManageRoles = (access?.isSiteAdmin ?? false) || sysCaps.includes('moodle/role:manage');
      const teaching = courses.filter((c) => c.enrolment?.enrolled && isCourseStaff(access, c));
      const learning = courses.filter(
        (c) => c.enrolment?.enrolled && c.enrolment.active && !isCourseStaff(access, c),
      );
      setState({
        ready: true,
        access,
        canViewUsers,
        canManageRoles,
        canAdminister: canViewUsers || canManageRoles,
        canUseQuestionBank:
          (access?.isSiteAdmin ?? false) ||
          (access?.contexts.some((c) =>
            c.capabilities.some((cap) => (QUESTION_CAPABILITIES as readonly string[]).includes(cap)),
          ) ?? false),
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
