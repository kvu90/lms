import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Course, MyAccessView } from '@lms/contracts';
import { apiJson } from './api';
import { useAuth } from './auth';
import { queryKeys } from './query-keys';

/**
 * Quyền hiệu lực của người dùng trong MỘT khoá học cụ thể — quyền trong hệ
 * này là theo ngữ cảnh (context), nên trạng thái được giữ riêng theo từng
 * khoá: cùng một người có thể dạy khoá A nhưng chỉ là học viên ở khoá B.
 */
export interface CourseAccess {
  course: Course;
  /**
   * Capability đã phân giải của người dùng tại context của khoá này, lấy từ
   * GET /users/me/capabilities — nguồn quyết định phân loại giảng dạy/học
   * viên và các nút thao tác theo ngữ cảnh khoá. Rỗng khi không tải được
   * ảnh chụp quyền (API vẫn là nơi thực thi quyền thật).
   */
  capabilities: string[];
}

/** Cấp context theo quy ước của hệ thống quyền (khớp CONTEXT_LEVELS phía API). */
const CONTEXT_LEVEL = { SYSTEM: 10, COURSECAT: 40, COURSE: 50 } as const;

/** Các capability mở quyền dùng ngân hàng câu hỏi ở ít nhất một context. */
const QUESTION_CAPABILITIES = [
  'question:useall',
  'question:add',
  'question:editall',
  'question:managecategory',
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
  /**
   * Lỗi của query capabilities khi tải ảnh chụp quyền thất bại (F-15, rà
   * soát #133): provider vẫn suy biến mềm (access = null, mọi cờ false)
   * nhưng phơi lỗi này ra để bề mặt/log phân biệt được "API lỗi" với
   * "người dùng không có quyền/không có dữ liệu". null khi chưa lỗi —
   * gồm cả trạng thái chưa đăng nhập (không phải lỗi).
   */
  capabilitiesError: Error | null;
  /** Có user:viewdetails tại context hệ thống (hoặc là site admin). */
  canViewUsers: boolean;
  /** Có role:manage tại context hệ thống (hoặc là site admin). */
  canManageRoles: boolean;
  /** Có ít nhất một quyền quản trị cấp hệ thống — điều kiện hiện khối quản trị. */
  canAdminister: boolean;
  /** Có capability ngân hàng câu hỏi ở ít nhất một context — điều kiện hiện mục ngân hàng câu hỏi. */
  canUseQuestionBank: boolean;
  /** Mọi khoá học kèm quyền của người dùng trong từng khoá. */
  courses: CourseAccess[];
  /** Các khoá người dùng thuộc về (định nghĩa #33 bên dưới) VÀ thuộc đội giảng dạy (có grade:viewall tại context khoá). */
  teaching: CourseAccess[];
  /** Các khoá người dùng thuộc về (định nghĩa #33 bên dưới) với tư cách học viên. */
  learning: CourseAccess[];
  /**
   * Dấu chân học tập (issue #176, quy tắc M+A): true khi người dùng đang
   * là học viên ở ít nhất một khoá (learning.length > 0) HOẶC có hiện vật
   * học tập của chính mình (cờ server hasLearnerArtifacts). Nhóm "Học
   * tập" ở sidebar và hai mục Huy hiệu/Kế hoạch ở bảng lệnh gác bằng cờ
   * này; chưa đăng nhập hoặc chưa có ảnh chụp thì false (nhóm vắng mặt
   * cho tới khi snapshot khẳng định, đúng mẫu các nhóm quản trị).
   */
  hasLearnerFootprint: boolean;
}

const PermissionsContext = createContext<PermissionsState | null>(null);

/** Tải một tài nguyên đọc: trả dữ liệu khi gọi được, null khi bị từ chối/lỗi. */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

/**
 * Capability đã phân giải tại context hệ thống (luôn có trong ảnh chụp quyền).
 * Export để loader SSR của dashboard (lát SL-1, `routes/home-index.tsx`)
 * phân loại khối quản trị bằng ĐÚNG cùng định nghĩa này thay vì chép lại.
 */
export function systemCapabilities(access: MyAccessView): string[] {
  return access.contexts.find((c) => c.contextLevel === CONTEXT_LEVEL.SYSTEM)?.capabilities ?? [];
}

/**
 * Phân giải capability hiệu lực của người dùng tại context của MỘT khoá học
 * từ ảnh chụp quyền: ưu tiên gán vai trò ngay tại context khoá (sâu nhất),
 * sau đó tới gán tại context danh mục chứa khoá, cuối cùng là context hệ
 * thống — đúng thứ tự kế thừa mà PermissionEvaluator áp dụng khi kiểm quyền
 * tại context khoá. Nhiều gán cùng cấp thì hợp nhất capability.
 * Export để loader SSR của dashboard (lát SL-1) prefetch dữ liệu điểm
 * cho đúng tập khoá dạy/học mà provider sẽ phân loại.
 */
export function courseCapabilities(access: MyAccessView, course: Course): string[] {
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
  return access.isSiteAdmin || courseAccess.capabilities.includes('grade:viewall');
}

/**
 * Người dùng có gán vai trò tại chính context của khoá này hay không —
 * đây là toàn bộ định nghĩa “thuộc khoá” đã chốt ở #33 (ghi danh đang
 * hiệu lực ∪ gán vai tại context khoá) sau khi đối chiếu phía API: nửa
 * “ghi danh” của hợp nhất LUÔN hiện diện trong ảnh chụp dưới dạng gán
 * vai, vì tầng ghi danh của API vật chất hoá mọi ghi danh thành một gán
 * vai tại context khoá — instance ghi danh luôn chốt một vai (mặc định
 * vai học viên), ghi danh thì cấp vai đó, rút ghi danh thì gỡ đúng vai
 * đó, đình chỉ thì giữ vai (khớp hành vi cũ: học viên bị đình chỉ vẫn ở
 * nhóm learning qua nhánh gán vai). Đây cũng là cùng định nghĩa mà
 * roster tin nhắn dùng phía API (listMembershipCourseIds chỉ tính gán
 * vai ở context có contextLevel = COURSE, instanceId = id của khoá).
 * Nhờ vậy phân loại không còn cần probe `enrolments/me` cho từng khoá
 * nữa (F-02, rà soát #133): ảnh chụp quyền đã mang sẵn mọi gán vai của
 * người dùng (MyAccessView.assignments). Giáo viên phụ trách khoá qua
 * gán vai (đúng thiết kế seed: editingteacher tại context khoá, không
 * qua ghi danh) nhờ đó thấy khoá ở nhóm giảng dạy thay vì rơi vào cả
 * hai danh sách đều rỗng.
 *
 * Export để loader SSR của dashboard (lát SL-1) dùng chung định nghĩa.
 */
export function hasCourseAssignment(access: MyAccessView | null, course: Course): boolean {
  if (!access) return false;
  return access.assignments.some(
    (a) => a.contextLevel === CONTEXT_LEVEL.COURSE && a.instanceId === course.id,
  );
}

/**
 * Nạp ảnh chụp quyền cho người đang đăng nhập bằng TanStack Query: ảnh
 * chụp quyền và danh sách khoá chạy song song ngay từ đầu — HAI request
 * này là TOÀN BỘ những gì provider tải khi nạp app (F-02, rà soát
 * #133; trước đây provider fan-out thêm dữ liệu điểm theo khoá). Dữ
 * liệu điểm theo khoá (report + gradebook, thuần hiển thị) KHÔNG còn
 * nằm trong provider: các bề mặt cần nó (dashboard, trang grades) tải
 * lười qua hook ở `lib/course-grade-data.ts` với đúng khoá
 * `courseAccess` dùng chung. Phân loại quản trị/
 * giảng dạy/học viên suy ra hoàn toàn từ capability và gán vai đã phân
 * giải trong ảnh chụp; các tải dữ liệu thất bại độc lập và chỉ làm
 * rỗng đúng phần dữ liệu đó. Kết quả được cache theo staleTime của
 * QueryClient nên các lần F5/điều hướng gần nhau dựng ngay từ cache
 * rồi làm mới nền.
 *
 * Vị trí kiểm soát: provider được mount tại root (root.tsx), bao phủ
 * toàn bộ cây route vô điều kiện — đây là điểm duy nhất dựng context
 * này trong app. Các query chỉ bật khi đã có người dùng đăng nhập; khi
 * chưa có, provider trả ảnh chụp rỗng ở trạng thái sẵn sàng (không
 * phải lỗi) để mọi trang, kể cả trang công khai có đọc quyền, luôn ở
 * trong provider và không bao giờ gặp lỗi thiếu provider khi vào
 * thẳng/F5. Khi đăng xuất/đổi người dùng, tầng phiên xoá toàn bộ
 * Query cache nên ảnh chụp của người trước không lọt sang người sau.
 */
export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const enabled = !!user;

  // Query capabilities KHÔNG nuốt lỗi vào null như probe thường lệ:
  // lỗi phải nổi lên query error state để provider phơi ra qua
  // `capabilitiesError` (F-15) — bề mặt vẫn suy biến mềm vì access
  // được đọc từ data (undefined khi lỗi → null).
  const capabilitiesQuery = useQuery({
    queryKey: queryKeys.capabilities,
    queryFn: () => apiJson<MyAccessView>('/api/v1/users/me/capabilities'),
    enabled,
    staleTime: 60_000,
  });
  const coursesQuery = useQuery({
    queryKey: queryKeys.courses,
    queryFn: () => probe<Course[]>('/api/v1/courses'),
    enabled,
  });
  const courseList = useMemo(() => coursesQuery.data ?? [], [coursesQuery.data]);
  const accessSnapshot = capabilitiesQuery.data ?? null;

  const value = useMemo<PermissionsState>(() => {
    if (!user) {
      return {
        ready: true,
        access: null,
        capabilitiesError: null,
        canViewUsers: false,
        canManageRoles: false,
        canAdminister: false,
        canUseQuestionBank: false,
        courses: [],
        teaching: [],
        learning: [],
        hasLearnerFootprint: false,
      };
    }
    const access = accessSnapshot;
    const courses: CourseAccess[] = courseList.map((course) => ({
      course,
      capabilities: access ? courseCapabilities(access, course) : [],
    }));
    const sysCaps = access ? systemCapabilities(access) : [];
    const canViewUsers = (access?.isSiteAdmin ?? false) || sysCaps.includes('user:viewdetails');
    const canManageRoles = (access?.isSiteAdmin ?? false) || sysCaps.includes('role:manage');
    const teaching = courses.filter(
      (c) => hasCourseAssignment(access, c.course) && isCourseStaff(access, c),
    );
    const learning = courses.filter(
      (c) => hasCourseAssignment(access, c.course) && !isCourseStaff(access, c),
    );
    return {
      ready: !capabilitiesQuery.isPending && !coursesQuery.isPending,
      access,
      capabilitiesError: capabilitiesQuery.error ?? null,
      canViewUsers,
      canManageRoles,
      // Cổng mở UI quản trị KHÔNG được tính user:viewdetails: đó
      // là capability nền mà API phân giải cho mọi người dùng đã xác
      // thực ở context hệ thống (để xem hồ sơ lẫn nhau), nên nếu tính
      // cả nó thì mọi học viên đều thấy khối quản trị rồi bị 403 ở các
      // endpoint con. Chỉ các capability quản trị thật (quản vai trò,
      // cấu hình site) hoặc cờ site admin mới mở được khu vực này —
      // API vẫn là nơi thực thi quyền thật ở từng endpoint.
      canAdminister: (access?.isSiteAdmin ?? false) || canManageRoles || sysCaps.includes('site:config'),
      canUseQuestionBank:
        (access?.isSiteAdmin ?? false) ||
        (access?.contexts.some((c) =>
          c.capabilities.some((cap) => (QUESTION_CAPABILITIES as readonly string[]).includes(cap)),
        ) ??
          false),
      courses,
      teaching,
      learning,
      hasLearnerFootprint: learning.length > 0 || (access?.hasLearnerArtifacts ?? false),
    };
  }, [
    user,
    accessSnapshot,
    capabilitiesQuery.isPending,
    capabilitiesQuery.error,
    coursesQuery.isPending,
    courseList,
  ]);

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

/** Đọc ảnh chụp quyền hiện tại; phải dùng bên trong PermissionsProvider. */
export function usePermissions(): PermissionsState {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used inside PermissionsProvider');
  return ctx;
}
